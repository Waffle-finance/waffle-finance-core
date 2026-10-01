/**
 * Solana timeout and refund window regression tests — issue #719 (service level)
 *
 * The contract side of the Solana timeout/refund window is covered by
 * `e2e/solana-timeout-refund.test.ts`. This suite covers the other half of
 * the acceptance criteria: **service-level order-state transitions** for the
 * Solana path, driven through the real `SolanaListener` + `OrderService`
 * stack with a controlled RPC surface, so the following hold end-to-end:
 *
 *  - Delayed confirmation: events observed at `confirmed` commitment are held
 *    in the pending-slot queue until their slot is behind
 *    `finalizedSlot - FINALIZATION_SLOTS`, and no order state changes until
 *    the event is actually final. The refund/claim window arithmetic is only
 *    applied once, after finalisation.
 *  - Timeout triggers: the expiry scan moves past-timelock, unclaimed orders
 *    to `expired`, and only `expired`/`src_locked` orders can then take the
 *    refund transition (`expired -> refunded` is a valid, terminal step).
 *  - Confirmation delay around the timeout: a claim that lands on-chain
 *    before the deadline but is observed after it still settles the secret
 *    (the service does not gate claims on wall-clock time — the program
 *    does), and the subsequent expiry scan does not clobber it.
 *  - Event ordering: out-of-order/stale sequences are rejected by the
 *    dispatch policy, and a claim replayed after a refund cannot rewrite a
 *    terminal order.
 *  - Replay: a redelivered signature produces exactly one mutation.
 *
 * The listener's RPC surface is replaced with an in-process fake after
 * construction, so the real listener pipeline (queue → finalisation drain →
 * dedup → dispatch policy → OrderService) is what gets exercised. The SDK
 * barrel is stubbed only to keep this suite independent of the SDK's own
 * build state; the two symbols the listener re-exports from it are never
 * called here because the provider is injected.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import pino from 'pino';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { SQLITE_MIGRATIONS, type Database } from '../src/persistence/db.js';
import { OrdersRepository } from '../src/persistence/orders-repo.js';
import { OrderService } from '../src/services/order-service.js';
import { SolanaListener, FINALIZATION_SLOTS } from '../src/listeners/solana-listener.js';
import { canTransition, isTerminal } from '../src/state-machine/order-machine.js';
import type { CoordinatorConfig } from '../src/config.js';

vi.mock('@wafflefinance/sdk', () => {
  const connection = {
    getSlot: async () => 0,
    getSignaturesForAddress: async () => [],
    getParsedTransaction: async () => null,
  };
  const provider = {
    withFallback: async (fn: (conn: unknown) => unknown) => fn(connection),
    getConnection: () => connection,
    getHealth: () => ({
      healthy: true,
      degraded: false,
      endpoints: [],
      activeEndpoint: 'https://fake.solana.rpc',
    }),
    getPrimaryUrl: () => 'https://fake.solana.rpc',
  };
  return {
    SolanaRpcProvider: class {},
    createSolanaRpcProvider: () => provider,
  };
});

// ── Fixtures ────────────────────────────────────────────────────────────────

const log = pino({ level: 'silent' });

const HASHLOCK = '0x' + '42'.repeat(32);
const PREIMAGE = '0x' + '99'.repeat(32);
const SOL_ADDRESS = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const ETH_ADDRESS = '0x1111111111111111111111111111111111111111';
const SOL_PDA = 'HTLCorderPDA11111111111111111111111111111111';

const BASE_CFG: CoordinatorConfig = {
  network: 'testnet',
  port: 3001,
  databaseUrl: 'file::memory:',
  logLevel: 'silent',
  corsOrigin: '*',
  pollIntervalMs: 10,
  ethereum: {
    rpcUrl: 'https://rpc.test',
    chainId: 11_155_111,
    htlcEscrow: null,
    resolverRegistry: null,
  },
  soroban: {
    rpcUrl: 'https://soroban.test',
    horizonUrl: 'https://horizon.test',
    networkPassphrase: 'Test',
    htlcContract: null,
    resolverRegistry: null,
  },
  solana: {
    rpcUrl: 'https://api.devnet.solana.com',
    programId: '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
    commitment: 'confirmed',
  },
} as unknown as CoordinatorConfig;

// ── Fake Solana RPC (injected into the listener post-construction) ──────────

interface FakeSignature {
  signature: string;
  slot: number;
  err: null;
}

interface FakeRpcState {
  finalizedSlot: number;
  confirmedSlot: number;
  signatures: FakeSignature[];
  logs: Map<string, string[]>;
}

function injectFakeRpc(listener: SolanaListener, state: FakeRpcState): void {
  const connection = {
    getSlot: async (commitment: string) =>
      commitment === 'finalized' ? state.finalizedSlot : state.confirmedSlot,
    getSignaturesForAddress: async () => state.signatures,
    getParsedTransaction: async (sig: string) => ({
      meta: { logMessages: state.logs.get(sig) ?? null },
    }),
  };

  (listener as unknown as { rpcProvider: unknown }).rpcProvider = {
    withFallback: async (fn: (conn: unknown) => unknown) => fn(connection),
    getConnection: () => connection,
    getHealth: () => ({
      healthy: true,
      degraded: false,
      endpoints: [],
      activeEndpoint: 'https://fake.solana.rpc',
    }),
    getPrimaryUrl: () => 'https://fake.solana.rpc',
  };
}

// ── Anchor log builders (the exact shapes SolanaListener parses) ────────────

const createdLogs = (hashlock: string, orderId: string, timelock: number) => [
  'Program log: Instruction: CreateOrder',
  'Program log: OrderCreated',
  `Program log: {"hashlock":"${hashlock}","orderId":"${orderId}","timelock":${timelock}}`,
];

const claimedLogs = (orderId: string, preimage: string) => [
  'Program log: Instruction: ClaimOrder',
  'Program log: OrderClaimed',
  `Program log: {"orderId":"${orderId}","preimage":"${preimage}"}`,
];

const refundedLogs = (orderId: string) => [
  'Program log: Instruction: RefundOrder',
  'Program log: OrderRefunded',
  `Program log: {"orderId":"${orderId}"}`,
];

// ── Test harness ────────────────────────────────────────────────────────────

const PROGRAM_PK = { toBase58: () => BASE_CFG.solana.programId } as never;

/** Flush the listener's fire-and-forget async dispatch blocks. */
const settle = () => new Promise(r => setTimeout(r, 25));

