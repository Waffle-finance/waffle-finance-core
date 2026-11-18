/**
 * Solana resolver listener configuration resolution (issue #949).
 *
 * Selects exactly one of three behaviors from the configured program ID
 * without performing any RPC call:
 *
 * - `disabled`   — empty or placeholder program ID: the listener stays down
 *   and must never appear as a healthy live integration.
 * - `simulation` — simulation/mock mode forced: no on-chain client is used.
 * - `live`       — a syntactically valid program ID: the mocked live-client
 *   path may be reached.
 *
 * A malformed (non-placeholder, non-decodable) program ID throws before
 * listener startup so misconfiguration fails fast instead of surfacing as
 * opaque poll errors at runtime.
 */

import { PublicKey } from "@solana/web3.js";

export type SolanaListenerMode = "disabled" | "simulation" | "live";

export interface SolanaListenerConfigResolution {
  mode: SolanaListenerMode;
  /** True only for `live`. Placeholder/simulation configs are never ready. */
  ready: boolean;
  /** Human-readable reason for the selected mode (operator logs). */
  reason: string;
}

/**
 * Returns true when `programId` is unset or a placeholder value, mirroring
 * the coordinator's placeholder detection so all services agree on what
 * counts as "not yet configured".
 */
export function isSolanaProgramIdPlaceholder(programId: string | undefined): boolean {
  if (!programId || programId.trim() === "") return true;
  const upper = programId.trim().toUpperCase();
  const known = new Set([
    "PLACEHOLDER",
    "YOUR_SOLANA_HTLC_PROGRAM",
    "YOUR_SOLANA_PROGRAM",
    "YOUR_PROGRAM_ID",
    // Solana system program address — the all-ones pubkey is never a valid
    // HTLC program; treat it as unconfigured.
    "11111111111111111111111111111111",
  ]);
  for (const k of known) {
    if (upper === k) return true;
  }
  return upper.includes("PLACEHOLDER") || upper.startsWith("YOUR_");
}

/**
 * Resolve the Solana listener mode. Throws on a malformed program ID so the
 * caller fails before listener startup. Never touches the network.
 */
export function resolveSolanaListenerConfig(opts: {
  programId?: string;
  /** Forces simulation/mock mode even with a valid program ID (testing). */
  simulationMode?: boolean;
}): SolanaListenerConfigResolution {
  const { programId, simulationMode = false } = opts;

  if (isSolanaProgramIdPlaceholder(programId)) {
    return {
      mode: "disabled",
      ready: false,
      reason: "SOLANA_HTLC_PROGRAM is a placeholder — Solana listener disabled",
    };
  }

  if (simulationMode) {
    return {
      mode: "simulation",
      ready: false,
      reason: "simulation mode forced — Solana listener running against mocks",
    };
  }

  let trimmed: string;
  try {
    trimmed = programId!.trim();
    // Throws on malformed base58 / wrong length — fail before startup.
    new PublicKey(trimmed);
  } catch {
    throw new Error(
      `Invalid SOLANA_HTLC_PROGRAM "${programId}": not a decodable Solana address — refusing listener startup`
    );
  }

  return {
    mode: "live",
    ready: true,
    reason: `Solana HTLC program configured: ${trimmed.length > 16 ? trimmed.substring(0, 16) + "…" : trimmed}`,
  };
}
