/**
 * Persistent cursor store for block-polling loops.
 *
 * Each poller label gets its own file so multiple pollers (e.g. one per
 * contract) don't collide.  Writes are done atomically via a temp file +
 * rename to avoid partial-write corruption.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'fs';
import { join } from 'path';

export interface CursorRecord {
  label: string;
  cursor: number;
  updatedAt: number;
}

export interface CursorStoreOptions {
  /** Directory to store cursor files. Defaults to `<cwd>/.cursor`. */
  storageDir?: string;
}

export class CursorStore {
  private readonly storageDir: string;
  /** In-memory cache so repeated loads don't hit disk. */
  private readonly cache = new Map<string, number>();

  constructor(options: CursorStoreOptions = {}) {
    this.storageDir = options.storageDir ?? join(process.cwd(), '.cursor');
    if (!existsSync(this.storageDir)) {
      mkdirSync(this.storageDir, { recursive: true });
    }
  }

  // -- helpers ----------------------------------------------------------------

  private filePath(label: string): string {
    const safe = label.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(this.storageDir, `${safe}.json`);
  }

  // -- public API ------------------------------------------------------------

  /** Persist a cursor value to disk (atomic write). */
  save(label: string, cursor: number): void {
    this.cache.set(label, cursor);
    const fpath = this.filePath(label);
    const tmp = fpath + '.tmp';
    writeFileSync(tmp, JSON.stringify({ label, cursor, updatedAt: Date.now() } as CursorRecord), 'utf-8');
    renameSync(tmp, fpath);
  }

  /**
   * Load a previously-persisted cursor.
   * Returns `null` if no cursor exists for this label.
   */
  load(label: string): number | null {
    const cached = this.cache.get(label);
    if (cached !== undefined) return cached;

    const fpath = this.filePath(label);
    if (!existsSync(fpath)) return null;

    try {
      const raw = readFileSync(fpath, 'utf-8');
      const record: CursorRecord = JSON.parse(raw);
      if (record && typeof record.cursor === 'number') {
        this.cache.set(label, record.cursor);
        return record.cursor;
      }
    } catch {
      // corrupted file — ignore and return null so the caller starts
      // from the current head rather than failing hard.
    }
    return null;
  }

  /** Drop in-memory cache (does not touch files). */
  clearCache(): void {
    this.cache.clear();
  }
}
