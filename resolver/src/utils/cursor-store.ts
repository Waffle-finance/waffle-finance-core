/**
 * Persistent cursor store for Soroban event-polling loops.
 *
 * Soroban cursors are opaque strings (e.g. "0000000123456789"), not
 * block numbers, so this is a string-specialised sibling of the
 * relayer's numeric CursorStore.  The same safety properties apply:
 *
 * - Each polling label gets its own file so multiple pollers don't
 *   collide.
 * - Writes are done atomically via a temp-file + rename, so a crash
 *   mid-write never leaves a truncated file.
 * - An in-memory cache means repeated `load()` calls pay no I/O cost.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
} from "fs";
import { join } from "path";

export interface SorobanCursorRecord {
  label: string;
  cursor: string;
  updatedAt: number;
}

export interface SorobanCursorStoreOptions {
  /** Directory to store cursor files. Defaults to `<cwd>/.soroban-cursor`. */
  storageDir?: string;
}

export class SorobanCursorStore {
  private readonly storageDir: string;
  /** In-memory cache so repeated loads don't hit disk. */
  private readonly cache = new Map<string, string>();

  constructor(options: SorobanCursorStoreOptions = {}) {
    this.storageDir =
      options.storageDir ?? join(process.cwd(), ".soroban-cursor");
    if (!existsSync(this.storageDir)) {
      mkdirSync(this.storageDir, { recursive: true });
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private filePath(label: string): string {
    // Replace anything that isn't a safe filename character so label
    // values like "soroban:mainnet" don't produce path-separator issues.
    const safe = label.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(this.storageDir, `${safe}.json`);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Persist a cursor token to disk (atomic write via tmp + rename).
   * Also updates the in-memory cache.
   */
  save(label: string, cursor: string): void {
    this.cache.set(label, cursor);
    const fpath = this.filePath(label);
    const tmp = fpath + ".tmp";
    const record: SorobanCursorRecord = {
      label,
      cursor,
      updatedAt: Date.now(),
    };
    writeFileSync(tmp, JSON.stringify(record), "utf-8");
    renameSync(tmp, fpath);
  }

  /**
   * Load a previously-persisted cursor token.
   * Returns `null` if no cursor has been saved for this label.
   */
  load(label: string): string | null {
    const cached = this.cache.get(label);
    if (cached !== undefined) return cached;

    const fpath = this.filePath(label);
    if (!existsSync(fpath)) return null;

    try {
      const raw = readFileSync(fpath, "utf-8");
      const record: SorobanCursorRecord = JSON.parse(raw);
      if (record && typeof record.cursor === "string" && record.cursor !== "") {
        this.cache.set(label, record.cursor);
        return record.cursor;
      }
    } catch {
      // Corrupted or incompatible file — ignore and return null so the
      // caller starts from the current ledger head rather than failing.
    }
    return null;
  }

  /** Drop in-memory cache (does not touch files on disk). */
  clearCache(): void {
    this.cache.clear();
  }
}
