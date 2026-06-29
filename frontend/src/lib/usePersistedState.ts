/**
 * usePersistedState — a generic hook that persists React state to localStorage
 * so it survives page refreshes and wallet reconnection events.
 *
 * Sensitive values (private keys, preimages, signatures, etc.) should NEVER
 * be stored with this hook.
 */

import { useEffect, useRef, useState } from 'react';

const PERSIST_PREFIX = 'wafflefinance:persist:v1';

export interface PersistedStateOptions<T> {
  /** localStorage key (namespaced automatically). */
  key: string;
  /** Default value when nothing is stored yet. */
  defaultValue: T;
  /**
   * Optional serializer (defaults to JSON.stringify).
   * Can be used to sanitize values before storage.
   */
  serialize?: (value: T) => string;
  /**
   * Optional deserializer (defaults to JSON.parse).
   */
  deserialize?: (stored: string) => T;
  /**
   * If true, this value will never be written to localStorage.
   * Use for truly ephemeral state that happens to share the hook signature.
   */
  ephemeral?: boolean;
}

function storageKey(key: string): string {
  return `${PERSIST_PREFIX}:${key}`;
}

function readStoredValue<T>(key: string, deserialize: (stored: string) => T): T | null {
  try {
    const raw = localStorage.getItem(storageKey(key));
    if (raw === null) return null;
    return deserialize(raw);
  } catch {
    return null;
  }
}

function writeStoredValue<T>(key: string, value: T, serialize: (value: T) => string): void {
  try {
    localStorage.setItem(storageKey(key), serialize(value));
  } catch (err) {
    console.warn(`[usePersistedState] Failed to persist "${key}":`, err);
  }
}

export function usePersistedState<T>(
  options: PersistedStateOptions<T>,
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const {
    key,
    defaultValue,
    serialize = JSON.stringify,
    deserialize = JSON.parse as (stored: string) => T,
    ephemeral = false,
  } = options;

  const [state, setState] = useState<T>(() => {
    if (ephemeral) return defaultValue;
    const stored = readStoredValue<T>(key, deserialize);
    return stored !== null ? stored : defaultValue;
  });

  const isFirstRender = useRef(true);

  useEffect(() => {
    if (ephemeral) return;
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    writeStoredValue(key, state, serialize);
  }, [key, state, serialize, ephemeral]);

  return [state, setState];
}
