/**
 * Unit tests for QuoteService SWR caching behaviour.
 *
 * Design principle: we stub Date.now() directly to control cache-age
 * decisions without registering any fake timers. This avoids all
 * interactions between vitest's fake-timer machinery and Node's internal
 * timer queues (AbortSignal.timeout, setImmediate, etc.) that cause
 * flakiness on CI.
 *
 * Background fetches are real microtask promises (the fetch mock resolves
 * via Promise.resolve()) so we just `await` them naturally.
 */

import { beforeEach, afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import pino from "pino";
import { QuoteService } from "../src/services/quote-service.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOOP_LOGGER = pino({ level: "silent" });

/** A valid CoinGecko response for the ETH-XLM pair. */
function cgResponse(ethUsd: number, xlmUsd: number): Response {
  return new Response(
    JSON.stringify({ ethereum: { usd: ethUsd }, stellar: { usd: xlmUsd } }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

/** A valid CoinGecko response for the ETH-SOL pair. */
function cgSolResponse(ethUsd: number, solUsd: number): Response {
  return new Response(
    JSON.stringify({ ethereum: { usd: ethUsd }, solana: { usd: solUsd } }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

/**
 * Drain the microtask queue by yielding enough times for the full async
 * chain inside _fetchAndStore to complete:
 *   fetch mock resolves (1) → .json() resolves (2) → cache.set (sync) →
 *   _fetchAndStore returns (3) → .catch handler (4) → .finally (5)
 * We yield 20 times for generous headroom across environments.
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("QuoteService — SWR caching", () => {
  let fetchMock: MockInstance;
  let nowMs: number;

  beforeEach(() => {
    nowMs = 1_000_000; // arbitrary baseline
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    fetchMock = vi.spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Fresh window ──────────────────────────────────────────────────────────

  it("returns fresh data without hitting the upstream again within freshTtlMs", async () => {
    fetchMock.mockResolvedValueOnce(cgResponse(3000, 0.10));

    const svc = new QuoteService(NOOP_LOGGER, { freshTtlMs: 15_000, staleTtlMs: 60_000, maxStaleTtlMs: 300_000 });

    const first = await svc.getQuote("ETH-XLM");
    expect(first.staleness).toBe("fresh");
    expect(first.srcUsd).toBe(3000);
    expect(first.dstUsd).toBe(0.10);

    // Advance just under the fresh window — still fresh.
    nowMs += 14_000;
    const second = await svc.getQuote("ETH-XLM");
    expect(second.staleness).toBe("fresh");

    // Upstream called only once.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // ── Stale window — background refresh ─────────────────────────────────────

  it("serves stale data immediately and kicks off a background refresh within staleTtlMs", async () => {
    fetchMock.mockResolvedValueOnce(cgResponse(3000, 0.10));  // initial fetch
    fetchMock.mockResolvedValueOnce(cgResponse(3100, 0.11));  // background refresh

    const svc = new QuoteService(NOOP_LOGGER, { freshTtlMs: 5_000, staleTtlMs: 30_000, maxStaleTtlMs: 300_000 });

    // 1. Cold-start fetch → cache holds 3000 at T=1_000_000
    await svc.getQuote("ETH-XLM");

    // 2. Advance into stale window (age = 10s > fresh 5s, < stale 30s)
    nowMs += 10_000;

    // 3. getQuote returns stale 3000 immediately AND kicks off background refresh
    const stale = await svc.getQuote("ETH-XLM");
    expect(stale.staleness).toBe("stale");
    expect(stale.srcUsd).toBe(3000);

    // 4. Let the background fetch's microtask chain fully complete
    await flushMicrotasks();

    // 5. Cache now holds 3100
    const refreshed = await svc.getQuote("ETH-XLM");
    expect(refreshed.srcUsd).toBe(3100);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // ── Thundering herd ────────────────────────────────────────────────────────

  it("collapses concurrent requests into a single upstream call (thundering-herd guard)", async () => {
    let resolveUpstream!: (r: Response) => void;
    const upstream = new Promise<Response>((res) => { resolveUpstream = res; });
    fetchMock.mockReturnValue(upstream);

    const svc = new QuoteService(NOOP_LOGGER, { freshTtlMs: 15_000, staleTtlMs: 60_000, maxStaleTtlMs: 300_000 });

    const allQuotes = Promise.all([
      svc.getQuote("ETH-XLM"),
      svc.getQuote("ETH-XLM"),
      svc.getQuote("ETH-XLM"),
      svc.getQuote("ETH-XLM"),
      svc.getQuote("ETH-XLM"),
    ]);

    // All 5 are in-flight but only 1 fetch was made.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveUpstream(cgResponse(3200, 0.12));
    const [a, b, c, d, e] = await allQuotes;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    for (const snap of [a, b, c, d, e]) {
      expect(snap.srcUsd).toBe(3200);
      expect(snap.dstUsd).toBe(0.12);
    }
  });

  // ── API outage: cold start ─────────────────────────────────────────────────

  it("returns hardcoded fallback when the upstream is unavailable at cold start", async () => {
    fetchMock.mockRejectedValue(new Error("Network error"));

    const svc = new QuoteService(NOOP_LOGGER);
    const snap = await svc.getQuote("ETH-XLM");

    expect(snap.staleness).toBe("fallback");
    expect(snap.source).toBe("fallback");
    expect(snap.srcUsd).not.toBeNull();
    expect(snap.dstUsd).not.toBeNull();
  });

  // ── Last-known-good after outage ───────────────────────────────────────────

  it("returns last-known-good (marked fallback) when upstream fails after a prior live fetch", async () => {
    fetchMock.mockResolvedValueOnce(cgResponse(3000, 0.10));  // initial live
    fetchMock.mockRejectedValueOnce(new Error("coingecko 503")); // background fails
    fetchMock.mockRejectedValueOnce(new Error("still down"));    // blocking fetch fails

    const svc = new QuoteService(NOOP_LOGGER, { freshTtlMs: 5_000, staleTtlMs: 30_000, maxStaleTtlMs: 300_000 });

    // 1. Cold-start live fetch → 3000 in cache
    await svc.getQuote("ETH-XLM");

    // 2. Stale window: background refresh triggered, cache entry will be
    //    marked isFallback=true after the rejection settles
    nowMs += 10_000;
    await svc.getQuote("ETH-XLM");
    await flushMicrotasks(); // let the failed refresh update the cache

    // 3. Beyond maxStaleTtl → blocking fetch, which also fails → last-known-good
    nowMs += 400_000;
    const fallback = await svc.getQuote("ETH-XLM");

    expect(fallback.staleness).toBe("fallback");
    expect(fallback.srcUsd).toBe(3000);
    expect(fallback.dstUsd).toBe(0.10);
  });

  // ── HTTP 503 ───────────────────────────────────────────────────────────────

  it("returns fallback when the upstream returns a non-200 response", async () => {
    fetchMock.mockResolvedValue(new Response("Service Unavailable", { status: 503 }));

    const svc = new QuoteService(NOOP_LOGGER);
    const snap = await svc.getQuote("ETH-XLM");

    expect(snap.staleness).toBe("fallback");
    expect(snap.source).toBe("fallback");
  });

  // ── maxStaleTtl enforcement ────────────────────────────────────────────────

  it("marks data as fallback once it is older than maxStaleTtlMs", async () => {
    fetchMock.mockResolvedValueOnce(cgResponse(3000, 0.10));
    fetchMock.mockRejectedValue(new Error("outage")); // all subsequent fail

    const svc = new QuoteService(NOOP_LOGGER, {
      freshTtlMs: 5_000,
      staleTtlMs: 30_000,
      maxStaleTtlMs: 60_000,
    });

    await svc.getQuote("ETH-XLM");

    // Jump well past maxStaleTtl and flush any background attempt
    nowMs += 120_000;
    await flushMicrotasks();

    const snap = await svc.getQuote("ETH-XLM");
    expect(snap.staleness).toBe("fallback");
    expect(snap.srcUsd).not.toBeNull(); // last-known-good, not null
  });

  // ── Non-blocking background refresh ───────────────────────────────────────

  it("never blocks the current caller while background refresh is in-flight", async () => {
    fetchMock.mockResolvedValueOnce(cgResponse(3000, 0.10));

    // Slow background fetch — resolves after the assertion
    let resolveBackground!: (r: Response) => void;
    const bg = new Promise<Response>((res) => { resolveBackground = res; });
    fetchMock.mockReturnValueOnce(bg);

    const svc = new QuoteService(NOOP_LOGGER, { freshTtlMs: 5_000, staleTtlMs: 30_000, maxStaleTtlMs: 300_000 });

    await svc.getQuote("ETH-XLM");

    // Enter stale window — next getQuote kicks off background refresh
    nowMs += 10_000;
    const snap = await svc.getQuote("ETH-XLM");

    // Must return stale immediately without blocking on the slow fetch
    expect(snap.srcUsd).toBe(3000);
    expect(snap.staleness).toBe("stale");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // Clean up — resolve so vitest teardown has no dangling promise
    resolveBackground(cgResponse(3050, 0.105));
    await bg;
  });

  // ── quoteEthXlm wrapper ────────────────────────────────────────────────────

  it("quoteEthXlm() returns stringified prices with staleness metadata", async () => {
    fetchMock.mockResolvedValueOnce(cgResponse(3400, 0.11));

    const svc = new QuoteService(NOOP_LOGGER);
    const result = await svc.quoteEthXlm();

    expect(result.ethUsd).toBe("3400");
    expect(result.xlmUsd).toBe("0.11");
    expect(result.staleness).toBe("fresh");
    expect(typeof result.fetchedAt).toBe("number");
    expect(typeof result.ageMs).toBe("number");
  });

  // ── Independent pair caches ────────────────────────────────────────────────

  it("caches ETH-XLM and ETH-SOL independently", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes("stellar")) {
        return Promise.resolve(cgResponse(3000, 0.10));
      }
      return Promise.resolve(cgSolResponse(3000, 160));
    });

    const svc = new QuoteService(NOOP_LOGGER);
    const xlm = await svc.getQuote("ETH-XLM");
    const sol = await svc.getQuote("ETH-SOL");

    expect(xlm.dstUsd).toBe(0.10);
    expect(sol.dstUsd).toBe(160);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // ── rate field ─────────────────────────────────────────────────────────────

  it("computes rate as srcUsd / dstUsd", async () => {
    fetchMock.mockResolvedValueOnce(cgResponse(4000, 0.20));

    const svc = new QuoteService(NOOP_LOGGER);
    const snap = await svc.getQuote("ETH-XLM");

    // 4000 / 0.20 = 20000
    expect(snap.rate).toBeCloseTo(20_000, 2);
  });

  // ── #285: invalidate ──────────────────────────────────────────────────────

  it("invalidate() evicts the pair so the next call blocks on a fresh fetch", async () => {
    fetchMock.mockResolvedValueOnce(cgResponse(3000, 0.10));
    fetchMock.mockResolvedValueOnce(cgResponse(4000, 0.20));

    const svc = new QuoteService(NOOP_LOGGER, { freshTtlMs: 60_000, staleTtlMs: 120_000, maxStaleTtlMs: 300_000 });

    // 1. Cold-start fetch → 3000
    const before = await svc.getQuote("ETH-XLM");
    expect(before.srcUsd).toBe(3000);

    // 2. Invalidate — cache is cleared
    svc.invalidate("ETH-XLM");

    // 3. Next call must hit upstream (cache is empty)
    const after = await svc.getQuote("ETH-XLM");
    expect(after.srcUsd).toBe(4000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("invalidate() on an uncached pair is a no-op (does not throw)", () => {
    const svc = new QuoteService(NOOP_LOGGER);
    expect(() => svc.invalidate("ETH-XLM")).not.toThrow();
  });

  it("invalidate() only clears the target pair, leaving other pairs intact", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (String(url).includes("stellar")) return Promise.resolve(cgResponse(3000, 0.10));
      return Promise.resolve(cgSolResponse(3000, 160));
    });

    const svc = new QuoteService(NOOP_LOGGER, { freshTtlMs: 60_000, staleTtlMs: 120_000, maxStaleTtlMs: 300_000 });
    await svc.getQuote("ETH-XLM");
    await svc.getQuote("ETH-SOL");

    // Invalidate only the XLM pair
    svc.invalidate("ETH-XLM");

    // SOL pair is still cached — no additional upstream call
    nowMs += 1_000;
    const solSnap = await svc.getQuote("ETH-SOL");
    expect(solSnap.staleness).toBe("fresh");
    expect(solSnap.dstUsd).toBe(160);
  });

  // ── TTL validation ────────────────────────────────────────────────────────

  it("rejects zero freshTtlMs", () => {
    expect(() => new QuoteService(NOOP_LOGGER, { freshTtlMs: 0 })).toThrow(
      "freshTtlMs must be a positive number"
    );
  });

  it("rejects negative staleTtlMs", () => {
    expect(() => new QuoteService(NOOP_LOGGER, { staleTtlMs: -1 })).toThrow(
      "staleTtlMs must be a positive number"
    );
  });

  it("rejects zero maxStaleTtlMs", () => {
    expect(() => new QuoteService(NOOP_LOGGER, { maxStaleTtlMs: 0 })).toThrow(
      "maxStaleTtlMs must be a positive number"
    );
  });

  it("accepts positive TTL values", async () => {
    fetchMock.mockResolvedValueOnce(cgResponse(3000, 0.10));
    const svc = new QuoteService(NOOP_LOGGER, { freshTtlMs: 1, staleTtlMs: 2, maxStaleTtlMs: 3 });
    const snap = await svc.getQuote("ETH-XLM");
    expect(snap.srcUsd).toBe(3000);
  });

  // ── #285: getCacheStats ───────────────────────────────────────────────────

  it("getCacheStats() returns empty object when cache is cold", () => {
    const svc = new QuoteService(NOOP_LOGGER);
    expect(svc.getCacheStats()).toEqual({});
  });

  it("getCacheStats() returns an entry with correct freshness after a live fetch", async () => {
    fetchMock.mockResolvedValueOnce(cgResponse(3500, 0.11));

    const svc = new QuoteService(NOOP_LOGGER, { freshTtlMs: 15_000, staleTtlMs: 60_000, maxStaleTtlMs: 300_000 });
    await svc.getQuote("ETH-XLM");

    const stats = svc.getCacheStats();
    expect(stats["ETH-XLM"]).toBeDefined();
    expect(stats["ETH-XLM"].pair).toBe("ETH-XLM");
    expect(stats["ETH-XLM"].staleness).toBe("fresh");
    expect(stats["ETH-XLM"].isFallback).toBe(false);
    expect(stats["ETH-XLM"].ageMs).toBeGreaterThanOrEqual(0);
  });

  it("getCacheStats() reports staleness correctly when data ages into stale window", async () => {
    fetchMock.mockResolvedValueOnce(cgResponse(3500, 0.11));

    const svc = new QuoteService(NOOP_LOGGER, { freshTtlMs: 5_000, staleTtlMs: 60_000, maxStaleTtlMs: 300_000 });
    await svc.getQuote("ETH-XLM");

    // Advance past freshTtlMs
    nowMs += 10_000;

    const stats = svc.getCacheStats();
    expect(stats["ETH-XLM"].staleness).toBe("stale");
  });

  it("getCacheStats() reports isFallback:true after an upstream failure", async () => {
    fetchMock.mockRejectedValueOnce(new Error("upstream down"));

    const svc = new QuoteService(NOOP_LOGGER);
    await svc.getQuote("ETH-XLM"); // returns hardcoded fallback (not cached)

    // Hardcoded fallback is not written to cache on cold start, so stats is empty.
    const stats = svc.getCacheStats();
    expect(Object.keys(stats)).toHaveLength(0);
  });
});
