import { useCallback, useEffect, useMemo, useState } from 'react';
import { usePersistedBridgeDraft } from './usePersistedBridgeDraft';

const STORAGE_KEY = 'wafflefinance_bridge_session_v1';
const TTL_MS = 24 * 60 * 60 * 1000;

export interface BridgeSessionRecord {
  v: 1;
  direction: string;
  amount: string;
  fromCanonicalId?: string;
  toCanonicalId?: string;
  fingerprint: string;
  savedAt: number;
}

function readSession(): BridgeSessionRecord | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<BridgeSessionRecord>;
    if (parsed?.v !== 1 || typeof parsed.savedAt !== 'number') return null;
    if (Date.now() - parsed.savedAt >= TTL_MS) return null;
    return parsed as BridgeSessionRecord;
  } catch {
    return null;
  }
}

function writeSession(s: Omit<BridgeSessionRecord, 'v' | 'savedAt'>) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, ...s, savedAt: Date.now() }));
  } catch {
    // ignore
  }
}

function clearSessionStorage() {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {}
}

export function useBridgeSession({ ethAddress, stellarAddress, solanaAddress }: { ethAddress: string; stellarAddress: string; solanaAddress?: string }) {
  const draft = usePersistedBridgeDraft({ ethAddress, stellarAddress, solanaAddress: solanaAddress ?? '' });

  const initial = useMemo(() => {
    const stored = readSession();
    if (!stored) return null;
    // Only restore if fingerprint matches current presence
    const currentFp = `${ethAddress ? 1 : 0}-${stellarAddress ? 1 : 0}-${solanaAddress ? 1 : 0}`;
    if (stored.fingerprint !== currentFp) return null;
    return stored;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [fromCanonicalId, setFromCanonicalId] = useState<string | undefined>(initial?.fromCanonicalId);
  const [toCanonicalId, setToCanonicalId] = useState<string | undefined>(initial?.toCanonicalId);

  useEffect(() => {
    const fp = `${ethAddress ? 1 : 0}-${stellarAddress ? 1 : 0}-${solanaAddress ? 1 : 0}`;
    writeSession({ direction: draft.direction, amount: draft.amount, fromCanonicalId, toCanonicalId, fingerprint: fp });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.direction, draft.amount, fromCanonicalId, toCanonicalId, ethAddress, stellarAddress, solanaAddress]);

  const clear = useCallback(() => {
    clearSessionStorage();
    draft.clearPersistedDraft();
    setFromCanonicalId(undefined);
    setToCanonicalId(undefined);
  }, [draft]);

  return {
    direction: draft.direction,
    amount: draft.amount,
    setDirection: draft.setDirection,
    setAmount: draft.setAmount,
    wasRestored: draft.wasRestored,
    clearPersistedDraft: draft.clearPersistedDraft,
    fromCanonicalId,
    toCanonicalId,
    setFromCanonicalId,
    setToCanonicalId,
    clearSession: clear,
  } as const;
}

export default useBridgeSession;
