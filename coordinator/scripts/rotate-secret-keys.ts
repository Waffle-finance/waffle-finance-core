#!/usr/bin/env tsx
/**
 * Resumable, batched re-encryption of stored coordinator preimages.
 *
 * Active secrets stay readable: the old key remains in the key ring while
 * records are rewritten, and the tool never removes any key. Operators must
 * run this tool to completion (and verify with --dry-run) before retiring an
 * old key from the coordinator's SECRET_STORAGE_PREVIOUS_KEY configuration.
 *
 * Usage:
 *   SECRET_STORAGE_OLD_KEY=<env var name> SECRET_STORAGE_NEW_KEY=<env var name> \
 *   SECRET_STORAGE_NEW_KEY_ID=k-2026-01 DATABASE_URL=postgres://... \
 *   tsx scripts/rotate-secret-keys.ts [--dry-run] [--batch-size 100] \
 *     [--checkpoint ./rotate-state.json]
 *
 * Key values are read from the *named environment variables*; they are never
 * printed, logged, or written to the checkpoint. Checkpoints contain only the
 * last committed row id and the target key id.
 */

import { readFileSync, writeFileSync } from "node:fs";
import pg from "pg";
import {
  deriveKey,
  decryptSecret,
  encryptSecret,
  readKeyId
} from "../src/crypto/secret-cipher.js";

interface Options {
  dryRun: boolean;
  batchSize: number;
  checkpoint?: string;
  databaseUrl: string;
  oldKeys: string[];
  newKey: ReturnType<typeof deriveKey>;
  newKeyId: string;
}

function parseArgs(): Omit<Options, "newKey"> {
  const argv = process.argv.slice(2);
  const value = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i < 0 ? undefined : argv[i + 1];
  };
  return {
    dryRun: argv.includes("--dry-run"),
    batchSize: Number(value("--batch-size") ?? "100"),
    checkpoint: value("--checkpoint"),
    databaseUrl: process.env.DATABASE_URL ?? "",
    oldKeys: (process.env.SECRET_STORAGE_OLD_KEY ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name) => {
        const key = process.env[name];
        if (!key) throw new Error(`Old key environment variable ${name} is not set`);
        return key;
      }),
    newKeyId: process.env.SECRET_STORAGE_NEW_KEY_ID ?? "",
  };
}

function loadCheckpoint(path: string | undefined, keyId: string): number {
  if (!path) return 0;
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as {
      keyId?: string;
      lastId?: number;
    };
    if (state.keyId && state.keyId !== keyId) {
      throw new Error(
        "checkpoint belongs to a different target key id; use a new checkpoint file"
      );
    }
    return Number(state.lastId) || 0;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
}

async function main(): Promise<void> {
  const opts = parseArgs();
  if (!opts.databaseUrl) throw new Error("DATABASE_URL is required");
  if (opts.oldKeys.length === 0) {
    throw new Error("SECRET_STORAGE_OLD_KEY must name at least one env var holding an old key");
  }
  const newKeyVar = process.env.SECRET_STORAGE_NEW_KEY;
  if (!newKeyVar) throw new Error("SECRET_STORAGE_NEW_KEY must name an env var holding the new key");
  const newKeyValue = process.env[newKeyVar];
  if (!newKeyValue) throw new Error(`New key environment variable ${newKeyVar} is not set`);
  if (!opts.newKeyId) throw new Error("SECRET_STORAGE_NEW_KEY_ID is required");
  if (!Number.isInteger(opts.batchSize) || opts.batchSize < 1 || opts.batchSize > 1000) {
    throw new Error("--batch-size must be an integer between 1 and 1000");
  }
  const oldKeys = opts.oldKeys.map(deriveKey);
  const newKey = deriveKey(newKeyValue);
  let lastId = loadCheckpoint(opts.checkpoint, opts.newKeyId);
  let pending = 0;
  let skipped = 0;
  let remaining = 0;
  const client = new pg.Client({ connectionString: opts.databaseUrl });
  await client.connect();
  try {
    for (;;) {
      const result = await client.query<{
        id: number;
        preimage: string;
        key_id: string | null;
      }>(
        `SELECT id, preimage,
                CASE WHEN substr(preimage, 1, 4) = 'Ag' THEN NULL ELSE 'legacy' END AS key_id
           FROM orders
          WHERE preimage IS NOT NULL AND preimage_enc_version = 1 AND id > $1
          ORDER BY id LIMIT $2`,
        [lastId, opts.batchSize]
      );
      const rows = result.rows;
      if (rows.length === 0) break;
      const updates: Array<{ id: number; blob: string }> = [];
      for (const row of rows) {
        lastId = row.id;
        if (readKeyId(row.preimage) === opts.newKeyId) {
          skipped++;
          continue;
        }
        if (opts.dryRun) {
          pending++;
          continue;
        }
        let plaintext: string | undefined;
        for (const key of oldKeys) {
          try {
            plaintext = decryptSecret(row.preimage, key);
            break;
          } catch {
            // Try the next old key.
          }
        }
        if (plaintext === undefined) {
          skipped++;
          continue; // Unreadable with the supplied ring — do not overwrite.
        }
        updates.push({ id: row.id, blob: encryptSecret(plaintext, newKey, opts.newKeyId) });
      }
      if (updates.length > 0) {
        await client.query("BEGIN");
        try {
          for (const update of updates) {
            await client.query(
              "UPDATE orders SET preimage = $1, preimage_enc_version = 1 WHERE id = $2",
              [update.blob, update.id]
            );
          }
          await client.query("COMMIT");
          pending += updates.length;
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        }
      }
      if (opts.checkpoint && !opts.dryRun) {
        writeFileSync(
          opts.checkpoint,
          JSON.stringify({ keyId: opts.newKeyId, lastId }, null, 2)
        );
      }
    }
    const tail = await client.query<{ remaining: string }>(
      `SELECT count(*)::text AS remaining FROM orders
        WHERE preimage IS NOT NULL AND preimage_enc_version = 1 AND id > $1`,
      [lastId]
    );
    remaining = Number(tail.rows[0]?.remaining ?? 0);
  } finally {
    await client.end();
  }
  // Only counts and ids are logged. No key material or ciphertext is printed.
  console.log(
    JSON.stringify({
      mode: opts.dryRun ? "dry-run" : "apply",
      targetKeyId: opts.newKeyId,
      rewritten: opts.dryRun ? 0 : pending,
      wouldRewrite: opts.dryRun ? pending : 0,
      skipped,
      remaining,
      complete: remaining === 0 && skipped === 0
    })
  );
}

main().catch((err: unknown) => {
  console.error(`key rotation failed: ${(err as Error).message}`);
  process.exitCode = 1;
});
