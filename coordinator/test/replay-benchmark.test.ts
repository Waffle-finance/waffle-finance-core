/**
 * Reproducible full-event-replay performance benchmark (issue #1128).
 *
 * Run with:
 *   pnpm --filter @wafflefinance/coordinator exec vitest run test/replay-benchmark.test.ts
 *
 * Optional environment:
 *   REPLAY_BENCH_SEED=20261123   fixture seed (default 20261123)
 *   REPLAY_BENCH_SCALE=all       small | large | all (default all)
 *   REPLAY_BENCH_DB=postgres     run the Postgres variant when COORDINATOR_DATABASE_URL is set
 *
 * The event fixture is generated deterministically from the seed, so a
 * regression can be reproduced byte-for-byte. Results include throughput,
 * database writes, cursor movement, heap delta and machine metadata.
 * Thresholds are deliberately loose host-independent guards (not an SLA);
 * see docs/PERFORMANCE_BASELINE.md for the recorded baseline.
 */
import { describe, it, expect } from "vitest";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { openTestSqlite } from "./helpers/test-db.js";
import { OrdersRepository } from "../src/persistence/orders-repo.js";

const DEFAULT_SEED = 20261123;
const SCALES = { small: 200, large: 2_000 } as const;
type Scale = keyof typeof SCALES;

/** mulberry32 — small deterministic PRNG, identical across Node versions. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

export type ReplayEvent =
  | { kind: "order.created"; seq: number; hashlock: string }
  | { kind: "src.locked"; seq: number; orderId: string; block: number }
  | { kind: "cursor.advanced"; seq: number; block: number };

/** Deterministic fixture: 1 created + 1 locked + 1 cursor event per order. */
export function generateReplayFixture(count: number, seed: number): ReplayEvent[] {
  const rand = seededRandom(seed);
  const events: ReplayEvent[] = [];
  let block = 10_000_000;
  for (let i = 0; i < count; i++) {
    const seq = i * 3;
    const hashlock = "0x" + (seed + i).toString(16).padStart(8, "0").repeat(8).slice(0, 64);
    events.push({ kind: "order.created", seq, hashlock });
    events.push({ kind: "src.locked", seq: seq + 1, orderId: String(i + 1), block });
    block += 1 + Math.floor(rand() * 4);
    events.push({ kind: "cursor.advanced", seq: seq + 2, block });
  }
  return events;
}

const VALID_ETH_ADDR = "0x1111111111111111111111111111111111111111";
const VALID_STELLAR_ADDR = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422";

export interface ReplayBenchmarkResult {
  scale: Scale;
  seed: number;
  events: number;
  durationMs: number;
  eventsPerSecond: number;
  databaseWrites: number;
  cursorStart: number;
  cursorEnd: number;
  heapDeltaMb: number;
  engine: string;
  environment: Record<string, unknown>;
}

/** Replay a fixture through the real repository, counting writes and cursor movement. */
export async function runReplayBenchmark(scale: Scale, seed: number): Promise<ReplayBenchmarkResult> {
  const dir = mkdtempSync(resolve(tmpdir(), "wf-replay-bench-"));
  const url = process.env.REPLAY_BENCH_DB === "postgres" && process.env.COORDINATOR_DATABASE_URL
    ? process.env.COORDINATOR_DATABASE_URL
    : `file:${dir}/replay.db`;
  const db = await openTestSqlite(url.replace(/^file:/, ""));
  const repo = new OrdersRepository(db);
  const events = generateReplayFixture(SCALES[scale], seed);

  const cursorStart = await repo.getChainCursor("ethereum");
  const heapBefore = process.memoryUsage().heapUsed;
  const start = performance.now();
  let databaseWrites = 0;
  let cursorEnd = cursorStart;
  const publicIds: string[] = [];

  for (const event of events) {
    switch (event.kind) {
      case "order.created": {
        const announced = await repo.announce({
          direction: "eth_to_xlm",
          hashlock: event.hashlock,
          srcChain: "ethereum",
          srcAddress: VALID_ETH_ADDR,
          srcAsset: "native",
          srcAmount: "1000000000000000000",
          srcSafetyDeposit: "1000000000000000",
          dstChain: "stellar",
          dstAddress: VALID_STELLAR_ADDR,
          dstAsset: "native",
          dstAmount: "100000000",
        });
        publicIds.push(announced.publicId);
        databaseWrites++;
        break;
      }
      case "src.locked":
        await repo.recordSrcLock({
          publicId: publicIds[Math.floor(event.seq / 3)] ?? publicIds[publicIds.length - 1]!,
          orderId: event.orderId,
          txHash: `0xbench${event.seq.toString(16)}`,
          blockNumber: event.block,
          timelock: 9_999_999,
        });
        databaseWrites++;
        break;
      case "cursor.advanced":
        await repo.setChainCursor("ethereum", event.block);
        databaseWrites++;
        cursorEnd = event.block;
        break;
    }
  }

  const durationMs = performance.now() - start;
  const result: ReplayBenchmarkResult = {
    scale,
    seed,
    events: events.length,
    durationMs,
    eventsPerSecond: events.length / (durationMs / 1000),
    databaseWrites,
    cursorStart,
    cursorEnd,
    heapDeltaMb: (process.memoryUsage().heapUsed - heapBefore) / 1024 / 1024,
    engine: url.startsWith("postgres") ? "postgres" : "sqlite",
    environment: {
      node: process.version,
      platform: platform(),
      arch: arch(),
      release: release(),
      cpus: cpus().length,
      totalMemoryGb: +(totalmem() / 1024 ** 3).toFixed(2),
    },
  };
  // Machine-readable output for baseline updates / CI artefacts.
  console.log(`[replay-benchmark] ${JSON.stringify(result)}`);
  return result;
}

const seed = Number(process.env.REPLAY_BENCH_SEED ?? DEFAULT_SEED);
const configuredScale = process.env.REPLAY_BENCH_SCALE ?? "all";
const scales: Scale[] = configuredScale === "all"
  ? ["small", "large"]
  : [configuredScale as Scale];

describe("full event replay benchmark", () => {
  for (const scale of scales) {
    it(`replays a deterministic ${scale} fixture at an acceptable rate`, async () => {
      const result = await runReplayBenchmark(scale, Number.isFinite(seed) ? seed : DEFAULT_SEED);

      // Reproducibility: fixture shape and write count are fixed by the seed.
      expect(result.events).toBe(SCALES[scale] * 3);
      expect(result.databaseWrites).toBe(result.events);
      expect(result.cursorEnd).toBeGreaterThan(result.cursorStart);

      // Regression thresholds: generous enough for CI, tight enough to catch
      // an order-of-magnitude regression in replay throughput.
      expect(result.eventsPerSecond).toBeGreaterThan(20);
      expect(result.durationMs).toBeLessThan(scale === "large" ? 120_000 : 30_000);
    }, 180_000);
  }
});
