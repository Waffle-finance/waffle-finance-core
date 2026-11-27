/**
 * @fileoverview Deterministic mock RPC for relayer load tests (issue #1088).
 *
 * Models the three resources that concurrent order processing stresses:
 *
 *  - **RPC quota.**  At most `maxConcurrentRequests` requests may be in flight;
 *    any request beyond that fails immediately with a 429, just like a
 *    provider's per-key concurrency limit.
 *  - **Latency.**  Each method has a base latency plus seeded jitter, so runs
 *    are reproducible but requests still complete out of order.
 *  - **Signing-account nonces.**  `sendRawTransaction` rejects a nonce that
 *    was already accepted ("nonce too low"), so the harness can prove nonce
 *    allocation stays unique under concurrency.
 *
 * No network, private keys or public endpoints are involved — everything runs
 * on (fake) timers.
 */

export type RpcMethod =
  | 'eth_estimateGas'
  | 'eth_call'
  | 'eth_getBlockByNumber'
  | 'eth_sendRawTransaction'
  | 'eth_getTransactionReceipt';

export const DEFAULT_LATENCY_MS: Record<RpcMethod, number> = {
  eth_estimateGas: 40,
  eth_call: 30,
  eth_getBlockByNumber: 25,
  eth_sendRawTransaction: 60,
  eth_getTransactionReceipt: 120,
};

export interface MockRpcOptions {
  /** Provider concurrency quota. Requests beyond this get a 429. */
  maxConcurrentRequests: number;
  latencyMs?: Partial<Record<RpcMethod, number>>;
  /** Max extra latency added per request, drawn from `rng`. */
  jitterMs?: number;
  /** Seeded PRNG returning [0, 1). */
  rng: () => number;
}

export class RpcRateLimitError extends Error {
  readonly status = 429;
  constructor(method: RpcMethod) {
    super(`429 Too Many Requests: ${method} exceeded provider concurrency quota`);
    this.name = 'RpcRateLimitError';
  }
}

export class NonceTooLowError extends Error {
  readonly code = 'NONCE_EXPIRED';
  constructor(account: string, nonce: number) {
    super(`nonce too low: account ${account} already used nonce ${nonce}`);
    this.name = 'NonceTooLowError';
  }
}

export interface SignedTx {
  from: string;
  nonce: number;
  orderId: string;
  action: string;
}

export class MockRpc {
  private readonly quota: number;
  private readonly latency: Record<RpcMethod, number>;
  private readonly jitterMs: number;
  private readonly rng: () => number;

  private inFlight = 0;
  private txCounter = 0;
  private readonly usedNonces = new Map<string, Set<number>>();

  // ── Observations ─────────────────────────────────────────────────────────
  totalCalls = 0;
  rateLimited = 0;
  nonceRejections = 0;
  peakInFlight = 0;
  readonly callsByOrder = new Map<string, number>();
  readonly callsByMethod = new Map<RpcMethod, number>();

  constructor(opts: MockRpcOptions) {
    this.quota = opts.maxConcurrentRequests;
    this.latency = { ...DEFAULT_LATENCY_MS, ...opts.latencyMs };
    this.jitterMs = opts.jitterMs ?? 20;
    this.rng = opts.rng;
  }

  /** Nonces accepted for `account`, sorted ascending. */
  acceptedNonces(account: string): number[] {
    return [...(this.usedNonces.get(account) ?? [])].sort((a, b) => a - b);
  }

  async request(method: RpcMethod, orderId: string): Promise<void> {
    this.count(method, orderId);
    if (this.inFlight >= this.quota) {
      this.rateLimited++;
      throw new RpcRateLimitError(method);
    }
    this.inFlight++;
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
    try {
      await this.delay(method);
    } finally {
      this.inFlight--;
    }
  }

  async sendRawTransaction(tx: SignedTx): Promise<string> {
    await this.request('eth_sendRawTransaction', tx.orderId);
    let used = this.usedNonces.get(tx.from);
    if (!used) {
      used = new Set();
      this.usedNonces.set(tx.from, used);
    }
    if (used.has(tx.nonce)) {
      this.nonceRejections++;
      throw new NonceTooLowError(tx.from, tx.nonce);
    }
    used.add(tx.nonce);
    this.txCounter++;
    return `0x${this.txCounter.toString(16).padStart(64, '0')}`;
  }

  private count(method: RpcMethod, orderId: string): void {
    this.totalCalls++;
    this.callsByOrder.set(orderId, (this.callsByOrder.get(orderId) ?? 0) + 1);
    this.callsByMethod.set(method, (this.callsByMethod.get(method) ?? 0) + 1);
  }

  private delay(method: RpcMethod): Promise<void> {
    const ms = this.latency[method] + Math.floor(this.rng() * (this.jitterMs + 1));
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/** mulberry32 — tiny seeded PRNG, good enough for reproducible workloads. */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
