/**
 * Order status presentation layer (issues #317, #279).
 *
 * This module is the single mapping between the bridge lifecycle's internal
 * state representation and what the user sees. The UI never performs raw
 * string comparisons against coordinator state names; instead it calls
 * `presentOrderStatus` and renders the stable UX fields it returns.
 *
 * `translateCoordinatorState` converts raw backend state strings (announced,
 * src_locked, dst_locked, etc.) into the normalised `OrderStatus` enum used
 * by the frontend Transaction model. This means the coordinator can move
 * between internal phases without the UI needing to enumerate every state.
 *
 * `presentCoordinatorPhase` provides a richer, per-coordinator-state label
 * and description for surfaces that want to surface the granular lifecycle
 * step (e.g. a detail panel or tooltip). The coarser `presentOrderStatus` is
 * still used for badge colours and terminal-state logic.
 */

export type OrderStatus =
  | 'pending'
  | 'completed'
  | 'confirmed'
  | 'cancelled'
  | 'failed'
  | 'refunded'
  | 'expired'
  | 'timed_out';

/**
 * Stable, user-facing lifecycle phases.
 *
 * These phases are intentionally coarser than the coordinator's internal
 * state machine so that short-lived intermediary coordinator states (e.g.
 * dst_locked → secret_revealed) do not cause flicker in the UI.
 */
export type UxPhase =
  | 'initiated'
  | 'source_locked'
  | 'destination_locked'
  | 'settling'
  | 'completed'
  | 'failed'
  | 'refunded'
  | 'expired';

export interface OrderStatusPresentation {
  phase: UxPhase;
  /** Short label shown in the status badge (e.g. "Pending", "Completed"). */
  label: string;
  /** One-sentence description shown below the badge or in a tooltip. */
  description: string;
  /** Tailwind utility classes for the status badge color. */
  colorClass: string;
  /** Icon name — the component maps this to a Lucide icon. */
  iconName: 'clock' | 'check-circle' | 'x-circle' | 'undo' | 'alert-triangle';
  /** When true the order has reached a terminal state (no more transitions). */
  isTerminal: boolean;
  /** Optional guidance for the user when the order needs attention. */
  recoveryMessage?: string;
}

/**
 * Granular per-coordinator-state label and description.
 * Used by detail panels and tooltips that want to show the exact lifecycle
 * step rather than the coarser badge label.
 */
export interface CoordinatorPhasePresentation {
  /** Short human-readable label for this coordinator state. */
  stepLabel: string;
  /** One-sentence explanation of what is happening right now. */
  stepDescription: string;
  /** When the user should take action (empty string = no action needed). */
  userAction: string;
}

// ── Raw coordinator → normalised OrderStatus ──────────────────────────────────

/**
 * Raw coordinator → normalised OrderStatus.
 *
 * This map mirrors the SDK's canonical `ORDER_STATUS_TO_DISPLAY`
 * (`@wafflefinance/sdk/status-display`); the conformance suite
 * (`statusConformance.test.ts`) pins it to that table so the presentation
 * layer and the rest of the UI agree on what each coordinator atom means.
 */
const COORDINATOR_STATE_MAP: Record<string, OrderStatus> = {
  announced:       'pending',
  src_locked:      'pending',
  dst_locked:      'confirmed',
  secret_revealed: 'confirmed',
  claim_pending:   'pending',
  processing:      'pending',
  pending:         'pending',
  completed:       'completed',
  confirmed:       'confirmed',
  cancelled:       'cancelled',
  failed:          'failed',
  expired:         'expired',
  timed_out:       'timed_out',
  refunded:        'refunded',
  abandoned:       'cancelled',
};

/**
 * Map a raw coordinator lifecycle state string to the normalised `OrderStatus`
 * value used by the frontend.
 *
 * Unknown states default to `'pending'` so partial or future coordinator
 * states never produce an undefined value in the UI.
 */
export function translateCoordinatorState(raw: string): OrderStatus {
  if (!raw || typeof raw !== 'string') return 'pending';
  return COORDINATOR_STATE_MAP[raw.toLowerCase()] ?? 'pending';
}

// ── Coordinator state → granular UX step ─────────────────────────────────────

/**
 * Translate a raw coordinator lifecycle state string into a granular step
 * label and description for detail panels or tooltips.
 *
 * This intentionally exposes finer-grained messaging than `presentOrderStatus`
 * so users can understand exactly where their swap is in the pipeline.
 */
