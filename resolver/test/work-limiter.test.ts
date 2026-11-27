import { describe, it, expect, beforeEach } from "vitest";
import { ResolverWorkLimiter, workLimiterOptionsFromEnv } from "../src/work-limiter.js";
import { registry } from "../src/metrics.js";

/** A promise you resolve by hand, to hold work "in flight". */
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setImmediate(r));

async function metricValue(name: string, labels: Record<string, string>): Promise<number> {
  const metric = (await registry.getMetricsAsJSON()).find((m) => m.name === name);
  const v = metric?.values.find((x) =>
    Object.entries(labels).every(([k, val]) => (x.labels as Record<string, unknown>)[k] === val)
  );
  return v?.value ?? 0;
}

let clock = 0;
const now = () => clock;

beforeEach(() => {
  clock = 0;
  registry.resetMetrics();
});

describe("duplicate bursts", () => {
  it("a burst of identical events runs the handler once", async () => {
    const limiter = new ResolverWorkLimiter({ now });
    const gate = deferred();
    let rpcCalls = 0;
    const handler = async () => {
      rpcCalls++;
      await gate.promise;
    };

    const burst = Array.from({ length: 50 }, () =>
      limiter.run({ chain: "ethereum", action: "order_claimed", orderId: "7" }, handler)
    );
    gate.resolve();
    const outcomes = await Promise.all(burst);

    expect(rpcCalls).toBe(1);
    expect(outcomes.filter((o) => o.status === "completed")).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === "deduplicated")).toHaveLength(49);
    expect(await metricValue("resolver_work_deduplicated_total", { chain: "ethereum", reason: "in_flight" })).toBe(49);
  });

  it("replays shortly after success are absorbed; after the TTL they may run again", async () => {
    const limiter = new ResolverWorkLimiter({ now, dedupTtlMs: 1_000 });
    let calls = 0;
    const key = { chain: "soroban", action: "order_created", orderId: "1" };
    await limiter.run(key, async () => void calls++);
    clock += 500;
    expect((await limiter.run(key, async () => void calls++)).status).toBe("deduplicated");
    clock += 600;
    expect((await limiter.run(key, async () => void calls++)).status).toBe("completed");
    expect(calls).toBe(2);
  });

  it("failed attempts are retried but bounded by the per-order budget", async () => {
    const limiter = new ResolverWorkLimiter({ now, maxAttemptsPerOrder: 3, attemptWindowMs: 10_000 });
    const key = { chain: "ethereum", action: "claim", orderId: "9" };
    let calls = 0;
    const failing = async () => {
      calls++;
      throw new Error("rpc timeout");
    };

    for (let i = 0; i < 3; i++) await expect(limiter.run(key, failing)).rejects.toThrow("rpc timeout");
    for (let i = 0; i < 20; i++) {
      expect(await limiter.run(key, failing)).toEqual({ status: "rejected", reason: "order_budget_exhausted" });
    }
    expect(calls).toBe(3);
    expect(await metricValue("resolver_work_rejected_total", { chain: "ethereum", reason: "order_budget_exhausted" })).toBe(20);

    // The budget is a sliding window: once it passes, the order may retry.
    clock += 10_000;
    await expect(limiter.run(key, failing)).rejects.toThrow();
    expect(calls).toBe(4);
  });

  it("a burst of one action cannot exhaust a different action's budget for the same order", async () => {
    const limiter = new ResolverWorkLimiter({ now, maxAttemptsPerOrder: 2, dedupTtlMs: 0 });
    for (let i = 0; i < 5; i++) {
      await limiter.run({ chain: "ethereum", action: "order_created", orderId: "5" }, async () => {});
    }
    const claim = await limiter.run({ chain: "ethereum", action: "order_claimed", orderId: "5" }, async () => "ok");
    expect(claim).toEqual({ status: "completed", value: "ok" });
  });

  it("remember=false keeps a skipped result from absorbing the next attempt", async () => {
    const limiter = new ResolverWorkLimiter({ now });
    const key = { chain: "ethereum", action: "order_created", orderId: "3" };
    await limiter.run(key, async () => "skipped", { remember: (v) => v !== "skipped" });
    expect((await limiter.run(key, async () => "done")).status).toBe("completed");
  });
});

