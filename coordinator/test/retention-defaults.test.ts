import { afterEach, describe, expect, it, vi } from "vitest";
import pino from "pino";
import type { OrdersRepository } from "../src/persistence/orders-repo.js";
import { ArchivalPolicy } from "../src/archival/archival-policy.js";
import { StaleCleanupService } from "../src/services/stale-cleanup.js";

const log = pino({ level: "silent" });
const retentionSeconds = 30 * 24 * 60 * 60;

describe("documented retention defaults", () => {
  afterEach(() => vi.restoreAllMocks());

  it("both default services select with a 30-day retention window", async () => {
    const findStaleAnnounced = vi.fn().mockResolvedValue([]);
    const repo = { findStaleAnnounced } as unknown as OrdersRepository;
    await new StaleCleanupService(repo, log).run();
    await new ArchivalPolicy(repo, log).runArchival();
    expect(findStaleAnnounced.mock.calls).toEqual([[retentionSeconds], [retentionSeconds]]);
  });

  it("the default archival cutoff excludes exactly 30 days and includes older orders", () => {
    const now = 1_800_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now * 1000);
    const policy = new ArchivalPolicy({} as OrdersRepository, log);
    const order = { status: "announced", srcOrderId: null, archivedAt: null,
      createdAt: now - retentionSeconds };
    expect(policy.isArchivalWorthy(order)).toBe(false);
    expect(policy.isArchivalWorthy({ ...order, createdAt: order.createdAt - 1 })).toBe(true);
  });

  it("both default services limit each batch to 100 orders", async () => {
    const candidates = Array.from({ length: 101 }, (_, i) => ({
      publicId: `order-${i}`, direction: "eth_to_xlm", createdAt: 1,
    }));
    const repo = {
      findStaleAnnounced: vi.fn().mockResolvedValue(candidates),
      abandonOrder: vi.fn().mockResolvedValue(undefined),
      archiveOrder: vi.fn().mockResolvedValue(undefined),
    };
    await new StaleCleanupService(repo as unknown as OrdersRepository, log).run();
    await new ArchivalPolicy(repo as unknown as OrdersRepository, log).runArchival();
    expect(repo.abandonOrder).toHaveBeenCalledTimes(100);
    expect(repo.archiveOrder).toHaveBeenCalledTimes(100);
  });
});
