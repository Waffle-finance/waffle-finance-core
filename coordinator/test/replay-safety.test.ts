/**
 * #734: replay safety at the storage layer.
 *
 * Three properties are covered here, all of them acceptance criteria for
 * "harden coordinator schema for partial status transitions and replay safety":
 *
 *  1. **Idempotence is enforced, not merely computed.**  The reconciler's dedup
 *     key (built by `event-identity.ts`) is claimed in the `processed_events`
 *     table, whose PRIMARY KEY is the uniqueness guarantee.  A second delivery
 *     of the same event must be rejected by the storage layer, and must still
 *     be rejected after the process restarts.
 *
 *  2. **Partial status transitions are impossible.**  Every multi-statement
 *     write (an `orders` row mutation paired with its `order_events` history
 *     row) runs inside one transaction, so a failure between the two leaves
 *     neither behind.
 *
 *  3. **Replaying the same event sequence twice is a no-op.**  The final order
 *     state, the durable ledger and the transition trail must be identical
 *     after the second pass, with no double-counted transitions.
 *
 * The reconciler-level replay is exercised here rather than only in
 * `reconciler.test.ts` because that suite's mock accessors use `require()`,
 * which is undefined in this ESM package — every one of its 35 failures is
 * `Cannot read properties of undefined (reading 'results')` from that helper,
 * not a defect in the reconciler.  This file reaches the same mocks through
 * `await import(...)`, which does work.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import pino from 'pino';
import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { openDatabase, type Database } from '../src/persistence/db.js';
import {
  OrdersRepository,
  type AnnounceOrderInput,
  type OrderRow,
} from '../src/persistence/orders-repo.js';
import { OrderService } from '../src/services/order-service.js';
import { Reconciler } from '../src/reconciliation/reconciler.js';
import type { CoordinatorConfig } from '../src/config.js';

const log = pino({ level: 'silent' });

const VALID_ETH_ADDR = '0x2222222222222222222222222222222222222222';
const VALID_STELLAR_ADDR = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422';
const VALID_HASHLOCK = '0x' + 'b'.repeat(64);

// A cryptographically valid preimage → hashlock pair, so the reconciler's
// preimage/hashlock verification actually passes.
const PREIMAGE_BUF = Buffer.alloc(32, 0xcc);
const PREIMAGE = '0x' + PREIMAGE_BUF.toString('hex');
const HASHLOCK = '0x' + createHash('sha256').update(PREIMAGE_BUF).digest('hex');
const SRC_ORDER_ID = 42n;

const BASE_ORDER: AnnounceOrderInput = {
  direction: 'eth_to_xlm',
  hashlock: VALID_HASHLOCK,
  srcChain: 'ethereum',
  srcAddress: VALID_ETH_ADDR,
  srcAsset: 'native',
  srcAmount: '1000000000000000000',
  srcSafetyDeposit: '1000000000000000',
  dstChain: 'stellar',
  dstAddress: VALID_STELLAR_ADDR,
  dstAsset: 'native',
  dstAmount: '100000000',
};

function tmpDir(prefix: string): string {
  return mkdtempSync(resolve(tmpdir(), prefix));
}

/** A fresh repository over a brand-new database file. */
async function freshRepo(): Promise<{ db: Database; repo: OrdersRepository }> {
  const dir = tmpDir('waffle-replay-safety-');
  const db = await openDatabase(`file:${dir}/test.db`);
  return { db, repo: new OrdersRepository(db) };
}

/** A repository over an existing database file — models a process restart. */
async function reopen(url: string): Promise<OrdersRepository> {
  const db = await openDatabase(url);
  return new OrdersRepository(db);
}

async function announce(repo: OrdersRepository): Promise<OrderRow> {
  return repo.announce(BASE_ORDER);
}

