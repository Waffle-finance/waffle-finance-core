import type { NormalizedAsset } from './assetNormalization';

/**
 * Canonical formatting for asset amounts. Ensures consistent precision
 * and unit display across chains and wrapped/native token differences.
 */
export function formatAmount(raw: string | number, asset: NormalizedAsset, opts?: { showSymbol?: boolean }) {
  const showSymbol = opts?.showSymbol ?? true;
  const num = typeof raw === 'string' ? parseFloat(raw) : raw;
  if (!Number.isFinite(num)) return '';
  // Choose precision: show up to asset.decimals for small tokens, but cap
  // UI precision to reasonable values to avoid noise.
  const maxUiDecimals = asset.decimals > 8 ? 8 : asset.decimals;
  // For large values, reduce decimals to 2
  const abs = Math.abs(num);
  const decimals = abs >= 1000 ? 2 : abs >= 1 ? Math.min(4, maxUiDecimals) : maxUiDecimals;
  // Use toLocaleString to get grouping separators
  const formatted = Number(num).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: decimals });
  return showSymbol ? `${formatted} ${asset.symbol}` : formatted;
}

export default formatAmount;