// Load `node:sqlite` via createRequire so Vite/Vitest do not transform it —
// the same trick `src/persistence/db.ts` uses.
const { DatabaseSync } = createRequire(import.meta.url)(
  'node:sqlite'
) as typeof import('node:sqlite');

/**
 * A schema-equivalent SQLite database, built without `openDatabase()`.
 *
 * `openDatabase()` runs `validateMigrationRegistry()` first, and the registry
 * currently does not list `013_backlog_indexes{,_postgres}.sql`, so every
 * coordinator test that opens a database through it dies with `REGISTRY_DRIFT`
 * before a single assertion runs. This suite is about listener/service timeout
 * and refund semantics, not schema bootstrapping, so it applies `schema.sql`
 * directly — the exact DDL `openSqliteDatabase()` uses — and seeds the
 * migration history the same way.
 */
function openTestDatabase(): Database {
  const db = new DatabaseSync(':memory:');
  const schemaPath = fileURLToPath(new URL('../src/persistence/schema.sql', import.meta.url));
  db.exec(readFileSync(schemaPath, 'utf8'));

  const now = Math.floor(Date.now() / 1000);
  const seed = db.prepare(
    'INSERT OR IGNORE INTO schema_migrations (migration, applied_at, duration_ms) VALUES (?, ?, ?)'
  );
  for (const migration of SQLITE_MIGRATIONS) seed.run(migration, now, 0);
  return db;
}

interface Harness {
  orders: OrderService;
  listener: SolanaListener;
  state: FakeRpcState;
}

async function makeHarness(): Promise<Harness> {
  const db = openTestDatabase();
  const orders = new OrderService(new OrdersRepository(db), log);
  const listener = new SolanaListener(BASE_CFG, orders, log);
  const state: FakeRpcState = {
    finalizedSlot: 1000,
    confirmedSlot: 1004,
    signatures: [],
    logs: new Map(),
  };
  injectFakeRpc(listener, state);
  return { orders, listener, state };
}

