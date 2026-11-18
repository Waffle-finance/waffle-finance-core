import { describe, it, expect } from 'vitest';
import { normalizeAsset, getNativeAsset } from './assetNormalization';
import { formatAmount } from './formatAmount';

describe('formatAmount', () => {
  it('formats ETH with 4 decimals for typical values', () => {
    const eth = getNativeAsset('ethereum');
    expect(formatAmount('0.123456789', eth)).toContain('0.1235');
  });

  it('formats XLM with more decimals when under 1', () => {
    const xlm = getNativeAsset('stellar');
    expect(formatAmount('0.0001234', xlm)).toContain('0.0001234');
  });

  it('shows symbol when requested', () => {
    const sol = getNativeAsset('solana');
    expect(formatAmount('1.5', sol, { showSymbol: true })).toMatch(/SOL$/);
    expect(formatAmount('1.5', sol, { showSymbol: false })).not.toMatch(/SOL$/);
  });
});
