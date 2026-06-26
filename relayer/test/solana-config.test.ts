/**
 * Tests for Solana placeholder program detection.
 *
 * Coverage:
 *  - isSolanaPlaceholder: undefined, empty, whitespace, known placeholders,
 *    case-insensitive matches, substring matches, YOUR_ prefix, real addresses
 *  - checkSolanaConfig: returns 'placeholder' vs 'configured'
 *  - All entries in SOLANA_PLACEHOLDER_VALUES are flagged
 */

import { describe, it, expect } from 'vitest';
import {
  isSolanaPlaceholder,
  checkSolanaConfig,
  SOLANA_PLACEHOLDER_VALUES,
} from '../src/utils/solana-config.js';

// ---------------------------------------------------------------------------
// isSolanaPlaceholder
// ---------------------------------------------------------------------------

describe('isSolanaPlaceholder — undefined / blank', () => {
  it('returns true for undefined', () => {
    expect(isSolanaPlaceholder(undefined)).toBe(true);
  });

  it('returns true for empty string', () => {
    expect(isSolanaPlaceholder('')).toBe(true);
  });

  it('returns true for whitespace-only string', () => {
    expect(isSolanaPlaceholder('   ')).toBe(true);
  });
});

describe('isSolanaPlaceholder — known placeholder set', () => {
  it('flags every entry in SOLANA_PLACEHOLDER_VALUES', () => {
    for (const value of SOLANA_PLACEHOLDER_VALUES) {
      expect(isSolanaPlaceholder(value), `should flag: "${value}"`).toBe(true);
    }
  });

  it('flags PLACEHOLDER (lower-case)', () => {
    expect(isSolanaPlaceholder('placeholder')).toBe(true);
  });

  it('flags PLACEHOLDER (mixed-case)', () => {
    expect(isSolanaPlaceholder('Placeholder')).toBe(true);
  });

  it('flags the all-ones system program address', () => {
    expect(isSolanaPlaceholder('11111111111111111111111111111111')).toBe(true);
  });
});

describe('isSolanaPlaceholder — substring / prefix rules', () => {
  it('flags strings that contain PLACEHOLDER as a substring', () => {
    expect(isSolanaPlaceholder('MY_PLACEHOLDER_PROGRAM')).toBe(true);
    expect(isSolanaPlaceholder('solana_placeholder_value')).toBe(true);
  });

  it('flags strings that start with YOUR_', () => {
    expect(isSolanaPlaceholder('YOUR_PROGRAM_ID_HERE')).toBe(true);
    expect(isSolanaPlaceholder('YOUR_CUSTOM_HTLC_PROGRAM')).toBe(true);
    expect(isSolanaPlaceholder('your_program')).toBe(true);
  });
});

describe('isSolanaPlaceholder — real program addresses', () => {
  it('returns false for a realistic base-58 Solana program ID', () => {
    expect(isSolanaPlaceholder('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM')).toBe(false);
  });

  it('returns false for the SPL Token program', () => {
    expect(isSolanaPlaceholder('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')).toBe(false);
  });

  it('returns false for another realistic address', () => {
    expect(isSolanaPlaceholder('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1hBQ')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkSolanaConfig
// ---------------------------------------------------------------------------

describe('checkSolanaConfig', () => {
  it('returns "placeholder" for undefined', () => {
    expect(checkSolanaConfig(undefined)).toBe('placeholder');
  });

  it('returns "placeholder" for the canonical PLACEHOLDER string', () => {
    expect(checkSolanaConfig('PLACEHOLDER')).toBe('placeholder');
  });

  it('returns "placeholder" for the system program all-ones address', () => {
    expect(checkSolanaConfig('11111111111111111111111111111111')).toBe('placeholder');
  });

  it('returns "configured" for a realistic base-58 program ID', () => {
    expect(checkSolanaConfig('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM')).toBe('configured');
  });

  it('returns "configured" for the SPL Token program', () => {
    expect(checkSolanaConfig('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')).toBe('configured');
  });
});
