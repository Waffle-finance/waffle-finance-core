import type { OrderStatus } from "../types/index.js";

export type DisplayStatus =
  | "pending"
  | "confirmed"
  | "completed"
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
      "Your cross-chain transfer is complete. The destination funds have been delivered to your wallet and the transaction is confirmed.",
    action: "No further action is required. You can verify the transaction using the block explorer link.",
    tone: "success",
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

const ORDER_STATUS_TO_DISPLAY: Record<OrderStatus, DisplayStatus> = {
  announced: "pending",
  src_locked: "pending",
  dst_locked: "pending",
  secret_revealed: "pending",
  completed: "confirmed",
  failed: "failed",
  refunded: "refunded",
  expired: "timed_out",
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
  "failed",
  "refunded",
  "expired",
  "timed_out",
];