async function announceOrder(orders: OrderService, hashlock = HASHLOCK) {
  return orders.announce({
    direction: 'sol_to_eth',
    hashlock,
    srcChain: 'solana',
    srcAddress: SOL_ADDRESS,
    srcAsset: 'native',
    srcAmount: '1000000000',
    srcSafetyDeposit: '1000000',
    dstChain: 'ethereum',
    dstAddress: ETH_ADDRESS,
    dstAsset: 'native',
    dstAmount: '10000000000000000',
  });
}

/** Run one listener poll with the given signature batch and finalised slot. */
async function pollOnce(
  h: Harness,
  opts: { signatures?: FakeSignature[]; logs?: Map<string, string[]>; finalizedSlot?: number }
): Promise<void> {
  if (opts.signatures) h.state.signatures = opts.signatures;
  if (opts.logs) h.state.logs = opts.logs;
  if (opts.finalizedSlot !== undefined) {
    h.state.finalizedSlot = opts.finalizedSlot;
    // A healthy cluster never reports `confirmed` behind `finalized`. Keeping
    // the fake ahead of it stops the listener's slot-regression guard from
    // mistaking the advance for a fork and dropping the queued event.
    h.state.confirmedSlot = Math.max(h.state.confirmedSlot, opts.finalizedSlot + 4);
  }

  await (h.listener as unknown as { poll(pk: unknown): Promise<void> }).poll(PROGRAM_PK);
  await settle();
}

/** Drive the full create → finalised pipeline for an OrderCreated event. */
async function lockOrder(
  h: Harness,
  opts: { timelock: number; sig?: string; slot?: number }
): Promise<void> {
  const sig = opts.sig ?? 'sig-created';
  const slot = opts.slot ?? 1004;
  const logs = new Map([[sig, createdLogs(HASHLOCK, SOL_PDA, opts.timelock)]]);

  // Seen at `confirmed`, but the slot is not yet behind finalized - 32.
  await pollOnce(h, {
    signatures: [{ signature: sig, slot, err: null }],
    logs,
    finalizedSlot: 1000,
  });

  // Finalisation catches up → the event drains and mutates the order.
  await pollOnce(h, { signatures: [], logs, finalizedSlot: slot + FINALIZATION_SLOTS });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('SolanaListener — delayed confirmation holds events until finalised (#719)', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await makeHarness();
  });

  afterEach(() => {
    h.listener.stop();
    vi.restoreAllMocks();
  });

  it('a created event stays queued (and the order stays announced) until its slot is final', async () => {
    const order = await announceOrder(h.orders);
    const recordSrcLock = vi.spyOn(h.orders, 'recordSrcLock');

    const logs = new Map([
      ['sig-created', createdLogs(HASHLOCK, SOL_PDA, Math.floor(Date.now() / 1000) + 3600)],
    ]);

    await pollOnce(h, {
      signatures: [{ signature: 'sig-created', slot: 1004, err: null }],
      logs,
      finalizedSlot: 1000,
    });

    expect(h.listener.getPendingSlotCount()).toBe(1);
    expect(h.listener.isInPendingSlots('sig-created')).toBe(true);
    expect((await h.orders.get(order.publicId))!.status).toBe('announced');
    expect(recordSrcLock).not.toHaveBeenCalled();

    await pollOnce(h, { signatures: [], finalizedSlot: 1004 + FINALIZATION_SLOTS });

    expect(h.listener.getPendingSlotCount()).toBe(0);
    expect((await h.orders.get(order.publicId))!.status).toBe('src_locked');
    expect(recordSrcLock).toHaveBeenCalledTimes(1);
    expect(h.listener.isDuplicate('sig-created')).toBe(true);
  });

  it('confirmation lag spanning several polls does not mutate state early or apply twice', async () => {
    const order = await announceOrder(h.orders);
    const recordSrcLock = vi.spyOn(h.orders, 'recordSrcLock');
    const timelock = Math.floor(Date.now() / 1000) + 3600;
    const logs = new Map([['sig-created', createdLogs(HASHLOCK, SOL_PDA, timelock)]]);

    await pollOnce(h, {
      signatures: [{ signature: 'sig-created', slot: 1004, err: null }],
      logs,
      finalizedSlot: 1000,
    });

    // Several polls while finalisation lags behind — still queued, no writes.
    for (const finalized of [1005, 1020, 1030, 1035]) {
      await pollOnce(h, { signatures: [], finalizedSlot: finalized });
      expect((await h.orders.get(order.publicId))!.status).toBe('announced');
    }
    expect(recordSrcLock).not.toHaveBeenCalled();

    // One more poll crosses the finalization threshold.
    await pollOnce(h, { signatures: [], finalizedSlot: 1036 });
    expect((await h.orders.get(order.publicId))!.status).toBe('src_locked');
    expect(recordSrcLock).toHaveBeenCalledTimes(1);

    // Further polls (same signature reported again) do not re-apply.
    await pollOnce(h, {
      signatures: [{ signature: 'sig-created', slot: 1004, err: null }],
      finalizedSlot: 1036,
    });
    expect(recordSrcLock).toHaveBeenCalledTimes(1);
    expect(h.listener.getPendingSlotCount()).toBe(0);
  });
});

