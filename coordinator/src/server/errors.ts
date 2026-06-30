/**
 * Shared error response helpers for coordinator API routes.
 *
 * Every route must respond with this shape so clients can rely on a
 * predictable contract regardless of which endpoint they call:
 *
 *   { error: string, message: string, details?: unknown[], retryable?: boolean }
 *
 * - `error`    — stable, machine-readable code (snake_case)
 * - `message`  — human-readable explanation, safe to surface to end-users
 * - `details`  — structured array of issues (Zod validation errors)
 * - `retryable`— advisory flag for transient failures (secret reveal path)
 */

export interface ApiErrorBody {
  error: string;
  message: string;
  details?: unknown[];
  retryable?: boolean;
}

export function validationError(details: unknown[], message = "Request validation failed"): ApiErrorBody {
  return { error: "validation_error", message, details };
}

export function orderValidationError(message: string): ApiErrorBody {
  return { error: "order_validation_error", message };
}

export function notFoundError(message = "Resource not found"): ApiErrorBody {
  return { error: "not_found", message };
}

export function notRevealedError(): ApiErrorBody {
  return { error: "not_revealed", message: "Secret has not been revealed for this order" };
}

export function internalError(message: string): ApiErrorBody {
  return { error: "internal_error", message };
}
