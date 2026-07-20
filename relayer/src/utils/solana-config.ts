/**
 * Re-exports the canonical Solana placeholder detection utilities from
 * the shared `@wafflefinance/config` package.
 *
 * All services (coordinator, relayer, resolver) should import from
 * `@wafflefinance/config` directly when possible.  This re-export exists
 * so existing relayer-internal imports (`./utils/solana-config`) continue
 * to work without changes.
 */
export {
  SOLANA_PLACEHOLDER_VALUES,
  isSolanaPlaceholder,
  checkSolanaConfig,
  logSolanaStatus,
  type SolanaConfigStatus,
} from "@wafflefinance/config";
