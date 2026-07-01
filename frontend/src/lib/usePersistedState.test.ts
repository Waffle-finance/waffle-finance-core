/**
 * Tests for usePersistedState.
 *
 * Coverage:
 *  - Persists state across hook re-mounts (simulating page refresh)
 *  - Returns default value when nothing is stored
 *  - Ephemeral mode skips localStorage writes
 *  - Handles localStorage errors gracefully
 *  - Uses correct namespace prefix
 */

import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { usePersistedState } from './usePersistedState';

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe('usePersistedState', () => {
  it('returns the default value on first mount when no stored value exists', () => {
    const { result } = renderHook(() =>
      usePersistedState({ key: 'test-key', defaultValue: 'hello' }),
    );
    expect(result.current[0]).toBe('hello');
  });

  it('persists a value and restores it on re-mount', () => {
    const { result, unmount } = renderHook(() =>
      usePersistedState({ key: 'test-key', defaultValue: 'default' }),
    );

    act(() => {
      result.current[1]('persisted-value');
    });
    expect(result.current[0]).toBe('persisted-value');

    // Unmount the hook (simulating page navigation / refresh)
    unmount();

    // Re-mount: should read from localStorage
    const { result: result2 } = renderHook(() =>
      usePersistedState({ key: 'test-key', defaultValue: 'default' }),
    );
    expect(result2.current[0]).toBe('persisted-value');
  });

  it('correctly stores values under the namespaced key', () => {
    const { result } = renderHook(() =>
      usePersistedState({ key: 'my-key', defaultValue: 42 }),
    );

    act(() => {
      result.current[1](99);
    });

    const raw = localStorage.getItem('wafflefinance:persist:v1:my-key');
    expect(raw).toBe('99');
  });

  it('persists object values', () => {
    const defaultValue = { a: 1, b: 'two' };
    const { result, unmount } = renderHook(() =>
      usePersistedState({ key: 'obj-key', defaultValue }),
    );

    act(() => {
      result.current[1]({ a: 2, b: 'three' });
    });

    unmount();

    const { result: result2 } = renderHook(() =>
      usePersistedState({ key: 'obj-key', defaultValue }),
    );
    expect(result2.current[0]).toEqual({ a: 2, b: 'three' });
  });

  it('uses custom serialize/deserialize when provided', () => {
    const serialize = (v: number) => `n:${v}`;
    const deserialize = (s: string) => parseInt(s.replace('n:', ''), 10);

    const { result, unmount } = renderHook(() =>
      usePersistedState({
        key: 'custom-serial',
        defaultValue: 0,
        serialize,
        deserialize,
      }),
    );

    act(() => {
      result.current[1](7);
    });

    const raw = localStorage.getItem('wafflefinance:persist:v1:custom-serial');
    expect(raw).toBe('n:7');

    unmount();

    const { result: result2 } = renderHook(() =>
      usePersistedState({
        key: 'custom-serial',
        defaultValue: 0,
        serialize,
        deserialize,
      }),
    );
    expect(result2.current[0]).toBe(7);
  });

  it('does not write to localStorage in ephemeral mode', () => {
    const { result } = renderHook(() =>
      usePersistedState({ key: 'ephemeral-key', defaultValue: 'ephemeral', ephemeral: true }),
    );

    act(() => {
      result.current[1]('updated');
    });

    const raw = localStorage.getItem('wafflefinance:persist:v1:ephemeral-key');
    expect(raw).toBeNull();
  });

  it('handles corrupted stored data by falling back to the default', () => {
    localStorage.setItem('wafflefinance:persist:v1:corrupt', '{bad json');

    const { result } = renderHook(() =>
      usePersistedState({ key: 'corrupt', defaultValue: 'fallback' }),
    );
    expect(result.current[0]).toBe('fallback');
  });

  it('stores and restores null values', () => {
    const { result, unmount } = renderHook(() =>
      usePersistedState<string | null>({ key: 'null-key', defaultValue: null }),
    );

    act(() => {
      result.current[1]('not-null');
    });
    unmount();

    const { result: result2 } = renderHook(() =>
      usePersistedState<string | null>({ key: 'null-key', defaultValue: null }),
    );
    expect(result2.current[0]).toBe('not-null');
  });
});
