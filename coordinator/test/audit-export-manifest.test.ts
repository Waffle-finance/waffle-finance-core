/**
 * Audit export integrity manifest (issue #1135).
 *
 * Covers empty, paginated and interrupted exports. The manifest is generated
 * only for authorized exports and contains no payload fields or personal
 * identifiers.
 */
import { describe, it, expect } from "vitest";
import { Writable } from "node:stream";
import {
  AuditExporter,
  UnauthorizedExportError,
  createExportManifest,
  verifyExportManifest,
  type ExportManifest,
} from "../src/audit/audit-exporter.js";
import type { AuditRepository, AuditQueryOptions, AuditPage } from "../src/audit/audit-repo.js";
import type { AuditEntry } from "../src/audit/audit-log.js";
import request from "supertest";
import pino from "pino";
import { createApp, type AppDeps } from "../src/server/app.js";

const SECRET = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

function entry(id: number): AuditEntry {
  return {
    id,
    schemaVersion: 1 as AuditEntry["schemaVersion"],
    eventType: "order.announced",
    orderId: `wf_order_${id}`,
    requestId: `req_${id}`,
    payloadJson: JSON.stringify({ preimage: SECRET, note: "customer PII" }),
    createdAt: 1_700_000_000 + id,
  };
}

function repoWith(
  entries: AuditEntry[], failAfter?: number, calls: AuditQueryOptions[] = [],
): AuditRepository {
  const repo = {
    calls,
    async query(opts: AuditQueryOptions = {}): Promise<AuditPage> {
      calls.push(opts);
      const start = opts.cursor ? opts.cursor.afterId : 0;
      const remaining = entries.filter((e) => e.id > start);
      if (failAfter !== undefined && calls.length > failAfter) {
        throw new Error("simulated interrupted export");
      }
      const page = remaining.slice(0, opts.limit ?? 500);
      return {
        entries: page,
        nextCursor: page.length > 0 && remaining.length > page.length
          ? { afterId: page[page.length - 1]!.id }
          : null,
        totalCount: null,
      };
    },
  };
  return repo as unknown as AuditRepository;
}

async function exportNdjson(repo: AuditRepository, pageSize = 2): Promise<string> {
  let output = "";
  const stream = new Writable({
    write(chunk, _encoding, cb) { output += chunk.toString(); cb(); },
  });
  await new AuditExporter(repo).exportNdjson(stream, { pageSize });
  return output;
}

function parseRecords(ndjson: string) {
  return ndjson.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

describe("audit export manifest", () => {
  it("verifies an empty export with a null record range", async () => {
    const ndjson = await exportNdjson(repoWith([]));
    const manifest = createExportManifest(parseRecords(ndjson), { authorized: true });
    expect(manifest.recordRange).toEqual({ firstId: null, lastId: null, count: 0 });
    expect(verifyExportManifest(ndjson, manifest)).toEqual({ ok: true, records: 0 });
  });

  it("verifies a paginated export and reports its covered record range", async () => {
    const calls: AuditQueryOptions[] = [];
    const repo = repoWith([entry(1), entry(2), entry(3), entry(4), entry(5)], undefined, calls);
    const ndjson = await exportNdjson(repo, 2);
    expect(calls.length).toBeGreaterThan(2); // actually paginated
    const manifest = createExportManifest(parseRecords(ndjson), {
      authorized: true, generatedAt: "2026-11-23T00:00:00.000Z",
    });
    expect(manifest.recordRange).toEqual({ firstId: 1, lastId: 5, count: 5 });
    expect(verifyExportManifest(ndjson, manifest).ok).toBe(true);

    // No sensitive payload fields in the manifest itself.
    const manifestJson = JSON.stringify(manifest);
    expect(manifestJson).not.toContain(SECRET);
    expect(manifestJson).not.toContain("customer PII");
    expect(manifestJson).not.toContain("wf_order_");
    expect(manifestJson).not.toContain("req_");
    expect(manifest.generatedAt).toBe("2026-11-23T00:00:00.000Z");
  });

  it("detects a truncated/interrupted export", async () => {
    const full = await exportNdjson(repoWith([entry(1), entry(2), entry(3)]));
    const manifest = createExportManifest(parseRecords(full), { authorized: true });
    const truncated = full.split("\n").slice(0, 2).join("\n") + "\n";
    const result = verifyExportManifest(truncated, manifest);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/digest mismatch|record range mismatch/);
  });

  it("refuses to create a manifest for an unauthorized export", () => {
    expect(() => createExportManifest([entry(1)], { authorized: false }))
      .toThrow(UnauthorizedExportError);
  });

  it("detects tampering with an exported record", () => {
    const ndjson = JSON.stringify({
      id: 1, schemaVersion: 1, eventType: "order.announced", orderId: null,
      requestId: null, createdAt: 1, payload: { status: "announced" },
    }) + "\n";
    const manifest = createExportManifest(parseRecords(ndjson), { authorized: true });
    const tampered = ndjson.replace("announced", "completed");
    expect(verifyExportManifest(tampered, manifest as ExportManifest).ok).toBe(false);
  });
});

describe("audit manifest route authorization", () => {
  it("only generates a manifest for an authorized operator", async () => {
    const original = process.env.COORDINATOR_OPERATOR_KEYS;
    process.env.COORDINATOR_OPERATOR_KEYS = "manifest-operator-key";
    try {
      const app = createApp({
        log: pino({ level: "silent" }),
        corsOrigin: "*",
        auditRepo: repoWith([entry(1), entry(2)]),
      } as AppDeps);
      expect((await request(app).get("/api/audit/export/manifest")).status).toBe(401);
      expect((await request(app).get("/api/audit/export/manifest")
        .set("Authorization", "Bearer wrong-key")).status).toBe(403);
      const ok = await request(app).get("/api/audit/export/manifest")
        .set("Authorization", "Bearer manifest-operator-key");
      expect(ok.status).toBe(200);
      expect(ok.body.recordRange).toEqual({ firstId: 1, lastId: 2, count: 2 });
      expect(JSON.stringify(ok.body)).not.toContain(SECRET);
    } finally {
      if (original === undefined) delete process.env.COORDINATOR_OPERATOR_KEYS;
      else process.env.COORDINATOR_OPERATOR_KEYS = original;
    }
  });
});