describe("independent orders and per-chain concurrency", () => {
  it("independent orders all run, never more than the limit at once", async () => {
    const limiter = new ResolverWorkLimiter({ now, maxConcurrentPerChain: 3 });
    let running = 0;
    let peak = 0;
    const gates = Array.from({ length: 10 }, () => deferred());
    const runs = gates.map((g, i) =>
      limiter.run({ chain: "ethereum", action: "order_created", orderId: String(i) }, async () => {
        running++;
        peak = Math.max(peak, running);
        await g.promise;
        running--;
      })
    );

    await flush();
    expect(limiter.load("ethereum")).toEqual({ active: 3, queued: 7 });
    expect(await metricValue("resolver_work_deferred_total", { chain: "ethereum" })).toBe(7);

    for (const g of gates) {
      g.resolve();
      await flush();
    }
    const outcomes = await Promise.all(runs);
    expect(outcomes.every((o) => o.status === "completed")).toBe(true);
    expect(peak).toBe(3);
    expect(limiter.load("ethereum")).toEqual({ active: 0, queued: 0 });
  });

  it("one chain's backlog does not block another chain", async () => {
    const limiter = new ResolverWorkLimiter({ now, maxConcurrentPerChain: 1 });
    const hold = deferred();
    void limiter.run({ chain: "ethereum", action: "order_created", orderId: "1" }, () => hold.promise);
    void limiter.run({ chain: "ethereum", action: "order_created", orderId: "2" }, async () => {});
    const other = await limiter.run({ chain: "soroban", action: "order_created", orderId: "1" }, async () => "ran");
    expect(other).toEqual({ status: "completed", value: "ran" });
    hold.resolve();
  });

  it("settlement work jumps ahead of queued new-order work", async () => {
    const limiter = new ResolverWorkLimiter({ now, maxConcurrentPerChain: 1 });
    const order: string[] = [];
    const hold = deferred();
    const first = limiter.run({ chain: "ethereum", action: "order_created", orderId: "0" }, () => hold.promise);
    const queued = [
      limiter.run({ chain: "ethereum", action: "order_created", orderId: "1" }, async () => void order.push("create-1")),
      limiter.run({ chain: "ethereum", action: "order_created", orderId: "2" }, async () => void order.push("create-2")),
      limiter.run({ chain: "ethereum", action: "order_claimed", orderId: "3" }, async () => void order.push("claim-3")),
    ];
    hold.resolve();
    await Promise.all([first, ...queued]);
    expect(order).toEqual(["claim-3", "create-1", "create-2"]);
  });
});

describe("backpressure recovery", () => {
  it("rejects when the queue is full, then accepts again once it drains", async () => {
    const limiter = new ResolverWorkLimiter({ now, maxConcurrentPerChain: 1, maxQueuedPerChain: 2 });
    const hold = deferred();
    const runs = [
      limiter.run({ chain: "ethereum", action: "order_created", orderId: "a" }, () => hold.promise),
      limiter.run({ chain: "ethereum", action: "order_created", orderId: "b" }, async () => {}),
      limiter.run({ chain: "ethereum", action: "order_created", orderId: "c" }, async () => {}),
    ];
    const overflow = await limiter.run({ chain: "ethereum", action: "order_created", orderId: "d" }, async () => {});
    expect(overflow).toEqual({ status: "rejected", reason: "queue_full" });
    expect(await metricValue("resolver_work_rejected_total", { chain: "ethereum", reason: "queue_full" })).toBe(1);

    hold.resolve();
    await Promise.all(runs);
    expect(limiter.load("ethereum")).toEqual({ active: 0, queued: 0 });

    // The rejected order was never recorded as attempted, so it runs now.
    const retry = await limiter.run({ chain: "ethereum", action: "order_created", orderId: "d" }, async () => "ok");
    expect(retry).toEqual({ status: "completed", value: "ok" });
  });

  it("a handler that throws synchronously still releases its slot", async () => {
    const limiter = new ResolverWorkLimiter({ now, maxConcurrentPerChain: 1 });
    await expect(
      limiter.run({ chain: "ethereum", action: "x" }, (() => {
        throw new Error("boom");
      }) as () => Promise<void>)
    ).rejects.toThrow("boom");
    expect(limiter.load("ethereum").active).toBe(0);
  });
});

describe("configuration", () => {
  it("reads limits from the environment", () => {
    expect(
      workLimiterOptionsFromEnv({ RESOLVER_MAX_CONCURRENT_PER_CHAIN: "8", RESOLVER_MAX_ATTEMPTS_PER_ORDER: "3" })
    ).toMatchObject({ maxConcurrentPerChain: 8, maxAttemptsPerOrder: 3, dedupTtlMs: undefined });
    expect(() => workLimiterOptionsFromEnv({ RESOLVER_DEDUP_TTL_MS: "soon" })).toThrow(RangeError);
  });

  it("rejects invalid limits", () => {
    expect(() => new ResolverWorkLimiter({ maxConcurrentPerChain: 0 })).toThrow(RangeError);
    expect(() => new ResolverWorkLimiter({ maxAttemptsPerOrder: 1.5 })).toThrow(RangeError);
  });
});
