import type { OrderStatus } from "../types/index.js";

export type DisplayStatus =
  | "pending"
  | "confirmed"
  | "completed"
  | "cancelled"
  | "failed"
  | "refunded"
  | "expired"
  | "timed_out";

export interface StatusDisplay {
  status: DisplayStatus;
  label: string;
  shortLabel: string;
  message: string;
  action: string;
  tone: "neutral" | "info" | "success" | "warning" | "error";
}

const STATUS_DISPLAY: Record<DisplayStatus, StatusDisplay> = {
  pending: {
    status: "pending",
    label: "Pending",
    shortLabel: "Pending",
    message:
      "Your cross-chain transfer is in progress. The system is waiting for confirmations before the next step can proceed.",
    action: "No action needed. Most transfers complete within a few minutes. Refresh this page to check for updates.",
    tone: "info",
  },
  confirmed: {
    status: "confirmed",
    label: "Confirmed",
    shortLabel: "Confirmed",
    message:
      "Your funds are locked on both sides of the swap and settlement can no longer be cancelled. The transfer is finishing its final confirmations.",
    action: "No action needed. Final confirmation usually lands within a few minutes — refresh this page to check for updates.",
    tone: "info",
  },
  completed: {
    status: "completed",
    label: "Completed",
    shortLabel: "Completed",
    message:
      "Your cross-chain transfer is complete. The destination funds have been delivered to your wallet and the transaction is confirmed.",
    action: "No further action is required. You can verify the transaction using the block explorer link.",
    tone: "success",
  },
  cancelled: {
    status: "cancelled",
    label: "Cancelled",
    shortLabel: "Cancelled",
    message:
      "This transfer was cancelled before any funds were locked on-chain. Nothing was sent and no action is required.",
    action: "No further action is required. You can start a new transfer from the swap form.",
    tone: "neutral",
  },
  failed: {
    status: "failed",
    label: "Failed",
    shortLabel: "Failed",
    message:
      "This cross-chain transfer could not be completed. Your funds are safe and have not been lost — they can be recovered.",
    action:
      "Wait for the refund period to open, then click the Refund button to recover your funds. If you need help, contact support and provide your transaction ID.",
    tone: "error",
  },
  refunded: {
    status: "refunded",
    label: "Refunded",
    shortLabel: "Refunded",
    message:
      "Your funds have been returned to your wallet. The transfer was cancelled and the refund is recorded on the blockchain.",
    action: "No further action is required. Check your wallet for the refunded amount and verify using the block explorer.",
    tone: "neutral",
  },
  expired: {
    status: "expired",
    label: "Timelock expired",
    shortLabel: "Expired",
    message:
      "This transfer timed out before it could settle. Your funds are still securely locked and have not been lost.",
    action:
      "The refund window is now open. Click the Refund button to return your funds to your wallet.",
    tone: "warning",
  },
  timed_out: {
    status: "timed_out",
    label: "Timed out",
    shortLabel: "Timed out",
    message:
      "This transfer could not settle within the time limit. Your funds are still securely locked and fully recoverable.",
    action:
      "The refund window is now open. Click the Refund button to return your funds to your wallet.",
    tone: "warning",
  },
};

/**
 * Canonical order-status → display-status mapping.
 *
 * Every {@link OrderStatus} atom maps to exactly one user-facing display
 * status, and the conformance suite pins the frontend's own mappings to this
 * table so the UI never invents a different meaning for the same atom:
 *
 *   ┌──────────────────┬─────────────┬──────────────────────────────────────┐
 *   │ OrderStatus      │ Display     │ Why                                  │
 *   ├──────────────────┼─────────────┼──────────────────────────────────────┤
 *   │ announced        │ pending     │ one leg only, user still acting       │
 *   │ src_locked       │ pending     │ funds committed on one side only      │
 *   │ dst_locked       │ confirmed   │ both legs on chain → irreversible     │
 *   │ secret_revealed  │ confirmed   │ preimage out; settlement finalising   │
 *   │ completed        │ completed   │ funds delivered on the destination    │
 *   │ refunded         │ refunded    │ user got funds back                   │
 *   │ failed           │ failed      │ fatal, unusable                       │
 *   │ expired          │ expired     │ soft state: timelock passed, no refund│
 *   │ cancelled        │ cancelled   │ withdrawn pre-lock                    │
 *   │ abandoned        │ cancelled   │ stale-cleanup, funds never locked     │
 *   └──────────────────┴─────────────┴──────────────────────────────────────┘
 */
export const ORDER_STATUS_TO_DISPLAY: Record<OrderStatus, DisplayStatus> = {
  announced: "pending",
  src_locked: "pending",
  dst_locked: "confirmed",
  secret_revealed: "confirmed",
  completed: "completed",
  refunded: "refunded",
  failed: "failed",
  expired: "expired",
  cancelled: "cancelled",
  abandoned: "cancelled",
};

export function displayStatusFor(orderStatus: OrderStatus): DisplayStatus {
  return ORDER_STATUS_TO_DISPLAY[orderStatus];
}

export function statusDisplay(display: DisplayStatus): StatusDisplay {
  return STATUS_DISPLAY[display];
}

export function describeOrderStatus(orderStatus: OrderStatus): StatusDisplay {
  return STATUS_DISPLAY[ORDER_STATUS_TO_DISPLAY[orderStatus]];
}

export function isDisplayStatus(value: string): value is DisplayStatus {
  return Object.prototype.hasOwnProperty.call(STATUS_DISPLAY, value);
}

export const ALL_DISPLAY_STATUSES: readonly DisplayStatus[] = [
  "pending",
  "confirmed",
  "completed",
  "cancelled",
  "failed",
  "refunded",
  "expired",
  "timed_out",
];