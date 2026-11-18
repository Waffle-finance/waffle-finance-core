/**
 * @wafflefinance/sdk — coordinator module
 *
 * Provides the typed HTTP client, wire-contract types, history client, event
 * subscription, local request validation, and coordinator ↔ SDK transforms.
 *
 * Import from the subpath export:
 *   import { CoordinatorClient, HistoryClient, ... } from "@wafflefinance/sdk/coordinator";
 */

// ── Wire contract types ──────────────────────────────────────────────────────
export type {
  CoordinatorDirection,
  CoordinatorChainLeg,
  CoordinatorSecretBlock,
  CoordinatorOrder,
  CoordinatorHistoryResponse,
  CoordinatorOffsetPagination,
  CoordinatorCursorPagination,
  CoordinatorSecretResponse,
  CoordinatorRevealResponse,
  CoordinatorRevealRequest,
  CoordinatorAnnounceRequest,
  CoordinatorErrorResponse,
  CoordinatorHealthResponse,
  CoordinatorReadinessResponse,
} from "./contract.js";
export { isCursorPagination, isCoordinatorError } from "./contract.js";

// ── Errors ───────────────────────────────────────────────────────────────────
export {
  CoordinatorError,
  CoordinatorApiError,
  CoordinatorParseError,
  CoordinatorNetworkError,
  CoordinatorValidationError,
} from "./errors.js";

// ── HTTP client ──────────────────────────────────────────────────────────────
export { CoordinatorClient } from "./client.js";
export type { CoordinatorClientOptions, GetHistoryOptions } from "./client.js";

// ── History client ───────────────────────────────────────────────────────────
export { HistoryClient, toHistoryRecord } from "./history-client.js";
export type {
  HistoryRecord,
  HistoryPagination,
  HistoryPage,
  HistoryClientOptions,
} from "./history-client.js";

// ── Event subscription ───────────────────────────────────────────────────────
export { OrderSubscriber } from "./subscription.js";
export type {
  OrderSubscriberOptions,
  OrderSubscriptionEvents,
  OrderSubscriptionEventName,
  StatusChangedEvent,
  SecretRevealedEvent,
  OrderSettledEvent,
  SubscriptionErrorEvent,
  SubscriptionStartedEvent,
  SubscriptionStoppedEvent,
} from "./subscription.js";

// ── Validation ───────────────────────────────────────────────────────────────
export {
  validateAnnounceRequest,
  assertValidAnnounceRequest,
  validateHashlockField,
  validateChainAddress,
  validateDecimalIntField,
  DIRECTION_CHAINS,
  SUPPORTED_DIRECTIONS,
} from "./validation.js";
export type { ValidationIssue, ValidationResult } from "./validation.js";

// ── Schema validation ────────────────────────────────────────────────────────
export {
  validateAnnounceRequestSchema,
  validateRevealRequestSchema,
  validateOrderSchema,
  validateChainLegSchema,
  validateSecretBlockSchema,
  validateHealthResponseSchema,
  assertValidSchema,
} from "./schema.js";
export type {
  SchemaValidationError,
  SchemaValidationResult,
} from "./schema.js";

// ── Transforms ───────────────────────────────────────────────────────────────
export { toOrder, toOrders } from "./transform.js";
