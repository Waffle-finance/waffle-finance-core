import { dbQueryDuration } from "../metrics.js";

export interface TransactionOperationContext {
  operation: string;
  attempt: number;
  maxAttempts: number;
}

export interface RepositoryTransaction {
  runWithRetry<T>(operation: string, fn: () => Promise<T>): Promise<T>;
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
