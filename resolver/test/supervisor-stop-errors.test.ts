import { describe, it, expect, vi } from "vitest";
import pino from "pino";
import { Supervisor } from "../src/supervisor.js";
import { ResolverLifecycle } from "../src/lifecycle.js";

const nullLog = pino({ level: "silent" });

describe("Supervisor.stopAll — listener stop errors", () => {
  it("attempts every listener stop even when one rejects", async () => {
    const supervisor = new Supervisor({ log: nullLog });
    const firstStop = vi.fn().mockRejectedValueOnce(new Error("rpc disconnect"));
    const secondStop = vi.fn().mockResolvedValueOnce(undefined);

    await expect(
      supervisor.stopAll([
        { start: vi.fn(), stop: firstStop },
        { start: vi.fn(), stop: secondStop },
      ]),
    ).rejects.toThrow("rpc disconnect");

    expect(firstStop).toHaveBeenCalledOnce();
    expect(secondStop).toHaveBeenCalledOnce();
  });

  it("reports cleanup failure via failed lifecycle/health state", async () => {
    const lifecycle = new ResolverLifecycle(nullLog);
    lifecycle.transition("starting");
    lifecycle.transition("running");
    lifecycle.transition("stopping");
    const supervisor = new Supervisor({ log: nullLog, lifecycle });
    const failing = { start: vi.fn(), stop: vi.fn().mockRejectedValue(new Error("boom")) };
    const healthy = { start: vi.fn(), stop: vi.fn().mockResolvedValue(undefined) };

    await expect(supervisor.stopAll([failing, healthy])).rejects.toThrow();
    expect(healthy.stop).toHaveBeenCalledOnce();
    expect(lifecycle.state).toBe("failed");
    expect(supervisor.lifecycleState).toBe("failed");
    expect(supervisor.state).toBe("failed");
  });

  it("does not emit an unhandled rejection", async () => {
    const supervisor = new Supervisor({ log: nullLog });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      await expect(
        supervisor.stopAll([
          { start: vi.fn(), stop: vi.fn().mockRejectedValue(new Error("stop exploded")) },
          { start: vi.fn(), stop: vi.fn().mockResolvedValue(undefined) },
        ]),
      ).rejects.toThrow("stop exploded");
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).toHaveLength(0);
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });
});
