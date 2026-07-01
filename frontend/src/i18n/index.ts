/**
 * Lightweight i18n utility for WaffleFinance.
 *
 * Design goals:
 *  - Zero dependencies — plain TypeScript, no external i18n library.
 *  - Flat dotted key lookup over a nested JSON catalog.
 *  - Minimal interpolation: {{variableName}} placeholders replaced at call time.
 *  - Type-safe: callers import `t` and get a string back, falling back to the
 *    key itself so missing keys are immediately visible in the UI.
 *  - Tree-shakeable: the catalog is a static import; nothing is loaded lazily
 *    unless you add dynamic imports yourself.
 *
 * Usage:
 *   import { t } from '../i18n';
 *
 *   t('bridge.button.bridge')
 *   // → "Bridge"
 *
 *   t('validation.balance.insufficient', { symbol: 'ETH', balance: '0.05' })
 *   // → "Insufficient ETH balance. You have 0.05 ETH."
 *
 *   t('wallet.toast.networkChangeCancelledBody', { network: 'Testnet' })
 *   // → "You declined the wallet switch — app is still on Testnet."
 *
 * To add a new locale, import its catalog alongside `en` and wire a locale
 * selector here. The catalog shape is validated at import time by TypeScript.
 */

import catalog from './en.json';

/** Interpolation variables passed to `t()`. */
export type Vars = Record<string, string | number>;

/**
 * Look up a dotted-path key in the catalog and optionally interpolate
 * `{{variableName}}` placeholders.
 *
 * Returns the resolved string, or the key itself if the path is not found
 * (so broken keys surface immediately in development without crashing).
 */
export function t(key: string, vars?: Vars): string {
  const parts = key.split('.');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let node: any = catalog;
  for (const part of parts) {
    if (node == null || typeof node !== 'object') {
      // Key path not found — return the key as a visible fallback.
      return key;
    }
    node = node[part];
  }

  if (typeof node !== 'string') {
    // Resolved to a non-string (object/array/undefined) — return the key.
    return key;
  }

  if (!vars) return node;

  // Replace {{name}} placeholders.
  return node.replace(/\{\{(\w+)\}\}/g, (_match, name) => {
    const value = vars[name];
    return value !== undefined ? String(value) : `{{${name}}}`;
  });
}

/**
 * React hook wrapper — provided for symmetry and future locale switching.
 * Components that need reactive locale changes should use this hook instead
 * of calling `t` directly, so a future locale context can re-render them
 * without code changes.
 */
export function useMessages() {
  return { t };
}
