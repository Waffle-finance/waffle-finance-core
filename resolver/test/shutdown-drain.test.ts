import { describe, it, expect, vi, afterEach } from "vitest";
import pino from "pino";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DrainCoordinator,
  DrainingError,
  ShutdownOrchestrator,
  createFileAmbiguousTxSink,
  resolveDrainTimeoutMs,
  DEFAULT_DRAIN_TIMEOUT_MS,
  type AmbiguousTransaction,
} from "../src/shutdown-drain.js";

const nullLog = pino({ level: "silent" });

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const meta = { chain: "ethereum", action: "claim", orderId: "42" };

afterEach(() => {
  vi.useRealTimers();
});

describe("DrainCoordinator — intake", () => {
  it("runs operations and tracks them while accepting", async () => {
    const drain = new DrainCoordinator({ log: nullLog, drainTimeoutMs: 1_000 });
    const gate = deferred();
    const running = drain.run(meta, async () => {
      await gate.promise;
      return "ok";
    });
    expect(drain.inFlightCount).toBe(1);
    expect(drain.snapshot()[0]).toMatchObject({ chain: "ethereum", action: "claim", orderId: "42" });
    gate.resolve();
    await expect(running).resolves.toBe("ok");
    expect(drain.inFlightCount).toBe(0);
  });

  it("rejects new work once draining has begun, without invoking the handler", async () => {
    const drain = new DrainCoordinator({ log: nullLog, drainTimeoutMs: 1_000 });
    await drain.drain();
    const fn = vi.fn();
    await expect(drain.run(meta, fn)).rejects.toBeInstanceOf(DrainingError);
    expect(fn).not.toHaveBeenCalled();
    expect(drain.accepting).toBe(false);
  });
});

