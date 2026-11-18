#!/usr/bin/env node
/**
 * Generate a 32-byte random key suitable for SECRET_STORAGE_KEY.
 *
 * Outputs a 64-character hex string to stdout — the exact format the
 * coordinator's deriveKey() function accepts.  Nothing is written to disk,
 * logs, or any persistent store.
 *
 * Usage:
 *   pnpm --filter @wafflefinance/coordinator generate-key
 *
 * Then copy the output and store it in your secret manager (AWS Secrets
 * Manager, HashiCorp Vault, etc.) and inject it as SECRET_STORAGE_KEY at
 * runtime.  NEVER commit the generated key to source control.
 *
 * See docs/OPERATIONS.md → "Secret storage key generation and rotation" for
 * the full operator guide.
 */

import { randomBytes } from 'node:crypto';

const key = randomBytes(32).toString('hex');
process.stdout.write(key + '\n');
