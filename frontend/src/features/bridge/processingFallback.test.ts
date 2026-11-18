/**
 * Boundary test: mock data must never mask production API errors (#959).
 *
 * Covers the mock-data service branch used by `BridgeFormContainer`:
 *  - enabled flag + development build → mock success path (local dev only)
 *  - disabled flag → the real API error stays visible as a failure
 *  - production build → the real API error stays visible even if the flag
 *    were somehow set (production never silently substitutes mock orders)
 *  - the flag's default matches documentation (off)
 *
 * No live API is required: the branch decision is a pure function of the
 * explicit flag and the build mode.
 */

import { describe, expect, it } from 'vitest';
import { resolveProcessingFailureOutcome } from './processingFallback';
import { selectIsMockDataEnabled } from '../../config/selectors';

describe('resolveProcessingFailureOutcome — mock data boundary', () => {
  it('uses mock success only when the explicit dev flag is enabled (local mode)', () => {
    expect(
      resolveProcessingFailureOutcome({ enableMockData: true, isProductionBuild: false })
    ).toBe('mock-success');
  });

  it('keeps the real API error visible when mocks are disabled', () => {
    expect(
      resolveProcessingFailureOutcome({ enableMockData: false, isProductionBuild: false })
    ).toBe('report-failure');
  });

  it('keeps the real API error visible in production builds when mocks are disabled', () => {
    expect(
      resolveProcessingFailureOutcome({ enableMockData: false, isProductionBuild: true })
    ).toBe('report-failure');
  });

  it('never substitutes mock orders in production, even if the flag is set', () => {
    expect(
      resolveProcessingFailureOutcome({ enableMockData: true, isProductionBuild: true })
    ).toBe('report-failure');
  });

  it('flag defaults to off, matching documentation', () => {
    expect(selectIsMockDataEnabled()).toBe(false);
  });
});
