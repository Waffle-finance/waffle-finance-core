/**
 * Utilities for detecting whether the Solana HTLC program is configured
 * with a real address or still set to a placeholder value.
 *
 * When the program is a placeholder, Solana settlement flows must be
 * disabled so that operators are not surprised by silently-dropped swaps.
 */

export const SOLANA_PLACEHOLDER_VALUES: ReadonlySet<string> = new Set([
  "PLACEHOLDER",
  "YOUR_SOLANA_HTLC_PROGRAM",
  "YOUR_SOLANA_PROGRAM",
  "YOUR_PROGRAM_ID",
  // Solana system program address — the all-ones pubkey is never a valid
  // HTLC program; treat it as unconfigured.
  "11111111111111111111111111111111",
]);

/**
 * Returns `true` when `programId` looks like a placeholder and Solana
 * flows should be disabled.  The check is intentionally broad:
 *
 *  - undefined or blank → placeholder
 *  - matches any entry in SOLANA_PLACEHOLDER_VALUES (case-insensitive) → placeholder
 *  - contains the word "PLACEHOLDER" (case-insensitive) → placeholder
 *  - starts with "YOUR_" (case-insensitive) → placeholder
 */
export function isSolanaPlaceholder(programId: string | undefined): boolean {
  if (!programId || programId.trim() === "") return true;
  const upper = programId.trim().toUpperCase();
  for (const known of SOLANA_PLACEHOLDER_VALUES) {
    if (upper === known) return true;
  }
  return upper.includes("PLACEHOLDER") || upper.startsWith("YOUR_");
}

export type SolanaConfigStatus = "placeholder" | "configured";

/**
 * Returns `"placeholder"` when the program ID is unset or a placeholder
 * value, and `"configured"` when it looks like a real program address.
 */
export function checkSolanaConfig(programId: string | undefined): SolanaConfigStatus {
  return isSolanaPlaceholder(programId) ? "placeholder" : "configured";
}

/**
 * Checks the Solana program ID, logs an appropriate message, and returns
 * the config status.  Call this at relayer startup so operators see an
 * explicit warning when Solana is not yet configured.
 */
export function logSolanaStatus(programId: string | undefined): SolanaConfigStatus {
  const status = checkSolanaConfig(programId);
  if (status === "placeholder") {
    console.warn(
      "[SOLANA] ⚠️  SOLANA_HTLC_PROGRAM is a placeholder — Solana settlement flows are DISABLED.\n" +
      "[SOLANA]    Set SOLANA_HTLC_PROGRAM_TESTNET or SOLANA_HTLC_PROGRAM_MAINNET to a real " +
      "program address to enable Solana support."
    );
  } else {
    const preview = programId!.length > 16 ? programId!.substring(0, 16) + "…" : programId!;
    console.log(`[SOLANA] ✅ Solana HTLC program configured: ${preview}`);
  }
  return status;
}