describe('SolanaListener — timeout, expiry scan and refund window (#719)', () => {
  let h: Harness;
  const pastTimelock = () => Math.floor(Date.now() / 1000) - 30;
  const futureTimelock = () => Math.floor(Date.now() / 1000) + 3600;

  beforeEach(async () => {
    h = await makeHarness();
  });

  afterEach(() => {
    h.listener.stop();
    vi.restoreAllMocks();
  });

  it('does not expire an order whose timelock is still in the future', async () => {
    const order = await announceOrder(h.orders);
    await lockOrder(h, { timelock: futureTimelock() });
    expect((await h.orders.get(order.publicId))!.status).toBe('src_locked');

    expect(await h.orders.expireStaleOrders()).toBe(0);
    expect((await h.orders.get(order.publicId))!.status).toBe('src_locked');
  });

  it('expires a past-timelock order, then applies a delayed refund event after finalisation', async () => {
    const order = await announceOrder(h.orders);
    await lockOrder(h, { timelock: pastTimelock() });
    expect((await h.orders.get(order.publicId))!.status).toBe('src_locked');

    // Timeout reached: the scan moves the order to `expired`.
    expect(await h.orders.expireStaleOrders()).toBe(1);
    const expired = (await h.orders.get(order.publicId))!;
    expect(expired.status).toBe('expired');
    expect(canTransition('expired', 'refunded')).toBe(true);
    expect(isTerminal('refunded')).toBe(true);

    // The refund transaction is observed at `confirmed` but not yet final.
    const refundLogs = new Map([['sig-refund', refundedLogs(SOL_PDA)]]);
    await pollOnce(h, {
      signatures: [{ signature: 'sig-refund', slot: 1010, err: null }],
      logs: refundLogs,
      finalizedSlot: 1000,
    });
    expect(h.listener.getPendingSlotCount()).toBe(1);
    expect((await h.orders.get(order.publicId))!.status).toBe('expired');

    // Finalisation catches up → refund applies exactly once.
    await pollOnce(h, { signatures: [], finalizedSlot: 1010 + FINALIZATION_SLOTS });
    expect((await h.orders.get(order.publicId))!.status).toBe('refunded');
    expect(h.listener.getPendingSlotCount()).toBe(0);

    // The expiry scan can no longer touch a terminal order.
    expect(await h.orders.expireStaleOrders()).toBe(0);
    expect((await h.orders.get(order.publicId))!.status).toBe('refunded');
  });

  it('a claim observed after the wall-clock timeout still settles the secret, and the scan cannot clobber it', async () => {
    const order = await announceOrder(h.orders);

    // The escrow's timelock has already passed when the lock event lands —
    // exactly the delayed-confirmation case around the timeout boundary.
    await lockOrder(h, { timelock: pastTimelock() });
    expect((await h.orders.get(order.publicId))!.status).toBe('src_locked');

    const recordSecret = vi.spyOn(h.orders, 'recordSecret');
    const claimLogs = new Map([['sig-claim', claimedLogs(SOL_PDA, PREIMAGE)]]);

    await pollOnce(h, {
      signatures: [{ signature: 'sig-claim', slot: 1010, err: null }],
      logs: claimLogs,
      finalizedSlot: 1000,
    });
    expect((await h.orders.get(order.publicId))!.status).toBe('src_locked');
    expect(recordSecret).not.toHaveBeenCalled();

    await pollOnce(h, { signatures: [], finalizedSlot: 1010 + FINALIZATION_SLOTS });

    const claimed = (await h.orders.get(order.publicId))!;
    expect(claimed.status).toBe('secret_revealed');
    expect(claimed.preimage).toBe(PREIMAGE);

    // `secret_revealed` is not an expiry-scan candidate: a later scan must
    // leave the settled claim alone.
    expect(await h.orders.expireStaleOrders()).toBe(0);
    expect((await h.orders.get(order.publicId))!.status).toBe('secret_revealed');
    expect(recordSecret).toHaveBeenCalledTimes(1);
  });

  it('a refund for an unknown order is ignored without disturbing any state', async () => {
    const order = await announceOrder(h.orders);
    await lockOrder(h, { timelock: futureTimelock() });

    const markStatus = vi.spyOn(h.orders, 'markStatus');
    await pollOnce(h, {
      signatures: [{ signature: 'sig-stray-refund', slot: 1010, err: null }],
      logs: new Map([['sig-stray-refund', refundedLogs('someOtherPDA')]]),
      finalizedSlot: 1010 + FINALIZATION_SLOTS,
    });

    expect(markStatus).not.toHaveBeenCalled();
    expect((await h.orders.get(order.publicId))!.status).toBe('src_locked');
  });
});

