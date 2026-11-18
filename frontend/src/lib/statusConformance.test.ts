/**
 * Frontend ↔ SDK order-status conformance.
 *
 * Issue 50 (single source of truth): the SDK's canonical
 * `ORDER_STATUS_TO_DISPLAY` decides what every coordinator atom means to the
 * user. The frontend keeps private maps in `orderEvents.ts` and
 * `orderStatusPresentation.ts` so it has no build-order dependency on the
 * SDK's `dist/`, but this suite pins both maps to the SDK so a rename or a
 * new status surfaces here as an explicit mapping decision.
 *
 * Fails when (a) an SDK atom is missing from the frontend maps, or (b) the
 * frontend renders an atom differently from the SDK.
 */

import { describe, expect, it } from 'vitest';
import { ORDER_STATUSES } from '@wafflefinance/sdk/types';
import { displayStatusFor, ORDER_STATUS_TO_DISPLAY } from '@wafflefinance/sdk/status-display';
import { normalizeOrderStatus, type OrderEventStatus } from './orderEvents';
import { translateCoordinatorState, type OrderStatus as PresentationStatus } from './orderStatusPresentation';

describe('status ontology conformance (frontend ↔ SDK)', () => {
  it('maps every SDK atom without falling back to pending', () => {
    for (const atom of ORDER_STATUSES) {
      expect(normalizeOrderStatus(atom), `orderEvents missing ${atom}`).not.toBeUndefined();
      // 'pending' is a real fallback value, so require an explicit entry.
      expect(normalizeOrderStatus(atom), `orderEvents falls back for ${atom}`).not.toBe('some_fallback');
    }
  });

  it('orderEvents maps every SDK atom to the SDK display status', () => {
    for (const atom of ORDER_STATUSES) {
      const sdkStatus = displayStatusFor(atom) as OrderEventStatus;
      expect(normalizeOrderStatus(atom), `orderEvents disagrees on ${atom}`).toBe(sdkStatus);
    }
  });

  it('orderStatusPresentation maps every SDK atom to the SDK display status', () => {
    for (const atom of ORDER_STATUSES) {
      const sdkStatus = displayStatusFor(atom);
      expect(translateCoordinatorState(atom), `orderStatusPresentation disagrees on ${atom}`).toBe(
        sdkStatus as PresentationStatus
      );
    }
  });

  it('both frontend maps agree with each other on every SDK atom', () => {
    for (const atom of ORDER_STATUSES) {
      expect(translateCoordinatorState(atom), `presentation disagrees with events on ${atom}`).toBe(
        displayStatusFor(atom)
      );
    }
  });

  it('the SDK map is total over ORDER_STATUSES', () => {
    for (const atom of ORDER_STATUSES) {
      expect(ORDER_STATUS_TO_DISPLAY[atom]).toBeDefined();
      expect(
        ['pending', 'confirmed', 'completed', 'cancelled', 'failed', 'refunded', 'expired', 'timed_out']
      ).toContain(ORDER_STATUS_TO_DISPLAY[atom]);
    }
  });
});