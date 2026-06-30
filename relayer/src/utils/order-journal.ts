/**
 * Lightweight JSON-file journal for the relayer's in-memory activeOrders map.
 *
 * The relayer holds all in-flight swap orders in a `Map<string, any>` that is
 * lost on every process restart. Without persistence the refund-watchdog never
 * sees XLM→ETH orders that were received before the restart, and users may
 * wait for a refund that never comes.
 *
 * This module provides two simple helpers:
 *
 *   persistOrders(activeOrders)  — atomic write of the full map to disk
 *   loadOrders()                 — read it back; returns empty Map on failure
 *
 * The file is written atomically (temp + rename) so a crash mid-write never
 * leaves a corrupted journal. A corrupted or missing file is treated as an
 * empty state (log + return empty Map) so startup is never blocked.
 *
 * Production hardening notes:
 *  - For high-volume deployments replace this with a persistent store
 *    (Redis, SQLite) – the Map-based interface is the same either way.
 *  - Terminal orders (status=completed|refunded|failed) are pruned on every
 *    persist so the file doesn't grow unboundedly.
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const DEFAULT_PATH = join(process.cwd(), '.relayer', 'active-orders.json');

/** Statuses that mean the order is done and can be dropped from the journal. */
const TERMINAL_STATUSES = new Set(['completed', 'refunded', 'failed']);

export interface OrderJournalOptions {
  /** File path. Defaults to `<cwd>/.relayer/active-orders.json`. */
  filePath?: string;
}

export class OrderJournal {
  private readonly filePath: string;

  constructor(options: OrderJournalOptions = {}) {
    this.filePath = options.filePath ?? DEFAULT_PATH;
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * Atomically write the current activeOrders map to disk.
   * Terminal orders are pruned before writing to keep the file small.
   */
  persist(activeOrders: Map<string, any>): void {
    const entries: [string, any][] = [];
    for (const [id, order] of activeOrders.entries()) {
      if (!TERMINAL_STATUSES.has(order?.status)) {
        entries.push([id, order]);
      }
    }

    const tmp = this.filePath + '.tmp';
    writeFileSync(tmp, JSON.stringify({ version: 1, orders: entries }, null, 2), 'utf-8');
    renameSync(tmp, this.filePath);
  }

  /**
   * Load persisted orders back into a Map.
   * Returns an empty Map when no journal exists or the file is corrupt.
   */
  load(): Map<string, any> {
    if (!existsSync(this.filePath)) return new Map();

    try {
      const raw = readFileSync(this.filePath, 'utf-8');
      const data = JSON.parse(raw);
      if (data?.version === 1 && Array.isArray(data.orders)) {
        return new Map<string, any>(data.orders);
      }
    } catch (err: any) {
      console.warn('[order-journal] failed to load journal (treating as empty):', err?.message ?? err);
    }
    return new Map();
  }
}
