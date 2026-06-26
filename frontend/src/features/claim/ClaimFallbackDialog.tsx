import { useEffect, useState } from "react";
import { AlertCircle, CheckCircle2, RefreshCw, WifiOff } from "lucide-react";
import type { Address, Hex } from "viem";
import { makeEthereumHTLCClient } from "../../lib/sdk-context";
import { useNetworkMode } from "../../lib/useNetworkMode";

export interface ClaimFallbackDialogProps {
  /** Ethereum address of the user (used as wallet signer). */
  userAddress: Address;
  /**
   * On-chain order id as a decimal or hex uint256 string.
   * Passed directly to `claimOrder(BigInt(orderId), preimage)`.
   */
  orderId: string;
  /**
   * The HTLC preimage (secret) as a 0x-prefixed hex string.
   * This value is submitted directly to the HTLCEscrow contract and is
   * never sent to any third-party service.
   */
  preimage: Hex;
  /**
   * Base URL of the coordinator (e.g. "https://api.example.com").
   * Used only to probe availability — the preimage is NOT forwarded there.
   */
  coordinatorUrl: string;
  /** Called with the transaction hash after a successful on-chain claim. */
  onClaimed?: (txHash: string) => void;
  /** Optional close / cancel handler. */
  onClose?: () => void;
}

type Phase =
  | "checking"        // probing coordinator health
  | "coordinator-up"  // coordinator is reachable — fallback not needed
  | "fallback"        // coordinator is down — direct claim is available
  | "submitting"      // claim tx is in flight
  | "done"            // claim confirmed
  | "error";          // claim failed

/**
 * Pings `${coordinatorUrl}/health` with a 4-second timeout.
 * Returns true when the coordinator is reachable and returns 2xx.
 * The preimage is never forwarded to the coordinator URL.
 */
async function probeCoordinator(coordinatorUrl: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 4_000);
    const res = await fetch(`${coordinatorUrl}/health`, {
      method: "GET",
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Fallback secret-reveal / claim dialog for the Ethereum destination HTLC.
 *
 * The normal flow delegates to the coordinator to relay secrets between
 * chains, but if the coordinator is offline the bridge must remain usable.
 * This component detects coordinator unavailability and surfaces a direct
 * `claimOrder(orderId, preimage)` call the user can execute from their own
 * wallet — no reliance on any centralised service.
 *
 * Security: the preimage is only ever submitted to the on-chain HTLCEscrow
 * contract via the user's injected wallet. It is never sent to the
 * coordinator URL or any other external service.
 */
export function ClaimFallbackDialog(props: ClaimFallbackDialogProps) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const networkState = useNetworkMode({ ethAddress: props.userAddress });

  useEffect(() => {
    let cancelled = false;
    probeCoordinator(props.coordinatorUrl).then((up) => {
      if (cancelled) return;
      setPhase(up ? "coordinator-up" : "fallback");
    });
    return () => { cancelled = true; };
  }, [props.coordinatorUrl]);

  async function handleDirectClaim() {
    if (networkState.hasAnyMismatch) {
      setError(
        `Wallet is on the wrong network for ${networkState.mode} mode. Switch networks to continue.`
      );
      setPhase("error");
      return;
    }

    setError(null);
    setPhase("submitting");
    try {
      const client = await makeEthereumHTLCClient(props.userAddress);
      if (!client) {
        throw new Error(
          "HTLCEscrow address is not configured for this network. " +
          "v2 is testnet-only — switch to testnet to claim."
        );
      }
      const hash = await client.claimOrder(BigInt(props.orderId), props.preimage);
      setTxHash(hash);
      setPhase("done");
      props.onClaimed?.(hash);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error during claim");
      setPhase("error");
    }
  }

  const isTestnet = networkState.mode === "testnet";
  const explorer = isTestnet ? "https://sepolia.etherscan.io" : "https://etherscan.io";

  return (
    <div className="max-w-md rounded-2xl border border-cyan-200/20 bg-[#070b1c]/95 p-6 shadow-2xl shadow-black/55 backdrop-blur-2xl w-full">
      <div className="flex items-start justify-between mb-4">
        <div>
          <h2 className="text-xl font-bold text-white mb-1">Claim order</h2>
          <p className="text-gray-400 text-sm">
            Direct on-chain claim — your wallet calls the contract directly.
          </p>
        </div>
        {props.onClose && (
          <button
            onClick={props.onClose}
            className="text-gray-400 hover:text-white transition-colors text-sm"
            aria-label="Close"
          >
            ✕
          </button>
        )}
      </div>

      <dl className="space-y-2 mb-4 text-sm">
        <div className="flex justify-between">
          <dt className="text-gray-400">Order id</dt>
          <dd className="text-white font-mono text-xs truncate max-w-[200px]">{props.orderId}</dd>
        </div>
      </dl>

      {phase === "checking" && (
        <div className="bg-gray-500/10 border border-gray-500/30 rounded-lg p-3 flex items-center gap-2 mb-4">
          <RefreshCw className="h-5 w-5 text-gray-400 animate-spin" />
          <p className="text-sm text-gray-300">Checking coordinator availability…</p>
        </div>
      )}

      {phase === "coordinator-up" && (
        <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-3 flex items-start gap-2 mb-4">
          <CheckCircle2 className="h-5 w-5 text-emerald-400 mt-0.5 shrink-0" />
          <div className="text-sm">
            <p className="text-emerald-300 font-medium">Coordinator is available</p>
            <p className="text-gray-400">
              Use the standard claim flow — the coordinator will relay the secret
              to the destination chain automatically.
            </p>
          </div>
        </div>
      )}

      {(phase === "fallback" || phase === "error") && phase !== "error" && (
        <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3 flex items-start gap-2 mb-4">
          <WifiOff className="h-5 w-5 text-yellow-400 mt-0.5 shrink-0" />
          <div className="text-sm">
            <p className="text-yellow-300 font-medium">Coordinator unavailable — fallback mode</p>
            <p className="text-gray-400">
              The coordinator is offline. You can still claim your funds by
              submitting the secret directly to the on-chain contract from your wallet.
            </p>
          </div>
        </div>
      )}

      {phase === "error" && error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 flex items-start gap-2 mb-4">
          <AlertCircle className="h-5 w-5 text-red-400 mt-0.5 shrink-0" />
          <div className="text-sm">
            <p className="text-red-300 font-medium">Claim failed</p>
            <p className="text-gray-400 break-all">{error}</p>
          </div>
        </div>
      )}

      {phase === "done" && txHash && (
        <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-3 mb-4">
          <p className="text-sm text-emerald-300 font-medium mb-1">Claim submitted.</p>
          <a
            href={`${explorer}/tx/${txHash}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-blue-400 hover:underline break-all"
          >
            {txHash}
          </a>
        </div>
      )}

      <button
        onClick={handleDirectClaim}
        disabled={
          phase === "checking" ||
          phase === "coordinator-up" ||
          phase === "submitting" ||
          phase === "done" ||
          networkState.hasAnyMismatch
        }
        className="brand-cta flex w-full items-center justify-center gap-2 rounded-lg px-4 py-3 font-semibold transition disabled:cursor-not-allowed disabled:opacity-50"
      >
        {phase === "submitting" && <RefreshCw className="h-4 w-4 animate-spin" />}
        {phase === "submitting" ? "Submitting claim…" : "Claim directly on-chain"}
      </button>

      {phase === "coordinator-up" && (
        <p className="text-xs text-gray-500 text-center mt-2">
          Fallback is not needed while the coordinator is reachable.
        </p>
      )}
    </div>
  );
}

export default ClaimFallbackDialog;
