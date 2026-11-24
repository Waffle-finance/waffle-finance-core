import { loadCoordinatorConfig } from "@wafflefinance/config/node";
import type { CoordinatorConfig } from "@wafflefinance/config";
import {
  isSolanaPlaceholder,
  checkSolanaConfig,
  logSolanaStatus,
  SOLANA_PLACEHOLDER_VALUES,
} from "@wafflefinance/config";

export type { CoordinatorConfig };
export type Network = "testnet" | "mainnet";
export { isSolanaPlaceholder, checkSolanaConfig, logSolanaStatus, SOLANA_PLACEHOLDER_VALUES };

/**
 * Structured configuration error describing which field failed validation
 * and an actionable reason. Secret values are never included in the message.
 */
export interface ConfigValidationIssue {
  field: string;
  reason: string;
}

/**
 * Error thrown when coordinator configuration fails validation. Carries a
 * structured list of issues so callers can report every problem at once
 * before any listener is created.
 */
export class CoordinatorConfigError extends Error {
  readonly issues: ConfigValidationIssue[];

  constructor(issues: ConfigValidationIssue[]) {
    const summary = issues
      .map((issue) => `${issue.field}: ${issue.reason}`)
      .join("; ");
    super(`Invalid coordinator configuration: ${summary}`);
    this.name = "CoordinatorConfigError";
    this.issues = issues;
  }
}

/**
 * Normalize whatever the shared validator returns into a structured list of
 * issues. The shared validator may throw, return an array of issues, or
 * return an object with an `issues` array. All paths are handled here so the
 * coordinator surfaces consistent, redacted errors.
 */
function normalizeIssues(error: unknown): ConfigValidationIssue[] {
  if (error instanceof CoordinatorConfigError) {
    return error.issues;
  }

  const raw = error as
    | { issues?: unknown; field?: unknown; reason?: unknown; message?: unknown }
    | undefined;

  if (raw && Array.isArray(raw.issues)) {
    return raw.issues.map((issue) => {
      const item = issue as { field?: unknown; reason?: unknown; message?: unknown };
      return {
        field: typeof item.field === "string" ? item.field : "unknown",
        reason:
          typeof item.reason === "string"
            ? item.reason
            : typeof item.message === "string"
              ? item.message
              : "invalid value",
      };
    });
  }

  if (raw && typeof raw.field === "string") {
    return [
      {
        field: raw.field,
        reason:
          typeof raw.reason === "string"
            ? raw.reason
            : typeof raw.message === "string"
              ? raw.message
              : "invalid value",
      },
    ];
  }

  const message =
    raw && typeof raw.message === "string"
      ? raw.message
      : typeof error === "string"
        ? error
        : "configuration validation failed";

  return [{ field: "config", reason: message }];
}

/**
 * Load and validate coordinator configuration. The shared
 * `loadCoordinatorConfig` performs cross-field validation (network mode vs
 * chain ID, contract addresses, etc.). Any validation failure is surfaced as
 * a structured, redacted `CoordinatorConfigError` so startup can be aborted
 * before listeners bind a port.
 */
export function loadConfig(): CoordinatorConfig {
  try {
    return loadCoordinatorConfig();
  } catch (error) {
    throw new CoordinatorConfigError(normalizeIssues(error));
  }
}