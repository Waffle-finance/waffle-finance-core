import { describe, expect, it } from "vitest";

import { OrdersRepository } from "../src/persistence/orders-repo.js";
import { InMemoryRepositoryTransaction } from "../src/persistence/transaction-contract.js";

describe("repository transaction contract", () => {
  it("retries a transactional operation when a lock contention error is raised", async () => {
    const attempts: string[] = [];
    const tx = new InMemoryRepositoryTransaction({
      maxAttempts: 3,
      retryableErrors: ["SQLITE_BUSY"],
      run: async (op) => {
        attempts.push(op);
        if (attempts.length === 1) {
          throw new Error("SQLITE_BUSY");
        }
        return { ok: true };
      },
    });

    const result = await tx.runWithRetry("status-update", async () => ({ ok: true }));

    expect(result).toEqual({ ok: true });
    expect(attempts).toHaveLength(2);
  });

  it("wraps repository writes in a begin/commit/rollback boundary", async () => {
    const events: string[] = [];
    const repo = new OrdersRepository({
      prepare: () => ({
        run: () => ({ changes: 1, lastInsertRowid: 1 }),
        get: () => null,
        all: () => [],
      }),
    } as any);

    const tx = new InMemoryRepositoryTransaction({
      maxAttempts: 1,
      run: async (op) => {
        events.push(`begin:${op}`);
        try {
          await repo.setStatus("wf_0x123", "src_locked");
          events.push(`commit:${op}`);
          return { ok: true };
        } catch (error) {
          events.push(`rollback:${op}`);
          throw error;
        }
      },
    });

    await tx.runWithRetry("status-update", async () => {
      await repo.setStatus("wf_0x123", "src_locked");
    });

    expect(events).toContain("begin:status-update");
    expect(events).toContain("commit:status-update");
  });

  it("retries on SQLITE_BUSY: database is locked (node:sqlite format)", async () => {
    const attempts: string[] = [];
    const tx = new InMemoryRepositoryTransaction({
      maxAttempts: 3,
      run: async (op) => {
        attempts.push(op);
        if (attempts.length === 1) {
          throw new Error("SQLITE_BUSY: database is locked");
        }
        return { ok: true };
      },
    });

    const result = await tx.runWithRetry("status-update", async () => ({ ok: true }));
    expect(result).toEqual({ ok: true });
    expect(attempts).toHaveLength(2);
  });

  it("retries on SQLITE_LOCKED", async () => {
    const attempts: string[] = [];
    const tx = new InMemoryRepositoryTransaction({
      maxAttempts: 3,
      run: async (op) => {
        attempts.push(op);
        if (attempts.length === 1) {
          throw new Error("SQLITE_LOCKED");
        }
        return { ok: true };
      },
    });

    const result = await tx.runWithRetry("status-update", async () => ({ ok: true }));
    expect(result).toEqual({ ok: true });
    expect(attempts).toHaveLength(2);
  });

  it("does not retry on unrelated errors", async () => {
    const attempts: string[] = [];
    const tx = new InMemoryRepositoryTransaction({
      maxAttempts: 3,
      run: async (op) => {
        attempts.push(op);
        throw new Error("constraint violation");
      },
    });

    await expect(
      tx.runWithRetry("status-update", async () => ({ ok: true }))
    ).rejects.toThrow("constraint violation");
    expect(attempts).toHaveLength(1);
  });
});
