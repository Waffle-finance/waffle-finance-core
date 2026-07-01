/**
 * usePersistedBridgeDraft — restore the user's bridge form draft after
 * refreshes or wallet reconnects.
 *
 * Acceptance criteria (from issue #174)
 * ─────────────────────────────────────
 * - UI preserves relevant state across refreshes / reconnects.
 * - Sensitive state is NOT persisted inappropriately.
 *
 * What we persist
 * ───────────────
 * - `direction` (a route enum, no personal data)
 * - `amount`    (a sanitized numeric input, no addresses)
 * - a coarse wallet-presence fingerprint so the draft does not leak across
 *   different wallet sessions (we do NOT store the addresses themselves)
 *
 * What we explicitly do NOT persist
 * ─────────────────────────────────
 * - Wallet addresses, account ids, preimages, hashlocks, signatures, tx
 *   hashes, XDRs, memo text, or anything else that could be sensitive.
 *
 * Storage
 * ───────
 * - Versioned localStorage key `wafflefinance_bridge_draft_v1`.
 * - 24-hour expiry so an old draft does not surprise the user after a long
 *   gap.
 * - SSR-safe: window/localStorage are guarded.
 *
 * Implementation note
 * ──────────────────
 * Persistence is driven by a `useEffect` watching `direction`, `amount`,
 * `fingerprint`. React guarantees effects run after the committed render,
 * so the values read here are always the latest — no stale-closure hazard.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";

type BridgeDirection =
  | "eth_to_xlm"
  | "xlm_to_eth"
  | "eth_to_sol"
  | "sol_to_eth"
  | "xlm_to_sol"
  | "sol_to_xlm";

const STORAGE_KEY = "wafflefinance_bridge_draft_v1";
const DRAFT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface StoredDraft {
  /** Schema version. Bump when shape changes so older entries are dropped. */
  v: 1;
  direction: BridgeDirection;
  /** Sanitized numeric input. Already passed through `sanitizeAmountInput`. */
  amount: string;
  /** Wallet-presence fingerprint when the draft was saved. */
  fingerprint: string;
  /** Epoch ms. */
  savedAt: number;
}

interface UsePersistedBridgeDraftParams {
  ethAddress: string;
  stellarAddress: string;
  solanaAddress: string | undefined;
}

interface UsePersistedBridgeDraftResult {
  direction: BridgeDirection;
  amount: string;
  /**
   * Setter for `direction`, matching React's `useState` API.
   * Accepts either a value or an updater function `(prev) => next`.
   */
  setDirection: Dispatch<SetStateAction<BridgeDirection>>;
  setAmount: Dispatch<SetStateAction<string>>;
  /** Returns true if the loaded value came from persistent storage. */
  wasRestored: boolean;
  /** Clear any persisted draft (used by `New Bridge` reset flows). */
  clearPersistedDraft: () => void;
}

const DEFAULT_DIRECTION: BridgeDirection = "eth_to_xlm";

function isBridgeDirection(value: unknown): value is BridgeDirection {
  return (
    value === "eth_to_xlm" ||
    value === "xlm_to_eth" ||
    value === "eth_to_sol" ||
    value === "sol_to_eth" ||
    value === "xlm_to_sol" ||
    value === "sol_to_xlm"
  );
}

/**
 * Coarse presence fingerprint — one bit per chain.
 *
 * We deliberately store ONLY booleans indicating which chains were connected,
 * never the addresses. A draft saved with a 2/3 wallet configuration is
 * reusable whenever the user reconnects in that exact configuration;
 * differently shaped wallets get a fresh default.
 */
function computeFingerprint(
  eth: string,
  stellar: string,
  solana: string,
): string {
  return `${eth ? 1 : 0}-${stellar ? 1 : 0}-${solana ? 1 : 0}`;
}

function readDraft(): StoredDraft | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredDraft>;
    if (
      parsed?.v !== 1 ||
      typeof parsed.savedAt !== "number" ||
      typeof parsed.fingerprint !== "string" ||
      typeof parsed.amount !== "string" ||
      !isBridgeDirection(parsed.direction)
    ) {
      return null;
    }
    if (Date.now() - parsed.savedAt >= DRAFT_TTL_MS) return null;
    return parsed as StoredDraft;
  } catch {
    // localStorage may be disabled or the JSON corrupt — fall back to defaults.
    return null;
  }
}

function writeDraft(draft: Omit<StoredDraft, "v">): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ v: 1, ...draft } satisfies StoredDraft),
    );
  } catch {
    // QuotaExceeded errors are not fatal — the form still works in-memory.
  }
}

function clearDraft(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export function usePersistedBridgeDraft({
  ethAddress,
  stellarAddress,
  solanaAddress,
}: UsePersistedBridgeDraftParams): UsePersistedBridgeDraftResult {
  const fingerprint = useMemo(
    () => computeFingerprint(ethAddress, stellarAddress, solanaAddress ?? ""),
    [ethAddress, stellarAddress, solanaAddress],
  );

  // One-shot read on mount so we don't have to keep re-checking storage.
  const initialRef = useRef<{ direction: BridgeDirection; amount: string; wasRestored: boolean } | null>(null);
  if (initialRef.current === null) {
    const stored = readDraft();
    initialRef.current =
      stored && stored.fingerprint === fingerprint
        ? {
            direction: stored.direction,
            amount: stored.amount,
            wasRestored: true,
          }
        : {
            direction: DEFAULT_DIRECTION,
            amount: "",
            wasRestored: false,
          };
  }

  const [direction, setDirectionState] = useState<BridgeDirection>(initialRef.current.direction);
  const [amount, setAmountState] = useState<string>(initialRef.current.amount);
  const [wasRestored, setWasRestored] = useState<boolean>(initialRef.current.wasRestored);

  // `isFirstRender` guards the persistence effect below. We don't want to
  // write a fresh default-value entry on every initial mount — a user that
  // visits but never interacts would still get a default
  // `direction: 'eth_to_xlm', amount: ''` row filed.
  const isFirstRender = useRef(true);

  // Forget a stale draft when the wallet configuration changes shape. This
  // also resets in-memory state so the user doesn't see a stale route/amount
  // rendered against a wallet they are no longer connected to. We also clear
  // the first-render guard so the next persist effect does not resurrect the
  // entry we just removed.
  useEffect(() => {
    const stored = readDraft();
    if (stored && stored.fingerprint !== fingerprint) {
      clearDraft();
      setDirectionState(DEFAULT_DIRECTION);
      setAmountState("");
      setWasRestored(false);
      isFirstRender.current = true;
    }
  }, [fingerprint]);

  // Write through to localStorage whenever any user-updatable field is
  // committed AND we've already mounted at least once. Effects read the
  // latest committed state, so there is no stale-closure hazard here.
  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    writeDraft({ direction, amount, fingerprint, savedAt: Date.now() });
  }, [direction, amount, fingerprint]);

  const clearPersistedDraft = useCallback(() => {
    clearDraft();
  }, []);

  // Expose React's native setters directly so callers can use both the value
  // and the `(prev) => next` updater forms without our wrapper losing
  // staleness information.
  return {
    direction,
    amount,
    setDirection: setDirectionState,
    setAmount: setAmountState,
    wasRestored,
    clearPersistedDraft,
  };
}