describe('SolanaListener — event ordering and replay under delay (#719)', () => {
  let h: Harness;
  const pastTimelock = () => Math.floor(Date.now() / 1000) - 30;

  beforeEach(async () => {
    h = await makeHarness();
  });

  afterEach(() => {
    h.listener.stop();
    vi.restoreAllMocks();
  });

  it('rejects a stale refund sequence (older slot than the recorded src lock)', async () => {
    const order = await announceOrder(h.orders);
    // Src lock recorded at slot 204 — this is the sequence baseline.
    await lockOrder(h, { timelock: pastTimelock(), sig: 'sig-created', slot: 204 });
    await h.orders.expireStaleOrders();
    expect((await h.orders.get(order.publicId))!.status).toBe('expired');

    const markStatus = vi.spyOn(h.orders, 'markStatus');

    // A refund event from a slot *below* the src lock is stale — skipped.
    (h.listener as unknown as { handleLogs(s: string, l: string[], s2?: number): void }).handleLogs(
      'sig-stale',
      refundedLogs(SOL_PDA),
      150
    );
    await settle();
    expect(markStatus).not.toHaveBeenCalled();
    expect((await h.orders.get(order.publicId))!.status).toBe('expired');

    // The same refund from a newer slot applies.
    (h.listener as unknown as { handleLogs(s: string, l: string[], s2?: number): void }).handleLogs(
      'sig-fresh',
      refundedLogs(SOL_PDA),
      250
    );
    await settle();
    expect(markStatus).toHaveBeenCalledTimes(1);
    expect(markStatus).toHaveBeenCalledWith(
      (await h.orders.get(order.publicId))!.publicId,
      'refunded',
      'solana_listener'
    );
    expect((await h.orders.get(order.publicId))!.status).toBe('refunded');
  });

  it('replaying a signature applies exactly one mutation (created, claimed, refunded)', async () => {
    const hashlockB = '0x' + '44'.repeat(32);
    const orderA = await announceOrder(h.orders);
    const orderB = await announceOrder(h.orders, hashlockB);

    const recordSrcLock = vi.spyOn(h.orders, 'recordSrcLock');
    const recordSecret = vi.spyOn(h.orders, 'recordSecret');
    const markStatus = vi.spyOn(h.orders, 'markStatus');

    const dispatch = (sig: string, logs: string[], slot: number) => {
      (
        h.listener as unknown as { handleLogs(s: string, l: string[], s2?: number): void }
      ).handleLogs(sig, logs, slot);
    };

    // Created — delivered twice (overlapping poll windows).
    dispatch('sig-created', createdLogs(HASHLOCK, 'PDA-A', pastTimelock()), 204);
    await settle();
    dispatch('sig-created', createdLogs(HASHLOCK, 'PDA-A', pastTimelock()), 204);
    await settle();
    expect(recordSrcLock).toHaveBeenCalledTimes(1);

    // Claimed — delivered twice.
    dispatch('sig-claim', claimedLogs('PDA-A', PREIMAGE), 210);
    await settle();
    dispatch('sig-claim', claimedLogs('PDA-A', PREIMAGE), 210);
    await settle();
    expect(recordSecret).toHaveBeenCalledTimes(1);

    // Refunded on a *different* order — delivered twice (replay after restart).
    dispatch('sig-b-created', createdLogs(hashlockB, 'PDA-B', pastTimelock()), 205);
    await settle();
    dispatch('sig-b-refund', refundedLogs('PDA-B'), 250);
    await settle();
    dispatch('sig-b-refund', refundedLogs('PDA-B'), 250);
    await settle();
    expect(markStatus).toHaveBeenCalledTimes(1);

    expect((await h.orders.get(orderA.publicId))!.status).toBe('secret_revealed');
    expect((await h.orders.get(orderA.publicId))!.preimage).toBe(PREIMAGE);
    expect((await h.orders.get(orderB.publicId))!.status).toBe('refunded');
    expect(markStatus).toHaveBeenCalledWith(orderB.publicId, 'refunded', 'solana_listener');
  });

  it('a claim replayed after a refund cannot rewrite the terminal order', async () => {
    const order = await announceOrder(h.orders);
    await lockOrder(h, { timelock: pastTimelock(), sig: 'sig-created', slot: 204 });
    await h.orders.expireStaleOrders();

    const handleLogs = (sig: string, logs: string[], slot: number) =>
      (
        h.listener as unknown as { handleLogs(s: string, l: string[], s2?: number): void }
      ).handleLogs(sig, logs, slot);

    handleLogs('sig-refund', refundedLogs(SOL_PDA), 250);
    await settle();
    expect((await h.orders.get(order.publicId))!.status).toBe('refunded');

    // The claim landed on-chain before the timeout but is only replayed now —
    // off-chain the order is terminal, so the mutation must be refused.
    const recordSecret = vi.spyOn(h.orders, 'recordSecret');
    handleLogs('sig-claim-late', claimedLogs(SOL_PDA, PREIMAGE), 205);
    await settle();
    expect(recordSecret).toHaveBeenCalledTimes(1);

    const final = (await h.orders.get(order.publicId))!;
    expect(final.status).toBe('refunded');
    expect(final.preimage).toBeNull();
  });

  it('out-of-order claim and refund across two orders do not cross-contaminate', async () => {
    const orderA = await announceOrder(h.orders);
    const hashlockB = '0x' + '43'.repeat(32);
    const orderB = await announceOrder(h.orders, hashlockB);

    const handleLogs = (sig: string, logs: string[], slot: number) =>
      (
        h.listener as unknown as { handleLogs(s: string, l: string[], s2?: number): void }
      ).handleLogs(sig, logs, slot);

    // Interleave: A created, B created, A claimed, B refunded. Each event is
    // allowed to commit before the next starts — the events are observed in
    // separate slots, and SQLite serialises the repository's transactions.
    handleLogs('sig-a-created', createdLogs(HASHLOCK, 'PDA-A', pastTimelock()), 204);
    await settle();
    handleLogs('sig-b-created', createdLogs(hashlockB, 'PDA-B', pastTimelock()), 205);
    await settle();
    handleLogs('sig-a-claim', claimedLogs('PDA-A', PREIMAGE), 210);
    await settle();
    handleLogs('sig-b-refund', refundedLogs('PDA-B'), 211);
    await settle();

    const a = (await h.orders.get(orderA.publicId))!;
    const b = (await h.orders.get(orderB.publicId))!;
    expect(a.status).toBe('secret_revealed');
    expect(a.preimage).toBe(PREIMAGE);
    expect(b.status).toBe('refunded');
    expect(b.preimage).toBeNull();
  });
});
