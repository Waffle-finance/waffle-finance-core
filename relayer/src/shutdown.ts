/**
 * Graceful shutdown logic for the WaffleFinance relayer.
 *
 * Extracted into its own module so it can be unit-tested without importing
 * the full relayer entry-point (index.ts), which boots the HTTP server and
 * requires live environment variables.
 *
 * Issue 587: make shutdown idempotent — repeated SIGTERM/SIGINT signals
 * (which are common during container stop races) must not attempt to close
 * the same resources twice or invoke process.exit more than once.
 */

import { getLogger } from './logger.js';

const logger = getLogger();

// ---------------------------------------------------------------------------
// Idempotence flag
//
// A plain module-level boolean is sufficient: Node.js is single-threaded so
// there is no read-modify-write race.  The flag is set to true on the first
// shutdown call and never reset in production; a test-only reset helper is
// exported below.
// ---------------------------------------------------------------------------

let _shuttingDown = false;

/**
 * Perform a clean shutdown of the relayer.
 *
 * The first call stops all resources and exits the process.
 * Every subsequent call is a no-op — the resources are already being torn
 * down and calling close/stop on them again would produce errors.
 */
export async function gracefulShutdown(): Promise<void> {
  if (_shuttingDown) {
    logger.info('gracefulShutdown called again — already shutting down, ignoring');
    return;
  }
  _shuttingDown = true;

  logger.info('Shutting down relayer service');
  try {
    // Dynamic import keeps this module free of a circular dependency:
    // ethereum-listener → index → shutdown would be a cycle if we imported
    // the listener at the top of the module.
    const { ethereumListener } = await import('./listeners/ethereum-listener.js');
    await ethereumListener.stopListening();
    logger.info('Ethereum listener stopped');
  } catch (err) {
    logger.error({ err }, 'Error stopping Ethereum listener');
  }
  logger.info('Relayer shutdown complete');
  process.exit(0);
}

/**
 * Reset the internal shutdown flag.
 *
 * FOR TESTING ONLY — never call this in production code.
 * Allows a test suite to restore the module to its initial state between
 * test cases without reloading the module.
 */
export function _resetShutdownStateForTest(): void {
  _shuttingDown = false;
}