describe("DrainCoordinator — normal drain", () => {
  it("waits for in-flight operations and reports a confirmed tx as resolved", async () => {
    const drain = new DrainCoordinator({ log: nullLog, drainTimeoutMs: 5_000 });
    const confirmation = deferred();

    const op = drain.run(meta, async (h) => {
      h.recordTx("0xabc");
      await confirmation.promise;
      return "confirmed";
    });

    const reportPromise = drain.drain();
    let settled = false;
    void reportPromise.then(() => (settled = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(settled).toBe(false); // still waiting on the confirmation

    confirmation.resolve();
    await expect(op).resolves.toBe("confirmed");
    const report = await reportPromise;
    expect(report).toMatchObject({
      inFlightAtStart: 1,
      completed: 1,
      failed: 0,
      timedOut: false,
      ambiguous: [],
      abandoned: [],
    });
  });

  it("resolves immediately when nothing is in flight", async () => {
    const drain = new DrainCoordinator({ log: nullLog, drainTimeoutMs: 60_000 });
    const report = await drain.drain();
    expect(report.inFlightAtStart).toBe(0);
    expect(report.timedOut).toBe(false);
  });

  it("reports a tx as ambiguous when the operation fails after submission during drain", async () => {
    const drain = new DrainCoordinator({ log: nullLog, drainTimeoutMs: 5_000 });
    const confirmation = deferred();
    const op = drain.run(meta, async (h) => {
      h.recordTx("0xdead");
      await confirmation.promise;
    });
    const reportPromise = drain.drain();
    confirmation.reject(new Error("socket closed"));
    await expect(op).rejects.toThrow("socket closed");
    const report = await reportPromise;
    expect(report.failed).toBe(1);
    expect(report.ambiguous).toHaveLength(1);
    expect(report.ambiguous[0]).toMatchObject({
      txHash: "0xdead",
      orderId: "42",
      reason: "failed_after_submission",
      error: "socket closed",
    });
  });

  it("does not accumulate failed-after-submit entries outside a drain", async () => {
    const drain = new DrainCoordinator({ log: nullLog, drainTimeoutMs: 1_000 });
    await expect(
      drain.run(meta, async (h) => {
        h.recordTx("0x1");
        throw new Error("reverted");
      })
    ).rejects.toThrow("reverted");
    const report = await drain.drain();
    expect(report.ambiguous).toEqual([]);
  });
});

describe("DrainCoordinator — deadline expiry", () => {
  it("reports submitted-but-unconfirmed txs as ambiguous and others as abandoned", async () => {
    vi.useFakeTimers();
    const records: AmbiguousTransaction[][] = [];
    const drain = new DrainCoordinator({
      log: nullLog,
      drainTimeoutMs: 1_000,
      sink: { record: async (e) => void records.push(e) },
    });

    const signals: AbortSignal[] = [];
    void drain
      .run(meta, async (h) => {
        signals.push(h.signal);
        h.recordTx("0xpending");
        await new Promise(() => {}); // confirmation never arrives
      })
      .catch(() => {});
    void drain
      .run({ chain: "stellar", action: "refund", orderId: "7" }, async (h) => {
        signals.push(h.signal);
        await new Promise(() => {}); // stuck before submitting
      })
      .catch(() => {});

    const reportPromise = drain.drain();
    await vi.advanceTimersByTimeAsync(1_000);
    const report = await reportPromise;

    expect(report.timedOut).toBe(true);
    expect(report.inFlightAtStart).toBe(2);
    expect(report.ambiguous).toHaveLength(1);
    expect(report.ambiguous[0]).toMatchObject({
      chain: "ethereum",
      txHash: "0xpending",
      orderId: "42",
      reason: "drain_deadline_exceeded",
    });
    expect(report.abandoned).toHaveLength(1);
    expect(report.abandoned[0]).toMatchObject({ chain: "stellar", orderId: "7", txHashes: [] });

    // Stragglers are told to give up.
    expect(signals.every((s) => s.aborted)).toBe(true);
    // Ambiguous txs are handed to the sink for reconciliation.
    expect(records).toHaveLength(1);
    expect(records[0][0].txHash).toBe("0xpending");
  });

  it("still returns a report when the sink fails", async () => {
    vi.useFakeTimers();
    const drain = new DrainCoordinator({
      log: nullLog,
      drainTimeoutMs: 100,
      sink: { record: async () => Promise.reject(new Error("disk full")) },
    });
    void drain.run(meta, async (h) => {
      h.recordTx("0x1");
      await new Promise(() => {});
    });
    const reportPromise = drain.drain();
    await vi.advanceTimersByTimeAsync(100);
    await expect(reportPromise).resolves.toMatchObject({ timedOut: true });
  });
});

describe("DrainCoordinator — repeated drain calls", () => {
  it("returns the same promise for every call", async () => {
    const drain = new DrainCoordinator({ log: nullLog, drainTimeoutMs: 1_000 });
    const a = drain.drain();
    const b = drain.drain();
    expect(a).toBe(b);
    await a;
  });
});

describe("ShutdownOrchestrator", () => {
  it("stops intake before draining and closes clients only after the drain", async () => {
    const order: string[] = [];
    const drain = new DrainCoordinator({ log: nullLog, drainTimeoutMs: 5_000 });
    const confirmation = deferred();
    const op = drain.run(meta, async (h) => {
      h.recordTx("0xabc");
      await confirmation.promise;
      order.push("tx-confirmed");
    });

    const orchestrator = new ShutdownOrchestrator(
      drain,
      {
        stopIntake: async () => {
          // Intake is already refused by the time listeners are torn down.
          expect(drain.accepting).toBe(false);
          order.push("intake-stopped");
        },
        closeClients: async () => {
          order.push("clients-closed");
        },
      },
      nullLog
    );

    const result = orchestrator.shutdown("SIGTERM");
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(["intake-stopped"]);

    confirmation.resolve();
    await op;
    const { report } = await result;
    expect(order).toEqual(["intake-stopped", "tx-confirmed", "clients-closed"]);
    expect(report.ambiguous).toEqual([]);
  });

  it("ignores repeated signals and runs the sequence exactly once", async () => {
    const drain = new DrainCoordinator({ log: nullLog, drainTimeoutMs: 1_000 });
    const stopIntake = vi.fn();
    const closeClients = vi.fn();
    const orchestrator = new ShutdownOrchestrator(drain, { stopIntake, closeClients }, nullLog);

    const first = orchestrator.shutdown("SIGTERM");
    const second = orchestrator.shutdown("SIGINT");
    const third = orchestrator.shutdown("SIGTERM");
    expect(second).toBe(first);
    expect(third).toBe(first);
    const result = await first;
    expect(result.signal).toBe("SIGTERM");
    expect(stopIntake).toHaveBeenCalledOnce();
    expect(closeClients).toHaveBeenCalledOnce();
  });

  it("continues draining and closing when stopping intake throws", async () => {
    const drain = new DrainCoordinator({ log: nullLog, drainTimeoutMs: 1_000 });
    const closeClients = vi.fn();
    const orchestrator = new ShutdownOrchestrator(
      drain,
      {
        stopIntake: () => {
          throw new Error("listener stop failed");
        },
        closeClients,
      },
      nullLog
    );
    await expect(orchestrator.shutdown("SIGTERM")).resolves.toBeDefined();
    expect(closeClients).toHaveBeenCalledOnce();
  });

  it("closes clients after the deadline even when a tx never confirms", async () => {
    vi.useFakeTimers();
    const drain = new DrainCoordinator({ log: nullLog, drainTimeoutMs: 500 });
    void drain.run(meta, async (h) => {
      h.recordTx("0xstuck");
      await new Promise(() => {});
    });
    const closeClients = vi.fn();
    const orchestrator = new ShutdownOrchestrator(
      drain,
      { stopIntake: vi.fn(), closeClients },
      nullLog
    );
    const result = orchestrator.shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(499);
    expect(closeClients).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const { report } = await result;
    expect(closeClients).toHaveBeenCalledOnce();
    expect(report.ambiguous.map((a) => a.txHash)).toEqual(["0xstuck"]);
  });
});

describe("createFileAmbiguousTxSink", () => {
  it("appends entries as JSON lines", async () => {
    const dir = await mkdtemp(join(tmpdir(), "drain-"));
    try {
      const path = join(dir, "ambiguous.jsonl");
      const sink = createFileAmbiguousTxSink(path);
      const entry: AmbiguousTransaction = {
        ...meta,
        operationId: 1,
        txHash: "0xabc",
        startedAt: 1,
        reportedAt: 2,
        reason: "drain_deadline_exceeded",
      };
      await sink.record([entry]);
      await sink.record([{ ...entry, txHash: "0xdef" }]);
      const lines = (await readFile(path, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
      expect(lines.map((l) => l.txHash)).toEqual(["0xabc", "0xdef"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveDrainTimeoutMs", () => {
  it("defaults when unset or invalid", () => {
    expect(resolveDrainTimeoutMs(undefined, 60_000)).toBe(DEFAULT_DRAIN_TIMEOUT_MS);
    expect(resolveDrainTimeoutMs("nope", 60_000)).toBe(DEFAULT_DRAIN_TIMEOUT_MS);
    expect(resolveDrainTimeoutMs("-5", 60_000)).toBe(DEFAULT_DRAIN_TIMEOUT_MS);
  });

  it("clamps below the hard shutdown timeout", () => {
    expect(resolveDrainTimeoutMs("3000", 15_000)).toBe(3_000);
    expect(resolveDrainTimeoutMs("60000", 15_000)).toBe(13_000);
  });
});
