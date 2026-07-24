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
 *
 * API error contract (documented for frontend and integrators):
 *
 * | code                 | HTTP | description                                      |
 * | -------------------- | ---- | ------------------------------------------------ |
 * | validation_error     | 400  | Request body or query param failed schema check  |
 * | order_validation_error | 400 | Order-level business rule violation             |
 * | invalid_cursor       | 400  | Pagination cursor is malformed or expired        |
 * | not_found            | 404  | Requested resource does not exist               |
 * | not_revealed         | 404  | Secret has not been revealed for this order     |
 * | unknown_order        | 404  | No order matches the supplied ID                |
 * | unauthorized         | 401  | Missing or malformed authorization header       |
 * | forbidden            | 403  | Valid credentials but insufficient permissions  |
 * | too_many_requests    | 429  | Rate limit exceeded; see Retry-After header     |
 * | internal_error       | 500  | Unexpected server error                         |
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

export function invalidCursorError(message = "The provided cursor is invalid or expired"): ApiErrorBody {
  return { error: "invalid_cursor", message };
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
