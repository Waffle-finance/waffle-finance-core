import { dbQueryDuration } from "../metrics.js";

export interface TransactionOperationContext {
  operation: string;
  attempt: number;
  maxAttempts: number;
}

/**
 * A connection that can host a real `BEGIN` … `COMMIT` block.
 *
 * `PostgresDatabase` implements this with `transaction()`; a `node:sqlite`
 * `DatabaseSync` implements it structurally with `exec()`.
 */
export interface TransactionCapableDatabase {
  /** Run `fn` in a transaction, handing it a connection bound to that transaction. */
  transaction<T>(fn: (db: any) => Promise<T>): Promise<T>;
}

/** A `node:sqlite` `DatabaseSync` (or anything with a sync `exec`). */
export interface SyncExecutableDatabase {
  exec(sql: string): unknown;
}

/**
 * Return true when `db` exposes a native `transaction()` method
 * (`PostgresDatabase`).
 */
export function hasNativeTransaction(db: unknown): db is TransactionCapableDatabase {
  return typeof (db as any)?.transaction === "function";
}

/**
 * Return true when `db` exposes a synchronous `exec()` (a `node:sqlite`
 * `DatabaseSync`, or a test double standing in for one).
 */
export function hasSyncExec(db: unknown): db is SyncExecutableDatabase {
  return typeof (db as any)?.exec === "function";
}

/**
 * Run `fn` inside a real SQLite transaction on a single connection.
 *
 * `BEGIN IMMEDIATE` (rather than the default deferred `BEGIN`) so the write
 * lock is taken up front.  Under WAL, two coordinators replaying the same
 * window concurrently would otherwise both read, then both try to upgrade to a
 * write lock, and the loser would fail at COMMIT time with SQLITE_BUSY — after
 * it had already decided it was safe to write.  Taking the lock at BEGIN makes
 * the contention happen before any read, which the retry wrapper can then
 * absorb cleanly.
 *
 * `ROLLBACK` is best-effort: if the failure was a lost connection the rollback
 * will also fail, and the original error is the one worth surfacing.
 */
export async function runInSyncTransaction<T>(
  db: SyncExecutableDatabase,
  fn: () => Promise<T>
): Promise<T> {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = await fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Connection already gone — the pool/handle will be discarded. Report
      // the failure that actually caused the rollback.
    }
    throw err;
  }
}

export interface RepositoryTransaction {
  runWithRetry<T>(operation: string, fn: () => Promise<T>): Promise<T>;
  /**
   * Run `fn` with retry semantics *and* a real database transaction boundary.
   *
   * `db` is the live connection the repository is bound to.  Implementations
   * must degrade to a plain `runWithRetry` when `db` cannot host a
   * transaction (an in-memory test double, for instance) so the contract stays
   * usable without a real engine.
   */
  runInTransaction<T>(db: unknown, operation: string, fn: () => Promise<T>): Promise<T>;
}

export interface RepositoryTransactionOptions {
  maxAttempts?: number;
  retryableErrors?: readonly string[];
  run?: (operation: string, fn: () => Promise<unknown>) => Promise<unknown>;
}

export class InMemoryRepositoryTransaction implements RepositoryTransaction {
  private readonly maxAttempts: number;
  private readonly retryableErrors: readonly string[];
  private readonly runImpl: (operation: string, fn: () => Promise<unknown>) => Promise<unknown>;

  constructor(options: RepositoryTransactionOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? 3;
    this.retryableErrors = options.retryableErrors ?? [
      "SQLITE_BUSY",
      "SQLITE_LOCKED",
      "database is locked",
      "deadlock",
      "lock timeout",
    ];
    this.runImpl = options.run ?? ((operation, fn) => fn());
  }

  async runWithRetry<T>(operation: string, fn: () => Promise<T>): Promise<T> {
    let attempt = 0;
    let lastError: unknown;

    while (attempt < this.maxAttempts) {
      attempt += 1;
      try {
        const result = await this.runImpl(operation, () => fn());
        return result as T;
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        if (!this.shouldRetry(message)) {
          throw error;
        }
        this.recordRetry(operation, message, attempt);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  /**
   * #734: retry *and* a genuine database transaction boundary.
   *
   * Every multi-statement repository write (an `orders` row mutation paired
   * with its `order_events` history row) previously committed each statement
   * independently.  A crash between them left the order advanced with no
   * history row — a partial status transition that the next replay could
   * never repair, because the replay would take the "already at target" path
   * and record a no-op forever.
   *
   * The boundary is applied *inside* the retry loop, so a rolled-back attempt
   * is retried as a whole rather than resuming from a half-applied state.
   */
  async runInTransaction<T>(db: unknown, operation: string, fn: () => Promise<T>): Promise<T> {
    if (hasNativeTransaction(db)) {
      return this.runWithRetry(operation, () => db.transaction(() => fn()));
    }
    if (hasSyncExec(db)) {
      return this.runWithRetry(operation, () => runInSyncTransaction(db, fn));
    }
    // No transaction support on this connection (e.g. a test double). Retry
    // semantics still apply; atomicity is simply not available.
    return this.runWithRetry(operation, fn);
  }

  private shouldRetry(message: string): boolean {
    const lowered = message.toLowerCase();

    const explicitTokens = [
      "sqlite_busy",
      "sqlite_locked",
      "database is locked",
      "deadlock",
      "lock timeout",
    ];
    if (explicitTokens.some((token) => lowered.includes(token))) {
      return true;
    }

    return this.retryableErrors.some((token) => lowered.includes(token.toLowerCase()));
  }

  private recordRetry(operation: string, message: string, attempt: number): void {
    const end = dbQueryDuration.startTimer({ operation: `repository_tx_retry_${operation}` });
    try {
      if (message.toLowerCase().includes("deadlock")) {
        void import("../metrics.js").then(({ repositoryTransactionDeadlocks }) => {
          repositoryTransactionDeadlocks.inc();
        });
      }
      void import("../metrics.js").then(({ repositoryTransactionRetries }) => {
        repositoryTransactionRetries.inc({ operation });
      });
    } finally {
      end();
    }
  }
}
