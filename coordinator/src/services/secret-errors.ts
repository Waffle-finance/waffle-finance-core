/**
 * Typed failure model for the secret reveal path.
 *
 * `SecretService.reveal` can fail for several distinct reasons, and clients
 * and operators need to tell them apart to react correctly:
 *
 *  | code            | meaning                                   | HTTP | retryable |
 *  | --------------- | ----------------------------------------- | ---- | --------- |
 *  | `unknown_order` | no order exists for the given publicId    | 404  | no        |
 *  | `invalid_preimage` | preimage does not hash to the hashlock | 400  | no        |
 *  | `reveal_conflict`  | order is in a state that can no longer  | 409  | no        |
 *  |                 | accept a reveal (stale / replayed reveal) |      |           |
 *  | `storage_failure`  | the preimage could not be persisted    | 500  | yes       |
 *
 * Design notes:
 *  - The hierarchy is explicit and extensible: add a new subclass with its
 *    own `code`/`httpStatus`/`retryable` and the route mapping picks it up
 *    automatically via the `SecretRevealError` base type.
 *  - `retryable` tells a client whether to retry (transient infrastructure
 *    failure) or abandon (the request itself is wrong) a reveal attempt.
 *  - SECURITY: messages on these errors are safe to return to clients. They
 *    MUST NOT contain the preimage, the decryption key, or any other secret
 *    material — only the publicId and a category description.
 */

/** Stable, machine-readable discriminators returned to API clients. */
export type SecretRevealErrorCode =
  | "unknown_order"
  | "invalid_preimage"
  | "reveal_conflict"
  | "storage_failure";

/**
 * Base class for all classified secret-reveal failures. Never thrown
 * directly — callers throw one of the concrete subclasses below.
 */
export abstract class SecretRevealError extends Error {
  /** Machine-readable category, surfaced as the JSON `error` field. */
  abstract readonly code: SecretRevealErrorCode;
  /** HTTP status the route layer should respond with. */
  abstract readonly httpStatus: number;
  /**
   * Whether a client should retry the same reveal. `false` means the
   * request is fundamentally wrong (retrying will not help); `true` means
   * the failure was transient.
   */
  abstract readonly retryable: boolean;

  constructor(message: string) {
    super(message);
    // Set name to the concrete subclass for readable logs/stack traces.
    this.name = new.target.name;
  }
}

/** No order exists for the supplied publicId. */
export class UnknownOrderError extends SecretRevealError {
  readonly code = "unknown_order";
  readonly httpStatus = 404;
  readonly retryable = false;
}

/** The preimage does not hash (sha256 or keccak256) to the order hashlock. */
export class InvalidPreimageError extends SecretRevealError {
  readonly code = "invalid_preimage";
  readonly httpStatus = 400;
  readonly retryable = false;
}

/**
 * The order is no longer in a state that can accept a reveal — e.g. it has
 * been refunded or otherwise advanced past the point where a secret is
 * meaningful. This typically indicates a stale or replayed reveal.
 */
export class RevealConflictError extends SecretRevealError {
  readonly code = "reveal_conflict";
  readonly httpStatus = 409;
  readonly retryable = false;
}

/**
 * The preimage was valid but could not be persisted (database write
 * failure or other unexpected infrastructure error). The reveal can be
 * safely retried.
 */
export class SecretStorageError extends SecretRevealError {
  readonly code = "storage_failure";
  readonly httpStatus = 500;
  readonly retryable = true;
}