export function presentCoordinatorPhase(raw: string): CoordinatorPhasePresentation {
  const state = raw?.toLowerCase() ?? '';

  switch (state) {
    case 'announced':
      return {
        stepLabel: 'Awaiting source lock',
        stepDescription:
          'Your swap has been announced to the coordinator. Waiting for you to lock funds on the source chain.',
        userAction: 'Lock your funds on the source chain to proceed.',
      };

    case 'src_locked':
      return {
        stepLabel: 'Source locked',
        stepDescription:
          'Your funds are locked in the HTLC on the source chain. The resolver is now locking the destination funds.',
        userAction: '',
      };

    case 'dst_locked':
      return {
        stepLabel: 'Destination locked',
        stepDescription:
          'The resolver has locked the destination funds. Waiting for the preimage to be revealed to claim.',
        userAction: '',
      };

    case 'secret_revealed':
      return {
        stepLabel: 'Secret revealed',
        stepDescription:
          'The preimage has been revealed on-chain. Claim transactions are being submitted on both legs.',
        userAction: '',
      };

    case 'claim_pending':
      return {
        stepLabel: 'Claim in progress',
        stepDescription:
          'The claim transaction is pending confirmation on the destination chain.',
        userAction: '',
      };

    case 'processing':
      return {
        stepLabel: 'Processing',
        stepDescription:
          'The coordinator is finalising settlement. Both legs should confirm shortly.',
        userAction: '',
      };

    case 'completed':
      return {
        stepLabel: 'Completed',
        stepDescription: 'Both legs have settled successfully. Your swap is complete.',
        userAction: '',
      };

    case 'confirmed':
      return {
        stepLabel: 'Confirmed',
        stepDescription:
          'Settlement has been confirmed on both chains. No further action needed.',
        userAction: '',
      };

    case 'cancelled':
      return {
        stepLabel: 'Cancelled',
        stepDescription:
          'This swap was cancelled before funds were locked on-chain.',
        userAction: '',
      };

    case 'abandoned':
      return {
        stepLabel: 'Cancelled',
        stepDescription:
          'This swap was dropped because the source funds were never locked on-chain.',
        userAction: '',
      };

    case 'failed':
      return {
        stepLabel: 'Failed',
        stepDescription:
          'An error occurred during processing. If funds were locked you may claim a refund.',
        userAction: 'Use the Refund action below to reclaim any locked funds.',
      };

    case 'expired':
      return {
        stepLabel: 'Timelock expired',
        stepDescription:
          'The HTLC timelock expired before settlement completed. Locked funds are now eligible for refund.',
        userAction: 'Use the Refund action below to reclaim your locked funds.',
      };

    case 'timed_out':
      return {
        stepLabel: 'Coordinator timed out',
        stepDescription:
          'The coordinator did not complete settlement within the expected window. Locked funds can be refunded.',
        userAction: 'Use the Refund action below to reclaim your locked funds.',
      };

    case 'refunded':
      return {
        stepLabel: 'Refunded',
        stepDescription: 'Your locked funds have been returned to your source wallet.',
        userAction: '',
      };

    default:
      return {
        stepLabel: 'Processing',
        stepDescription:
          'Transaction is in progress. The coordinator has not reported a final status yet.',
        userAction: '',
      };
  }
}

// ── OrderStatus → UX presentation ────────────────────────────────────────────

/**
 * Translate a normalised `OrderStatus` into a stable UX representation.
 *
 * This is the only place in the frontend that maps status values to colours,
 * labels, and recovery messages. All rendering surfaces (TransactionHistory,
 * order detail panels) must go through this function rather than performing
 * their own status-to-string translations.
 */
export function presentOrderStatus(status: OrderStatus): OrderStatusPresentation {
  switch (status) {
    case 'pending':
      return {
        phase: 'initiated',
        label: 'Pending',
        description: 'Your swap is being processed. Waiting for on-chain confirmation across both legs.',
        colorClass: 'text-yellow-400 bg-yellow-500/20',
        iconName: 'clock',
        isTerminal: false,
      };

    case 'confirmed':
      return {
        phase: 'completed',
        label: 'Confirmed',
        description: 'Your swap has been confirmed on both chains. Funds delivered successfully.',
        colorClass: 'text-green-400 bg-green-500/20',
        iconName: 'check-circle',
        isTerminal: true,
      };

    case 'completed':
      return {
        phase: 'completed',
        label: 'Completed',
        description: 'Your swap has settled successfully. Destination funds are in your wallet.',
        colorClass: 'text-green-400 bg-green-500/20',
        iconName: 'check-circle',
        isTerminal: true,
      };

    case 'cancelled':
      return {
        phase: 'failed',
        label: 'Cancelled',
        description: 'This swap was cancelled before any funds were locked on-chain.',
        colorClass: 'text-gray-400 bg-gray-500/20',
        iconName: 'x-circle',
        isTerminal: true,
      };

    case 'failed':
      return {
        phase: 'failed',
        label: 'Failed',
        description: 'This swap encountered an error during processing. Locked funds can be reclaimed.',
        colorClass: 'text-red-400 bg-red-500/20',
        iconName: 'x-circle',
        isTerminal: true,
        recoveryMessage: 'If funds were locked on-chain you may be eligible for a refund.',
      };

    case 'refunded':
      return {
        phase: 'refunded',
        label: 'Refunded',
        description: 'Your locked funds have been returned to your source wallet.',
        colorClass: 'text-emerald-400 bg-emerald-500/20',
        iconName: 'undo',
        isTerminal: true,
      };

    case 'expired':
      return {
        phase: 'expired',
        label: 'Expired',
        description: 'The HTLC timelock expired without settlement. Your locked funds are ready to refund.',
        colorClass: 'text-orange-400 bg-orange-500/20',
        iconName: 'clock',
        isTerminal: true,
        recoveryMessage: 'You may reclaim your locked funds using the Refund action below.',
      };

    case 'timed_out':
      return {
        phase: 'expired',
        label: 'Timed out',
        description:
          'The coordinator did not complete settlement within the expected timelock window. Use Refund to reclaim locked funds.',
        colorClass: 'text-orange-400 bg-orange-500/20',
        iconName: 'clock',
        isTerminal: true,
        recoveryMessage: 'You may reclaim your locked funds using the Refund action below.',
      };

    default: {
      // Exhaustive guard — unknown status from a future coordinator version.
      const _exhaustive: never = status;
      void _exhaustive;
      return {
        phase: 'initiated',
        label: 'Unknown',
        description: 'Transaction status is not yet available. Please refresh.',
        colorClass: 'text-gray-400 bg-gray-500/20',
        iconName: 'clock',
        isTerminal: false,
      };
    }
  }
}
