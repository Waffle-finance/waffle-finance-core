/**
 * Lightweight i18n utility for the WaffleFinance coordinator.
 *
 * Provides a simple `m()` function that resolves dotted-path keys from the
 * English messages catalog and replaces {{placeholder}} variables.
 *
 * Usage:
 *   import { m } from '../i18n/index.js';
 *
 *   m('api.errors.orderNotFound')
 *   // → "Order not found"
 *
 *   m('api.errors.cannotTransition', { from: 'announced', to: 'secret_revealed' })
 *   // → "cannot transition from announced to secret_revealed"
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';

const _require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

// Load catalog synchronously at module initialisation — the file is part of
// the compiled package so it is always present.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let catalog: Record<string, any>;
try {
  const raw = readFileSync(join(__dirname, 'en.json'), 'utf-8');
  catalog = JSON.parse(raw);
} catch {
  catalog = {};
}

export type Vars = Record<string, string | number>;

/**
 * Resolve a dotted key from the catalog and interpolate {{placeholder}} vars.
 * Falls back to the raw key string so missing entries are immediately visible
 * in logs rather than silently swallowed.
 */
export function m(key: string, vars?: Vars): string {
  const parts = key.split('.');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let node: any = catalog;
  for (const part of parts) {
    if (node == null || typeof node !== 'object') return key;
    node = node[part];
  }
  if (typeof node !== 'string') return key;
  if (!vars) return node;
  return node.replace(/\{\{(\w+)\}\}/g, (_match: string, name: string) => {
    const value = vars[name];
    return value !== undefined ? String(value) : `{{${name}}}`;
  });
}
