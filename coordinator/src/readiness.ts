import type { CoordinatorConfig } from "./config.js";
import type { Database } from "./persistence/db.js";
import type { ReconciliationStatus } from "./reconciliation/reconciler.js";
import type { ReadinessCheck } from "./server/routes/health.js";

type FetchLike = (
  url: string,
  init: {
    method: "POST";
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal;
  }
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export interface ReadinessDeps {
  cfg: CoordinatorConfig;
  db: Database;
  getReconciliationStatus: () => ReconciliationStatus;
  fetcher?: FetchLike;
  timeoutMs?: number;
}

async function timedCheck(name: string, probe: () => Promise<void>): Promise<ReadinessCheck> {
  const startedAt = Date.now();
  try {
    await probe();
    return { name, ok: true, latencyMs: Date.now() - startedAt };
  } catch {
    return {
      name,
      ok: false,
      detail: "unavailable",
      latencyMs: Date.now() - startedAt
    };
  }
}

async function probeDatabase(db: Database): Promise<void> {
  const stmt = db.prepare("SELECT 1 AS ok");
  if ("getAsync" in stmt && typeof stmt.getAsync === "function") {
    await stmt.getAsync();
    return;
  }
  stmt.get();
}

async function probeJsonRpc(
  fetcher: FetchLike,
  url: string,
  method: string,
  timeoutMs: number
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error("rpc_http_error");
    }

    const body = (await response.json()) as { error?: unknown };
    if (body?.error) {
      throw new Error("rpc_error");
    }
  } finally {
    clearTimeout(timeout);
  }
}

function reconciliationCheck(status: ReconciliationStatus): ReadinessCheck {
  if (status.lastRunOk === false) {
    return { name: "reconciliation", ok: false, detail: "last_run_failed" };
  }

  return {
    name: "reconciliation",
    ok: true,
    detail: status.lastRunAt ? "last_run_ok" : "not_run_yet"
  };
}

export function createReadinessChecks({
  cfg,
  db,
  getReconciliationStatus,
  fetcher = globalThis.fetch as FetchLike,
  timeoutMs = 750
}: ReadinessDeps): () => Promise<ReadinessCheck[]> {
  return async () => [
    await timedCheck("database", () => probeDatabase(db)),
    await timedCheck("ethereum_rpc", () =>
      probeJsonRpc(fetcher, cfg.ethereum.rpcUrl, "eth_blockNumber", timeoutMs)
    ),
    await timedCheck("soroban_rpc", () =>
      probeJsonRpc(fetcher, cfg.soroban.rpcUrl, "getHealth", timeoutMs)
    ),
    await timedCheck("solana_rpc", () =>
      probeJsonRpc(fetcher, cfg.solana.rpcUrl, "getHealth", timeoutMs)
    ),
    reconciliationCheck(getReconciliationStatus())
  ];
}