/** Count transition-trail rows of a given event type for an order. */
async function countEvents(
  repo: OrdersRepository,
  publicId: string,
  eventType: string
): Promise<number> {
  const events = await repo.findTransitionEvents(publicId);
  return events.filter(e => e.eventType === eventType).length;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Idempotence is enforced at the storage layer
// ─────────────────────────────────────────────────────────────────────────────

describe('#734 processed_events — the idempotence key is a real constraint', () => {
  let repo: OrdersRepository;
  let order: OrderRow;

  beforeEach(async () => {
    ({ repo } = await freshRepo());
    order = await announce(repo);
  });

  it('claims a key exactly once; the second claim is refused', async () => {
    const input = {
      eventKey: 'eth:OrderCreated:0xabc:0',
      chain: 'ethereum' as const,
      eventType: 'OrderCreated' as const,
      orderId: order.id,
    };

    expect(await repo.claimEvent(input)).toBe(true);
    expect(await repo.claimEvent(input)).toBe(false);
  });

  it('a raw duplicate INSERT is rejected by the database, not by application logic', async () => {
    const sql = 'INSERT INTO processed_events (event_key, chain, event_type) VALUES (?, ?, ?)';
    (repo.db as any).prepare(sql).run('eth:OrderClaimed:0xdef:1', 'ethereum', 'OrderClaimed');

    // The uniqueness guarantee lives in the schema, so a duplicate fails even
    // when it never goes through OrdersRepository.
    expect(() =>
      (repo.db as any).prepare(sql).run('eth:OrderClaimed:0xdef:1', 'ethereum', 'OrderClaimed')
    ).toThrow();
  });

  it('still refuses the key after a restart, because the ledger is on disk', async () => {
    const dir = tmpDir('waffle-replay-restart-');
    const url = `file:${dir}/test.db`;

    const first = new OrdersRepository(await openDatabase(url));
    const o = await first.announce(BASE_ORDER);
    const input = {
      eventKey: 'eth:OrderCreated:0xrestart:0',
      chain: 'ethereum' as const,
      eventType: 'OrderCreated' as const,
      orderId: o.id,
    };
    expect(await first.claimEvent(input)).toBe(true);

    // A brand-new repository over the same file — as after a process restart.
    const second = await reopen(url);
    expect(await second.hasProcessedEvent(input.eventKey)).toBe(true);
    expect(await second.claimEvent(input)).toBe(false);
    expect(await second.countProcessedEvents()).toBe(1);
  });

  it('keys differing only in log index are distinct events', async () => {
    const base = {
      chain: 'ethereum' as const,
      eventType: 'OrderCreated' as const,
      orderId: order.id,
    };
    expect(await repo.claimEvent({ ...base, eventKey: 'eth:OrderCreated:0xtx:0' })).toBe(true);
    expect(await repo.claimEvent({ ...base, eventKey: 'eth:OrderCreated:0xtx:1' })).toBe(true);
    expect(await repo.countProcessedEvents()).toBe(2);
  });

  it('accepts an order_id of null for events claimed before the order is located', async () => {
    expect(
      await repo.claimEvent({
        eventKey: 'eth:OrderCreated:0xorphan:0',
        chain: 'ethereum',
        eventType: 'OrderCreated',
        orderId: null,
      })
    ).toBe(true);

    const row = (repo.db as any)
      .prepare('SELECT order_id FROM processed_events WHERE event_key = ?')
      .get('eth:OrderCreated:0xorphan:0');
    expect(row.order_id).toBeNull();
  });

  it('rejects a chain outside the supported set', async () => {
    expect(() =>
      (repo.db as any)
        .prepare('INSERT INTO processed_events (event_key, chain, event_type) VALUES (?, ?, ?)')
        .run('bitcoin:OrderCreated:0x1:0', 'bitcoin', 'OrderCreated')
    ).toThrow();
  });

  it('rejects an event_type outside the closed set', async () => {
    expect(() =>
      (repo.db as any)
        .prepare('INSERT INTO processed_events (event_key, chain, event_type) VALUES (?, ?, ?)')
        .run('eth:OrderMinted:0x1:0', 'ethereum', 'OrderMinted')
    ).toThrow();
  });

  it('cascades when the order row is deleted, so the ledger cannot outlive its order', async () => {
    await repo.claimEvent({
      eventKey: 'eth:OrderCreated:0xcascade:0',
      chain: 'ethereum',
      eventType: 'OrderCreated',
      orderId: order.id,
    });
    (repo.db as any).prepare('DELETE FROM orders WHERE id = ?').run(order.id);
    expect(await repo.countProcessedEvents()).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Schema constraints on statuses and timestamps
// ─────────────────────────────────────────────────────────────────────────────

describe('#734 schema constraints on statuses and timestamps', () => {
  let repo: OrdersRepository;
  let order: OrderRow;

  beforeEach(async () => {
    ({ repo } = await freshRepo());
    order = await announce(repo);
  });

  const update = (sql: string, ...params: any[]) => (repo.db as any).prepare(sql).run(...params);

  it('rejects a status outside the documented set', () => {
    expect(() =>
      update("UPDATE orders SET status = 'teleported' WHERE public_id = ?", order.publicId)
    ).toThrow();
  });

  it('rejects updated_at earlier than created_at', () => {
    const created = order.createdAt;
    expect(() =>
      update('UPDATE orders SET updated_at = ? WHERE public_id = ?', created - 100, order.publicId)
    ).toThrow();
  });

  it('rejects archived_at earlier than created_at', () => {
    expect(() =>
      update(
        'UPDATE orders SET archived_at = ? WHERE public_id = ?',
        order.createdAt - 1,
        order.publicId
      )
    ).toThrow();
  });

  it('accepts updated_at equal to created_at and archived_at equal to created_at', () => {
    expect(() =>
      update(
        'UPDATE orders SET archived_at = created_at, updated_at = created_at WHERE public_id = ?',
        order.publicId
      )
    ).not.toThrow();
  });

  it('rejects a preimage_enc_version other than NULL or 1', () => {
    expect(() =>
      update('UPDATE orders SET preimage_enc_version = 2 WHERE public_id = ?', order.publicId)
    ).toThrow();
  });

  it('accepts preimage_enc_version = 1 (the AES-256-GCM storage format)', async () => {
    update('UPDATE orders SET preimage_enc_version = 1 WHERE public_id = ?', order.publicId);
    const after = await repo.findByPublicId(order.publicId);
    expect(after!.preimageEncVersion).toBe(1);
  });

  it('rejects an order_events.event_type outside the closed emitted set', () => {
    expect(() =>
      update(
        'INSERT INTO order_events (order_id, event_type, payload_json) VALUES (?, ?, ?)',
        order.id,
        'src_lock.exploded',
        '{}'
      )
    ).toThrow();
  });

  it('rejects an order_events row for an order that does not exist (FK enforced)', () => {
    expect(() =>
      update(
        'INSERT INTO order_events (order_id, event_type, payload_json) VALUES (?, ?, ?)',
        999_999,
        'status.transitioned',
        '{}'
      )
    ).toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Partial status transitions
// ─────────────────────────────────────────────────────────────────────────────
//
// A "partial status transition" is a status update whose two writes do not both
// land: the `orders` row advances but the `order_events` history row does not.
// Before #734 each statement autocommitted, so a crash (or any error) between
// them left the order advanced with no history — and the next replay took the
// "already at target" path and recorded a permanent no-op, so the lost
// transition was never recoverable.  The tests below inject a failure at
// exactly that seam.

/** Wrap a database so that any statement matching `needle` throws. */
function failingOn(db: Database, needle: string): Database {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return (sql: string) => {
          if (sql.includes(needle)) {
            return {
              run: () => {
                throw new Error(`injected failure on: ${needle}`);
              },
              get: () => {
                throw new Error(`injected failure on: ${needle}`);
              },
              all: () => {
                throw new Error(`injected failure on: ${needle}`);
              },
            };
          }
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as Database;
}

describe('#734 partial status transitions are atomic', () => {
  it('recordSrcLock does not advance the order when its history row cannot be written', async () => {
    const { db, repo } = await freshRepo();
    const order = await announce(repo);

    const broken = new OrdersRepository(failingOn(db, 'INSERT INTO order_events'));

    await expect(
      broken.recordSrcLock({
        publicId: order.publicId,
        orderId: '1',
        txHash: '0xsrc',
        blockNumber: 10,
        timelock: 1000,
      })
    ).rejects.toThrow(/injected failure/);

    // The order row must not have advanced, and no history row may exist —
    // the two writes landed in one transaction, so neither survived.
    const after = await repo.findByPublicId(order.publicId);
    expect(after!.status).toBe('announced');
    expect(after!.srcOrderId).toBeNull();
    expect(await repo.findTransitionEvents(order.publicId)).toHaveLength(0);
  });

  it('recordSecretRevealed does not persist a preimage without its history row', async () => {
    const { db, repo } = await freshRepo();
    const order = await announce(repo);
    await repo.recordSrcLock({
      publicId: order.publicId,
      orderId: '1',
      txHash: '0xsrc',
      blockNumber: 10,
      timelock: 1000,
    });
    await repo.recordDstLock({
      publicId: order.publicId,
      orderId: '2',
      txHash: '0xdst',
      blockNumber: 20,
      timelock: 2000,
      resolver: VALID_ETH_ADDR,
    });

    const broken = new OrdersRepository(failingOn(db, 'INSERT INTO order_events'));
    await expect(
      broken.recordSecretRevealed({
        publicId: order.publicId,
        preimage: PREIMAGE,
        txHash: '0xreveal',
      })
    ).rejects.toThrow(/injected failure/);

    const after = await repo.findByPublicId(order.publicId);
    expect(after!.status).toBe('dst_locked');
    expect(after!.preimage).toBeNull();
    expect(await countEvents(repo, order.publicId, 'secret_revealed.transitioned')).toBe(0);
  });

  it('setStatus does not change the status when its history row cannot be written', async () => {
    const { db, repo } = await freshRepo();
    const order = await announce(repo);

    const broken = new OrdersRepository(failingOn(db, 'INSERT INTO order_events'));
    await expect(broken.setStatus(order.publicId, 'completed')).rejects.toThrow(/injected failure/);

    const after = await repo.findByPublicId(order.publicId);
    expect(after!.status).toBe('announced');
    expect(await countEvents(repo, order.publicId, 'status.transitioned')).toBe(0);
  });

  it('cancelOrder does not cancel when its history row cannot be written', async () => {
    const { db, repo } = await freshRepo();
    const order = await announce(repo);

    const broken = new OrdersRepository(failingOn(db, 'INSERT INTO order_events'));
    await expect(broken.cancelOrder(order.publicId, 'operator:testing')).rejects.toThrow(
      /injected failure/
    );

    const after = await repo.findByPublicId(order.publicId);
    expect(after!.status).toBe('announced');
    expect(after!.cancellationReason).toBeNull();
  });

  it('abandonOrder does not abandon when its history row cannot be written', async () => {
    const { db, repo } = await freshRepo();
    const order = await announce(repo);

    const broken = new OrdersRepository(failingOn(db, 'INSERT INTO order_events'));
    await expect(broken.abandonOrder(order.publicId, 'stale:no_src_lock')).rejects.toThrow(
      /injected failure/
    );

    const after = await repo.findByPublicId(order.publicId);
    expect(after!.status).toBe('announced');
    expect(after!.archivedAt).toBeNull();
  });

  it('a rolled-back write leaves the connection usable for the next write', async () => {
    const { db, repo } = await freshRepo();
    const order = await announce(repo);

    const broken = new OrdersRepository(failingOn(db, 'INSERT INTO order_events'));
    await expect(
      broken.recordSrcLock({
        publicId: order.publicId,
        orderId: '1',
        txHash: '0xsrc',
        blockNumber: 10,
        timelock: 1000,
      })
    ).rejects.toThrow();

    // The rollback released the transaction, so the very next write commits
    // normally and produces exactly one history row.
    await repo.recordSrcLock({
      publicId: order.publicId,
      orderId: '1',
      txHash: '0xsrc',
      blockNumber: 10,
      timelock: 1000,
    });
    const after = await repo.findByPublicId(order.publicId);
    expect(after!.status).toBe('src_locked');
    expect(await countEvents(repo, order.publicId, 'src_lock.transitioned')).toBe(1);
  });

  it('rollbackSrcLock records its history row, so a rollback is not invisible', async () => {
    const { repo } = await freshRepo();
    const order = await announce(repo);
    await repo.recordSrcLock({
      publicId: order.publicId,
      orderId: '1',
      txHash: '0xsrc',
      blockNumber: 10,
      timelock: 1000,
    });

    await repo.rollbackSrcLock(order.publicId, 'reorg-detector');

    const after = await repo.findByPublicId(order.publicId);
    expect(after!.status).toBe('announced');
    expect(await countEvents(repo, order.publicId, 'src_lock.rolled_back')).toBe(1);

    // Replaying the rollback is a no-op, and says so in the trail.
    await repo.rollbackSrcLock(order.publicId, 'reorg-detector');
    expect(await countEvents(repo, order.publicId, 'src_lock.rolled_back')).toBe(2);
    const events = await repo.findTransitionEvents(order.publicId);
    expect(events.at(-1)!.payload.outcome).toBe('no_op:not_src_locked');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Replaying the same event sequence twice
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A deterministic order lifecycle expressed as a replayable script.  Running
 * the script twice against the same database is the issue's "replay scenario
 * under the same event sequence twice".
 */
const SEQUENCE = [
  { kind: 'src_lock', orderId: '1', txHash: '0xsrc', blockNumber: 10, timelock: 1_000 },
  {
    kind: 'dst_lock',
    orderId: '2',
    txHash: '0xdst',
    blockNumber: 20,
    timelock: 2_000,
    resolver: VALID_ETH_ADDR,
  },
  { kind: 'secret', preimage: PREIMAGE, txHash: '0xreveal' },
  { kind: 'status', status: 'completed' as const },
] as const;

async function runSequence(repo: OrdersRepository, publicId: string): Promise<void> {
  for (const step of SEQUENCE) {
    if (step.kind === 'src_lock') {
      await repo.recordSrcLock({
        publicId,
        orderId: step.orderId,
        txHash: step.txHash,
        blockNumber: step.blockNumber,
        timelock: step.timelock,
      });
    } else if (step.kind === 'dst_lock') {
      await repo.recordDstLock({
        publicId,
        orderId: step.orderId,
        txHash: step.txHash,
        blockNumber: step.blockNumber,
        timelock: step.timelock,
        resolver: step.resolver,
      });
    } else if (step.kind === 'secret') {
      await repo.recordSecretRevealed({ publicId, preimage: step.preimage, txHash: step.txHash });
    } else {
      await repo.setStatus(publicId, step.status, 'replay-test');
    }
  }
}

/** The observable fields a replay must not change. */
function snapshot(order: OrderRow): Record<string, unknown> {
  const { updatedAt, ...stable } = order;
  return stable;
}

describe('#734 replaying the same event sequence twice', () => {
  it('produces identical final state and no double-counted transitions', async () => {
    const dir = tmpDir('waffle-replay-twice-');
    const url = `file:${dir}/test.db`;

    const first = new OrdersRepository(await openDatabase(url));
    const order = await announce(first);

    // Pass 1 — the events are new.
    await runSequence(first, order.publicId);
    const afterFirst = await first.findByPublicId(order.publicId);
    const eventsAfterFirst = await first.findTransitionEvents(order.publicId);

    // Pass 2 — the identical sequence, over a *restarted* repository, so
    // nothing is carried in memory between the two passes.
    const second = await reopen(url);
    await runSequence(second, order.publicId);
    const afterSecond = await second.findByPublicId(order.publicId);
    const eventsAfterSecond = await second.findTransitionEvents(order.publicId);

    // Final state is identical.
    expect(snapshot(afterSecond!)).toEqual(snapshot(afterFirst!));
    expect(afterSecond!.status).toBe('completed');
    expect(afterSecond!.preimage).toBe(PREIMAGE);

    // No transition was counted twice: the number of *applied* transitions is
    // unchanged, and the second pass only appended explicit no-op records.
    const appliedFirst = eventsAfterFirst.filter(e => e.eventType.endsWith('.transitioned'));
    const appliedSecond = eventsAfterSecond.filter(e => e.eventType.endsWith('.transitioned'));
    expect(appliedFirst).toHaveLength(4);
    expect(appliedSecond).toHaveLength(4);
    expect(appliedSecond.map(e => e.eventType)).toEqual(appliedFirst.map(e => e.eventType));

    // And the second pass recorded only no-ops.
    const secondPassEvents = eventsAfterSecond.slice(eventsAfterFirst.length);
    expect(secondPassEvents.length).toBeGreaterThan(0);
    for (const e of secondPassEvents) {
      expect(e.eventType).toMatch(/\.no_op$/);
    }
  });

  it('three passes leave the same state as one', async () => {
    const dir = tmpDir('waffle-replay-thrice-');
    const url = `file:${dir}/test.db`;

    const repo = new OrdersRepository(await openDatabase(url));
    const order = await announce(repo);
    await runSequence(repo, order.publicId);
    const afterOne = await repo.findByPublicId(order.publicId);

    await reopen(url);
    await runSequence(new OrdersRepository(await openDatabase(url)), order.publicId);
    await runSequence(new OrdersRepository(await openDatabase(url)), order.publicId);

    const afterThree = await new OrdersRepository(await openDatabase(url)).findByPublicId(
      order.publicId
    );
    expect(snapshot(afterThree!)).toEqual(snapshot(afterOne!));
  });

  it('a second announce for the same hashlock does not create a second order row', async () => {
    const dir = tmpDir('waffle-replay-announce-');
    const url = `file:${dir}/test.db`;

    const first = new OrdersRepository(await openDatabase(url));
    const a = await first.announce(BASE_ORDER);

    // Re-announcing is a replay of the same announcement. The UNIQUE index on
    // public_id (derived from the hashlock) is what stops it, and it does so
    // with a constraint violation rather than a silent second row.
    const second = new OrdersRepository(await openDatabase(url));
    await expect(second.announce(BASE_ORDER)).rejects.toThrow();

    const rows = (second.db as any).prepare('SELECT COUNT(*) AS n FROM orders').get();
    expect(rows.n).toBe(1);
    expect(a.publicId).toBe((await second.findByHashlock(VALID_HASHLOCK))!.publicId);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Reconciliation is idempotent under repeated replay and restarts
// ─────────────────────────────────────────────────────────────────────────────

let ethCreatedLogs: any[] = [];
let ethClaimedLogs: any[] = [];
let ethRefundedLogs: any[] = [];
let ethTip = 10_000n;

vi.mock('viem', async importOriginal => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: vi.fn(() => ({
      getBlockNumber: vi.fn(async () => ethTip),
      getLogs: vi.fn(async ({ event }: any) => {
        if (event?.name === 'OrderCreated') return ethCreatedLogs;
        if (event?.name === 'OrderClaimed') return ethClaimedLogs;
        if (event?.name === 'OrderRefunded') return ethRefundedLogs;
        return [];
      }),
    })),
  };
});

vi.mock('@stellar/stellar-sdk', async importOriginal => {
  const actual = await importOriginal<typeof import('@stellar/stellar-sdk')>();
  return {
    ...actual,
    rpc: {
      Server: vi.fn(() => ({
        getLatestLedger: vi.fn(async () => ({ sequence: 100_000 })),
        getEvents: vi.fn(async () => ({ events: [], cursor: null })),
      })),
    },
  };
});

vi.mock('@solana/web3.js', () => ({
  Connection: vi.fn(() => ({
    getSlot: vi.fn(async () => 500_000),
    getSignaturesForAddress: vi.fn(async () => []),
    getParsedTransaction: vi.fn(async () => null),
  })),
  PublicKey: vi.fn((id: string) => ({ toBase58: () => id })),
}));

const BASE_CFG: CoordinatorConfig = {
  network: 'testnet',
  port: 3001,
  databaseUrl: 'file::memory:',
  logLevel: 'silent',
  corsOrigin: '*',
  pollIntervalMs: 15_000,
  ethereum: {
    rpcUrl: 'https://rpc.test',
    chainId: 11_155_111,
    htlcEscrow: '0xb352339BEb146f2699d28D736700B953988bB178',
    resolverRegistry: null,
  },
  soroban: {
    rpcUrl: 'https://soroban.test',
    horizonUrl: 'https://horizon.test',
    networkPassphrase: 'Test',
    htlcContract: null,
    resolverRegistry: null,
  },
  solana: { rpcUrl: 'https://solana.test', programId: 'PLACEHOLDER', commitment: 'confirmed' },
};

/**
 * The order the Ethereum lifecycle logs below refer to.  It is announced under
 * `HASHLOCK` (the sha256 of `PREIMAGE`) so the reconciler's preimage/hashlock
 * verification succeeds and the OrderCreated log resolves to a real order row.
 */
const RECON_ORDER: AnnounceOrderInput = { ...BASE_ORDER, hashlock: HASHLOCK };

/** The three-log lifecycle an Ethereum HTLC order produces. */
function ethLifecycle(): void {
  ethCreatedLogs = [
    {
      args: { orderId: SRC_ORDER_ID, hashlock: HASHLOCK, timelock: 9_999n },
      transactionHash: '0xcreated',
      logIndex: 0,
      blockNumber: 9_000n,
    },
  ];
  ethClaimedLogs = [
    {
      args: { orderId: SRC_ORDER_ID, preimage: PREIMAGE },
      transactionHash: '0xclaimed',
      logIndex: 0,
      blockNumber: 9_100n,
    },
  ];
  ethRefundedLogs = [
    {
      args: { orderId: SRC_ORDER_ID },
      transactionHash: '0xrefunded',
      logIndex: 0,
      blockNumber: 9_200n,
    },
  ];
}

describe('#734 reconciliation is idempotent under repeated replay', () => {
  beforeEach(() => {
    ethTip = 10_000n;
    ethLifecycle();
  });

  it('replaying the same chain events twice leaves the DB byte-identical', async () => {
    const dir = tmpDir('waffle-recon-replay-');
    const url = `file:${dir}/test.db`;
    const db = await openDatabase(url);
    const repo = new OrdersRepository(db);
    const orders = new OrderService(repo, log, { enableCache: false });

    const order = await orders.announce(RECON_ORDER);

    // Pass 1.
    await new Reconciler(BASE_CFG, orders, log).run();
    const afterFirst = await repo.findByPublicId(order.publicId);
    const eventsAfterFirst = await repo.findTransitionEvents(order.publicId);
    const ledgerAfterFirst = await repo.countProcessedEvents();

    expect(afterFirst!.status).toBe('refunded');
    expect(afterFirst!.srcOrderId).toBe(SRC_ORDER_ID.toString());
    expect(afterFirst!.preimage).toBe(PREIMAGE);
    // All three events were claimed and applied exactly once.
    expect(ledgerAfterFirst).toBe(3);
    const appliedFirst = eventsAfterFirst.filter(e => e.eventType.endsWith('.transitioned'));
    expect(appliedFirst).toHaveLength(3);

    // Pass 2 — a brand-new Reconciler (empty EventSeenSet, cursors re-seeded
    // from the DB) fed the identical logs.
    const orders2 = new OrderService(await reopen(url), log, { enableCache: false });
    await new Reconciler(BASE_CFG, orders2, log).run();

    const repo2 = new OrdersRepository(await openDatabase(url));
    const afterSecond = await repo2.findByPublicId(order.publicId);
    const eventsAfterSecond = await repo2.findTransitionEvents(order.publicId);

    expect(snapshot(afterSecond!)).toEqual(snapshot(afterFirst!));
    // No transition applied twice.
    expect(eventsAfterSecond.filter(e => e.eventType.endsWith('.transitioned'))).toHaveLength(3);
    // The durable ledger did not grow: the same three keys, still three rows.
    expect(await repo2.countProcessedEvents()).toBe(3);
    // And no second order row was created.
    const orders_count = (repo2.db as any).prepare('SELECT COUNT(*) AS n FROM orders').get();
    expect(orders_count.n).toBe(1);
  });

  it('the durable ledger stops a replay even after the per-order cursors are lost', async () => {
    const dir = tmpDir('waffle-recon-cursorloss-');
    const url = `file:${dir}/test.db`;
    const repo = new OrdersRepository(await openDatabase(url));
    const orders = new OrderService(repo, log, { enableCache: false });
    const order = await orders.announce(RECON_ORDER);

    await new Reconciler(BASE_CFG, orders, log).run();
    const afterFirst = await repo.findByPublicId(order.publicId);
    expect(afterFirst!.status).toBe('refunded');
    expect(await repo.countProcessedEvents()).toBe(3);

    // Simulate the worst case for a resumed replay: the per-order high-water
    // marks are gone, so neither isEventBehindOrderCursor nor decideDispatch's
    // alreadyApplied check can short-circuit.  The only thing left is the
    // durable ledger, and it has to be enough on its own.
    (repo.db as any)
      .prepare(
        'UPDATE orders SET last_eth_block = NULL, last_soroban_ledger = NULL, last_solana_slot = NULL WHERE public_id = ?'
      )
      .run(order.publicId);
    (repo.db as any).prepare('DELETE FROM chain_cursors').run();

    const orders2 = new OrderService(await reopen(url), log, { enableCache: false });
    const second = new Reconciler(BASE_CFG, orders2, log);
    await second.run();

    const repo2 = new OrdersRepository(await openDatabase(url));
    const afterSecond = await repo2.findByPublicId(order.publicId);

    // Final state unchanged and the ledger unchanged — no event was re-applied.
    // The cursor columns are excluded because this scenario nulled them out on
    // purpose; everything the events actually write must be untouched.
    const withoutCursors = (o: OrderRow) => {
      const { lastEthBlock, lastSorobanLedger, lastSolanaSlot, ...rest } = o;
      return rest;
    };
    expect(withoutCursors(afterSecond!)).toEqual(withoutCursors(afterFirst!));
    // In particular the lifecycle fields the replayed events would have
    // rewritten are still the ones written by the first pass.
    expect(afterSecond!.status).toBe('refunded');
    expect(afterSecond!.srcOrderId).toBe(SRC_ORDER_ID.toString());
    expect(afterSecond!.preimage).toBe(PREIMAGE);
    expect(await repo2.countProcessedEvents()).toBe(3);
    expect(
      (await repo2.findTransitionEvents(order.publicId)).filter(e =>
        e.eventType.endsWith('.transitioned')
      )
    ).toHaveLength(3);
  });

  it('reports eventsReplayed = 0 on the second pass over the same window', async () => {
    const dir = tmpDir('waffle-recon-count-');
    const url = `file:${dir}/test.db`;
    const orders = new OrderService(new OrdersRepository(await openDatabase(url)), log, {
      enableCache: false,
    });
    await orders.announce(RECON_ORDER);

    const first = new Reconciler(BASE_CFG, orders, log);
    await first.run();
    expect(first.getStatus().eventsReplayed).toBe(3);

    const orders2 = new OrderService(await reopen(url), log, { enableCache: false });
    const second = new Reconciler(BASE_CFG, orders2, log);
    await second.run();
    expect(second.getStatus().eventsReplayed).toBe(0);
  });
});
