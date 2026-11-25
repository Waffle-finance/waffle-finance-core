/**
 * Test-only stub for @wormhole/config.
 *
 * The real package is an optional external SDK dependency only used in the
 * SDK's config-validation layer. The coordinator's tests do not exercise any
 * code path that calls these functions at runtime — they appear in the
 * import chain because vitest resolves @wafflefinance/sdk to source.
 *
 * This stub exports the minimal surface that config-validation.ts imports so
 * the module graph resolves without the actual package installed.
 */

export type ConfigIssueCode =
  | "INVALID_RPC_URL"
  | "INVALID_ADDRESS"
  | "INVALID_NETWORK_MODE"
  | "INVALID_CHAIN_ID"
  | "MISSING_REQUIRED_FIELD"
  | "INVALID_VALUE";

export interface ConfigIssue {
  code: ConfigIssueCode;
  field: string;
  message: string;
}

export type NetworkMode = "mainnet" | "testnet";

export class ConfigValidationError extends Error {
  readonly issues: ReadonlyArray<ConfigIssue>;
  constructor(message: string, issues: ReadonlyArray<ConfigIssue>) {
    super(message);
    this.name = "ConfigValidationError";
    this.issues = issues;
  }
}

export function isSecretFieldName(_name: string): boolean {
  return false;
}

export function redactSecretValue(value: unknown): unknown {
  return value;
}

export function validateAddressFormat(
  _chain: string,
  _address: string,
  _issues: ConfigIssue[],
): void {
  // no-op stub
}

export function validateNetworkModeChainId(
  _mode: NetworkMode,
  _chainId: number,
  _issues: ConfigIssue[],
): void {
  // no-op stub
}
