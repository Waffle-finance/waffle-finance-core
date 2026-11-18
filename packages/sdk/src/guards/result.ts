/**
 * Shared result type for every runtime guard added in #733.
 *
 * Why this exists rather than a new bespoke validator per module
 * ──────────────────────────────────────────────────────────────
 * The SDK already has one guard idiom: `coordinator/validation.ts` returns a
 * `ValidationResult` (`{ ok: boolean, issues: ValidationIssue[] }`) and
 * offers `assertValidAnnounceRequest` for callers who want an exception.
 * `shared-utils/rpc-compat.ts` uses the same idea in a different shape
 * (`RpcCallSuccess | RpcCallFailure` discriminated on `ok`).
 *
 * This module is the common denominator of those two idioms, not a third
 * one. Two differences from `ValidationResult` matter:
 *
 * 1. `ok` is a real discriminant. `ValidationResult.ok` is typed `boolean`,
 *    so `if (result.ok) result.value` does not narrow. Here `ok` is a literal
 *    `true` / `false` on each arm of a union, so TypeScript narrows
 *    `value` to `T` on the success arm. That is the whole point: a guard that
 *    cannot narrow is just documentation.
 * 2. `issues` is `readonly` so a caller cannot mutate a guard's findings
 *    after the fact.
 *
 * `GuardIssue` is deliberately an alias of `coordinator/validation.ts`'s
 * `ValidationIssue` (`{ field, message }`) rather than a new shape, so
 * existing consumers that already render `ValidationIssue[]` can render
 * guard findings without translation.
 *
 * Assertion style
 * ───────────────
 * Every guard ships both forms:
 *   • `validateX(input: unknown): GuardResult<X>` — total, never throws.
 *     Use when you want to accumulate every problem (a form with three bad
 *     fields should report three issues, not one).
 *   • `assertX(input: unknown): X` — throws `GuardError` on failure.
 *     Use at a trust boundary where continuing is not an option.
 *
 * `assertX` returns the *narrowed* value, so
 * `const order = assertCoordinatorOrder(body)` gives a `CoordinatorOrder`
 * with no cast at the call site.
 */

/** A single guard finding. Structurally identical to the coordinator's `ValidationIssue`. */
export type GuardIssue = { readonly field: string; readonly message: string };

/**
 * Outcome of a guard.
 *
 * Discriminated on `ok`, so `value` is only reachable on the success arm and
 * `issues` only on the failure arm.
 */
export type GuardResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly issues: readonly GuardIssue[] };

/** Build a success result. */
export function guardOk<T>(value: T): GuardResult<T> {
  return { ok: true, value };
}

/** Build a failure result from one or more issues. */
export function guardFail(issues: readonly GuardIssue[] | GuardIssue): GuardResult<never> {
  return { ok: false, issues: Array.isArray(issues) ? issues : [issues as GuardIssue] };
}

/** Build a single-issue failure result. */
export function guardFailOne(field: string, message: string): GuardResult<never> {
  return { ok: false, issues: [{ field, message }] };
}

/**
 * Accumulates issues while walking a nested structure so a guard can report
 * every problem in one pass instead of bailing on the first.
 *
 * `path` is built up as `parent.child[index]`, which is what makes a
 * coordinator response with three malformed legs actionable.
 */
export class GuardIssueCollector {
  private readonly issues: GuardIssue[] = [];

  /** Record an issue at `path`. Returns `this` so calls can chain. */
  add(path: string, message: string): this {
    this.issues.push({ field: path, message });
    return this;
  }

  /** Record an issue derived from a `string | null` legacy validator. */
  addLegacy(path: string, message: string | null): this {
    if (message !== null) this.issues.push({ field: path, message });
    return this;
  }

  get length(): number {
    return this.issues.length;
  }

  /** Snapshot of the issues collected so far. */
  list(): readonly GuardIssue[] {
    return [...this.issues];
  }

  /** Turn the collector into a result: success with `value`, or failure. */
  finish<T>(value: T): GuardResult<T> {
    return this.issues.length === 0 ? guardOk(value) : guardFail(this.issues);
  }
}

/**
 * Thrown by every `assertX` guard.
 *
 * `issues` carries the full finding list, not just the first one, so a
 * caller can render a complete form even though only the first issue
 * prevented acceptance.
 */
export class GuardError extends Error {
  public readonly issues: readonly GuardIssue[];

  constructor(label: string, issues: readonly GuardIssue[]) {
    const first = issues[0];
    super(
      `${label} failed validation` +
        (first ? `: ${first.field} — ${first.message}` : '') +
        (issues.length > 1 ? ` (and ${issues.length - 1} more issue(s))` : '')
    );
    this.name = 'GuardError';
    this.issues = issues;
  }
}

/** Render a failure as a single human-readable sentence. */
export function formatIssues(issues: readonly GuardIssue[]): string {
  return issues.map(i => `${i.field}: ${i.message}`).join('; ');
}

/**
 * Unwrap a `GuardResult`, throwing `GuardError` on failure.
 *
 * Prefer the per-guard `assertX` helpers — this is the shared implementation
 * they all delegate to, exposed for callers that compose their own guards.
 */
export function assertGuard<T>(result: GuardResult<T>, label: string): T {
  if (result.ok) return result.value;
  throw new GuardError(label, result.issues);
}
