/**
 * Mock-data fallback boundary for bridge order processing (issue #959).
 *
 * Mock data may only ever mask a failed production API response when the
 * explicit development flag (`VITE_ENABLE_MOCK_DATA=true`) is set AND the
 * build is not a production build. In every other case a real API error must
 * remain visible to the user as a failure.
 *
 * Both `BridgeFormContainer` failure branches (non-OK response and thrown
 * error) funnel through `resolveProcessingFailureOutcome` so the boundary
 * lives in one testable place instead of two inline `if` statements.
 */

export type ProcessingFailureOutcome =
  /** Show mock success despite the API failure (dev only). */
  | 'mock-success'
  /** Surface the real API error to the user. */
  | 'report-failure';

export function resolveProcessingFailureOutcome(opts: {
  /** Value of `selectIsMockDataEnabled()` (i.e. `VITE_ENABLE_MOCK_DATA`). */
  enableMockData: boolean;
  /** `import.meta.env.PROD` — true for production builds. */
  isProductionBuild: boolean;
}): ProcessingFailureOutcome {
  if (opts.enableMockData && !opts.isProductionBuild) return 'mock-success';
  return 'report-failure';
}
