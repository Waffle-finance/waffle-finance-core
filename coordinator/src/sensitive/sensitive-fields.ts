/**
 * Sensitive-data handling policy for the WaffleFinance coordinator.
 *
 * ## Field classification
 *
 * | Field            | Classification | Storage       | Logs            |
 * | ---------------- | -------------- | ------------- | --------------- |
 * | preimage         | SECRET         | encrypted¹    | REDACT always   |
 * | hashlock         | INTERNAL       | plaintext      | OK (hash, not secret) |
 * | srcAddress       | PII-LITE       | plaintext      | OK              |
 * | dstAddress       | PII-LITE       | plaintext      | OK              |
 * | resolverAddress  | INTERNAL       | plaintext      | OK              |
 * | srcAmount        | INTERNAL       | plaintext      | OK              |
 * | publicId         | PUBLIC         | plaintext      | OK              |
 * | status           | PUBLIC         | plaintext      | OK              |
 *
 * ¹ When SECRET_STORAGE_KEY is set; plaintext otherwise (legacy/dev).
 *
 * ## Allowed paths for preimage / secret material
 *
 *  1. SecretService.reveal()  — validates hashlock, optionally encrypts,
 *     writes via OrderService.recordSecret().
 *  2. SecretService.get()     — decrypts if necessary, returns to caller.
 *  3. Reconciler / SecretReconciler — validates before writing via (1).
 *
 * No other code path may write a raw preimage to the database or log it.
 *
 * ## Logger guard
 *
 * `redactSensitiveFields` is a Pino serializer that strips or masks known
 * sensitive keys from log records before they are written to any sink.
 * Import and apply it wherever a structured log object might carry order
 * data (service layer, repository layer, HTTP routes).
 *
 * ## What "redacted" means
 *
 * A redacted value is replaced with the string `"[REDACTED]"`. This is
 * distinguishable from a missing field (undefined) so that log consumers
 * can see that a field existed but was intentionally not logged — which
 * itself is operationally useful (e.g. "preimage=[REDACTED]" proves
 * the value was present).
 */

// ── Sensitive field names ─────────────────────────────────────────────────────

/**
 * Field names that must never appear in plaintext in any log output.
 * This list is the authoritative source for `redactSensitiveFields`.
 *
 * To add a new sensitive field: add it here and the serializer picks it
 * up automatically. Document why it is sensitive in the table above.
 */
export const SENSITIVE_FIELD_NAMES = [
  "preimage",
  "secret",
  "secretKey",
  "encKey",
  "secretStorageKey",
  "privateKey",
  "mnemonic",
  "seed",
] as const;

export type SensitiveFieldName = (typeof SENSITIVE_FIELD_NAMES)[number];

/** Placeholder used in logs to show the field existed but was redacted. */
export const REDACTED_PLACEHOLDER = "[REDACTED]" as const;

// ── Redaction serializer ──────────────────────────────────────────────────────

/**
 * Recursively redact sensitive field names from a log-record object.
 *
 * Designed to be used as a Pino `serializers` entry or called directly
 * before passing data to `log.info(...)` / `log.warn(...)` etc.
 *
 * Rules:
 *  - Any key whose name appears in `SENSITIVE_FIELD_NAMES` is replaced
 *    with `REDACTED_PLACEHOLDER`.
 *  - Recursion stops at depth 4 to bound worst-case cost on deeply nested
 *    objects (e.g. raw DB rows inside error objects). Objects at depth 4 or
 *    deeper are replaced with `"[MAX_DEPTH]"` rather than recursed into.
 *  - Circular references are NOT followed — a WeakSet tracks visited
 *    objects and skips them on re-encounter.
 *  - Non-object / non-array values pass through unchanged.
 *
 * @param obj   The value to sanitize (typically the first argument to a
 *              structured log call).
 * @param depth Current recursion depth (callers pass 0).
 * @param seen  WeakSet of already-visited objects (callers omit this).
 */
export function redactSensitiveFields<T>(
  obj: T,
  depth = 0,
  seen = new WeakSet<object>(),
): T {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;
  if (depth >= 4) return "[MAX_DEPTH]" as unknown as T;

  // Guard against circular references.
  if (seen.has(obj as object)) return "[CIRCULAR]" as unknown as T;
  seen.add(obj as object);

  if (Array.isArray(obj)) {
    return (obj as unknown[]).map((item) =>
      redactSensitiveFields(item, depth + 1, seen),
    ) as unknown as T;
  }

  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj as Record<string, unknown>)) {
    const value = (obj as Record<string, unknown>)[key];
    if ((SENSITIVE_FIELD_NAMES as readonly string[]).includes(key)) {
      result[key] = REDACTED_PLACEHOLDER;
    } else {
      result[key] = redactSensitiveFields(value, depth + 1, seen);
    }
  }
  return result as unknown as T;
}

// ── Pino serializer registration helper ──────────────────────────────────────

/**
 * Return a Pino `serializers` object that redacts sensitive fields from
 * the special `order` and `err` log-record keys.
 *
 * Usage:
 *   ```ts
 *   const log = pino({ serializers: sensitiveSerializers() });
 *   log.info({ order, err }, "order updated");
 *   ```
 *
 * For ad-hoc structured calls (e.g. `log.warn({ preimage, publicId }, ...)`),
 * wrap the object explicitly:
 *   ```ts
 *   log.warn(redactSensitiveFields({ preimage, publicId }), "bad preimage");
 *   ```
 */
export function sensitiveSerializers(): Record<string, (v: unknown) => unknown> {
  const serializers: Record<string, (v: unknown) => unknown> = {
    order: (v: unknown) => redactSensitiveFields(v),
    err:   (v: unknown) => redactSensitiveFields(v),
    req:   (v: unknown) => redactSensitiveFields(v),
    res:   (v: unknown) => redactSensitiveFields(v),
  };
  for (const name of SENSITIVE_FIELD_NAMES) {
    serializers[name] = () => REDACTED_PLACEHOLDER;
  }
  return serializers;
}

// ── Type guard ────────────────────────────────────────────────────────────────

/** Return true if `key` is a known sensitive field name. */
export function isSensitiveField(key: string): key is SensitiveFieldName {
  return (SENSITIVE_FIELD_NAMES as readonly string[]).includes(key);
}
