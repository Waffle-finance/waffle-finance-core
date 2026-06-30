/**
 * Lightweight persistent cursor store for the coordinator's event listeners.
 *
 * Each listener gets its own file so multiple pollers don't collide.
 * Writes are atomic (temp-file + rename) so a mid-write crash never leaves
 * a corrupted file.
 *
 * On a read failure (corrupted JSON, missing field) the store returns `null`
 * so the caller falls back to "start from chain head" rather than crashing.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";

export interface CursorRecord {
  label: string;
  cursor: string | number;
  updatedAt: number;
}

export interface CursorStoreOptions {
  /** Directory to store cursor files. Defaults to `<cwd>/.cursor`. */
  storageDir?: string;
}

export class CursorStore {
  private readonly storageDir: string;
  private readonly cache = new Map<string, string | number>();

  constructor(options: CursorStoreOptions = {}) {
    this.storageDir = options.storageDir ?? join(process.cwd(), ".cursor");
    if (!existsSync(this.storageDir)) {
      mkdirSync(this.storageDir, { recursive: true });
    }
  }

  private filePath(label: string): string {
    const safe = label.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(this.storageDir, `${safe}.json`);
  }

  /** Persist a cursor value to disk (atomic write). */
  save(label: string, cursor: string | number): void {
    this.cache.set(label, cursor);
    const fpath = this.filePath(label);
    const tmp = fpath + ".tmp";
    const record: CursorRecord = { label, cursor, updatedAt: Date.now() };
    writeFileSync(tmp, JSON.stringify(record), "utf-8");
    renameSync(tmp, fpath);
  }

  /**
   * Load a previously-persisted cursor.
   * Returns `null` when no cursor exists or the file is corrupt.
   */
  load(label: string): string | number | null {
    const cached = this.cache.get(label);
    if (cached !== undefined) return cached;

    const fpath = this.filePath(label);
    if (!existsSync(fpath)) return null;

    try {
      const raw = readFileSync(fpath, "utf-8");
      const record: CursorRecord = JSON.parse(raw);
      if (record && (typeof record.cursor === "string" || typeof record.cursor === "number")) {
        this.cache.set(label, record.cursor);
        return record.cursor;
      }
    } catch {
      // Corrupted file — fall through to null so caller starts from head.
    }
    return null;
  }

  /** Drop in-memory cache (does not touch files). */
  clearCache(): void {
    this.cache.clear();
  }
}
