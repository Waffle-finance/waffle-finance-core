import { renderHook, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { usePersistedBridgeDraft } from './usePersistedBridgeDraft';

const STORAGE_KEY = 'wafflefinance_bridge_draft_v1';

const ETH = '0x1111111111111111111111111111111111111111';
const XLM = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422';
const SOL = '11111111111111111111111111111111';

function clearStorage(): void {
  window.localStorage.clear();
}

describe('usePersistedBridgeDraft', () => {
  beforeEach(() => {
    clearStorage();
  });

  afterEach(() => {
    clearStorage();
  });

  it('starts with defaults when nothing is persisted', () => {
    const { result } = renderHook(() =>
      usePersistedBridgeDraft({
        ethAddress: ETH,
        stellarAddress: XLM,
        solanaAddress: SOL,
      }),
    );
    expect(result.current.direction).toBe('eth_to_xlm');
    expect(result.current.amount).toBe('');
    expect(result.current.wasRestored).toBe(false);
  });

  it('persists direction + amount on setDirection and setAmount', () => {
    const { result } = renderHook(() =>
      usePersistedBridgeDraft({
        ethAddress: ETH,
        stellarAddress: XLM,
        solanaAddress: SOL,
      }),
    );

    act(() => result.current.setDirection('xlm_to_eth'));
    act(() => result.current.setAmount('0.25'));

    const raw = window.localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw as string);
    expect(parsed.direction).toBe('xlm_to_eth');
    expect(parsed.amount).toBe('0.25');
    expect(parsed.v).toBe(1);
    expect(typeof parsed.savedAt).toBe('number');
    // No sensitive fields may be persisted.
    expect(parsed.ethAddress).toBeUndefined();
    expect(parsed.stellarAddress).toBeUndefined();
    expect(parsed.solanaAddress).toBeUndefined();
    expect(parsed.hashlock).toBeUndefined();
    expect(parsed.preimage).toBeUndefined();
    expect(parsed.xdr).toBeUndefined();
  });

  it('restores direction + amount across remounts with the same wallet shape', () => {
    const first = renderHook(() =>
      usePersistedBridgeDraft({
        ethAddress: ETH,
        stellarAddress: XLM,
        solanaAddress: SOL,
      }),
    );
    act(() => first.result.current.setDirection('eth_to_sol'));
    act(() => first.result.current.setAmount('0.01'));
    first.unmount();

    const second = renderHook(() =>
      usePersistedBridgeDraft({
        ethAddress: ETH,
        stellarAddress: XLM,
        solanaAddress: SOL,
      }),
    );
    expect(second.result.current.direction).toBe('eth_to_sol');
    expect(second.result.current.amount).toBe('0.01');
    expect(second.result.current.wasRestored).toBe(true);
  });

  it('does NOT leak the draft across a different wallet configuration', () => {
    const first = renderHook(() =>
      usePersistedBridgeDraft({
        ethAddress: ETH,
        stellarAddress: XLM,
        solanaAddress: SOL,
      }),
    );
    act(() => first.result.current.setDirection('eth_to_sol'));
    act(() => first.result.current.setAmount('0.01'));
    first.unmount();

    // A different wallet shape (Phantom disconnected) should NOT restore the
    // stale draft.
    const second = renderHook(() =>
      usePersistedBridgeDraft({
        ethAddress: ETH,
        stellarAddress: XLM,
        solanaAddress: undefined,
      }),
    );
    expect(second.result.current.direction).toBe('eth_to_xlm');
    expect(second.result.current.amount).toBe('');
    expect(second.result.current.wasRestored).toBe(false);

    // After the rejection, storage either remains absent or contains a
    // fresh default recorded under the NEW fingerprint (1-1-0), never the
    // previous fingerprint's payload.
    const storedRaw = window.localStorage.getItem(STORAGE_KEY);
    if (storedRaw !== null) {
      const parsed = JSON.parse(storedRaw);
      expect(parsed.fingerprint).toBe('1-1-0');
      expect(parsed.direction).toBe('eth_to_xlm');
      expect(parsed.amount).toBe('');
    }
  });

  it('ignores entries older than the 24h TTL', () => {
    const stale = {
      v: 1,
      direction: 'eth_to_sol',
      amount: '0.99',
      fingerprint: '1-1-1',
      savedAt: Date.now() - (25 * 60 * 60 * 1000),
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(stale));

    const { result } = renderHook(() =>
      usePersistedBridgeDraft({
        ethAddress: ETH,
        stellarAddress: XLM,
        solanaAddress: SOL,
      }),
    );
    expect(result.current.wasRestored).toBe(false);
    expect(result.current.direction).toBe('eth_to_xlm');
    expect(result.current.amount).toBe('');
  });

  it('ignores corrupt / shape-mismatched storage without throwing', () => {
    window.localStorage.setItem(STORAGE_KEY, '{"v":99,"direction":"eth_to_sol"}');

    const { result } = renderHook(() =>
      usePersistedBridgeDraft({
        ethAddress: ETH,
        stellarAddress: XLM,
        solanaAddress: SOL,
      }),
    );
    expect(result.current.direction).toBe('eth_to_xlm');
    expect(result.current.amount).toBe('');
  });

  it('clearPersistedDraft removes the entry', () => {
    const { result } = renderHook(() =>
      usePersistedBridgeDraft({
        ethAddress: ETH,
        stellarAddress: XLM,
        solanaAddress: SOL,
      }),
    );
    act(() => result.current.setAmount('0.05'));
    expect(window.localStorage.getItem(STORAGE_KEY)).not.toBeNull();

    act(() => result.current.clearPersistedDraft());
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('never persists addresses even when amount contains them as text', () => {
    const { result } = renderHook(() =>
      usePersistedBridgeDraft({
        ethAddress: ETH,
        stellarAddress: XLM,
        solanaAddress: SOL,
      }),
    );
    // Caller is expected to pipe through sanitizeAmountInput, but we want to
    // guarantee that even raw junk text is kept verbatim — and never mixed
    // with addresses.
    act(() => result.current.setAmount('0.0001 paste-from-clipboard text'));

    const raw = JSON.parse(window.localStorage.getItem(STORAGE_KEY) as string);
    expect(raw.ethAddress).toBeUndefined();
    expect(raw.stellarAddress).toBeUndefined();
    expect(raw.fingerprint).toBe('1-1-1');
  });
});
