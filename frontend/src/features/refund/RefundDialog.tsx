import { useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Clock, RefreshCw, ShieldCheck } from "lucide-react";
import { createWalletClient, createPublicClient, custom, http, type Address } from "viem";
import { mainnet, sepolia } from "viem/chains";
import { makeEthereumHTLCClient } from "../../lib/sdk-context";
import { isTestnet } from "../../config/networks";
import { useNetworkMode } from "../../lib/useNetworkMode";
import { useFocusTrap } from "../../hooks/useFocusTrap";

/**
 * Two on-chain refund flavors are supported:
 *
 * - `v2-escrow`: the new HTLCEscrow contract (testnet today, mainnet at v2 launch).
 *   `orderId` is a uint256, refund is `refundOrder(uint256)`.
 * - `v1-mainnet-htlc`: the legacy MainnetHTLC contract currently powering mainnet.
 *   `orderId` is a bytes32, refund is `refundOrder(bytes32)`.
 *
 * Both paths are permissionless once the timelock has expired — the
 * user's wallet calls the contract directly, no coordinator involved.
 */
export type RefundContractMode = "v2-escrow" | "v1-mainnet-htlc";

const MAINNET_HTLC_ABI = [
  {
    name: "refundOrder",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "orderId", type: "bytes32" }],
    outputs: [],
  },
] as const;

export interface RefundDialogProps {
  /** Ethereum address of the user (used as wallet signer). */
  userAddress: Address;
  /**
   * On-chain order id.
   * - `v2-escrow`: decimal/hex uint256 string (e.g. "42" or "0x2a").
   * - `v1-mainnet-htlc`: 0x-prefixed 32-byte hex string (bytes32).
   */
  orderId: string;
  /** Absolute timelock as unix seconds (server-side timestamp). */
  timelockUnixSeconds: number;
  /** Locked amount in atomic units (wei) for display. */
  amountWei: string;
  /** Which on-chain contract should be called. Defaults to v2-escrow. */
  contractMode?: RefundContractMode;
  /**
   * For `v1-mainnet-htlc`, the contract address to call. Required when
   * `contractMode = 'v1-mainnet-htlc'`.
   */
  v1ContractAddress?: Address;
  /** Optional callback invoked after a successful refund. */
  onRefunded?: (txHash: `0x${string}`) => void;
  /** Optional cancel/close handler for parent modal. */
  onClose?: () => void;
}

type Phase = "checking" | "waiting" | "ready" | "submitting" | "done" | "error";

function formatRemaining(seconds: number): string {
  if (seconds <= 0) return "expired";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

/**
 * Permissionless refund flow for an Ethereum-side HTLC order.
 *
 * If the timelock has expired the user can call `refundOrder` directly
 * on the contract from their own wallet — the coordinator is NOT
 * involved. This is the v2 capability that was missing in v1.
 */
export function RefundDialog(props: RefundDialogProps) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  const containerRef = useRef<HTMLDivElement>(null);
  const titleId = "refund-dialog-title";

  // Trap focus inside this dialog while it is mounted.
  useFocusTrap(containerRef, true);

  const networkState = useNetworkMode({ ethAddress: props.userAddress });

  // Dismiss on Escape key.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") props.onClose?.();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [props.onClose]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 5_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    setPhase(props.timelockUnixSeconds <= now ? "ready" : "waiting");
  }, [props.timelockUnixSeconds, now]);

  const remaining = useMemo(
    () => Math.max(props.timelockUnixSeconds - now, 0),
    [props.timelockUnixSeconds, now]
  );

  async function handleRefund() {
    if (networkState.hasAnyMismatch) {
      setError(
        `Wallet connected to ${networkState.metamaskChainId === "0x1" ? "Mainnet" : "wrong network"} while app is in ${networkState.mode === "testnet" ? "Testnet" : "Mainnet"} mode. Switch networks to continue.`
      );
      setPhase("error");
      return;
    }

    setError(null);
    setPhase("submitting");
    try {
      const mode: RefundContractMode = props.contractMode ?? "v2-escrow";

      let hash: `0x${string}`;
      if (mode === "v2-escrow") {
        const client = await makeEthereumHTLCClient(props.userAddress);
        if (!client) {
          throw new Error(
            "HTLCEscrow address is not configured for this network. v2 is testnet-only; switch to testnet to refund."
          );
        }
        hash = await client.refundOrder(BigInt(props.orderId));
      } else {
        if (!props.v1ContractAddress) {
          throw new Error("v1-mainnet-htlc refund requires `v1ContractAddress` prop.");
        }
        if (typeof window === "undefined" || !window.ethereum) {
          throw new Error("No injected wallet found.");
        }
        const orderIdBytes32 = props.orderId.startsWith("0x")
          ? (props.orderId as `0x${string}`)
          : (`0x${props.orderId}` as `0x${string}`);
        if (orderIdBytes32.length !== 66) {
          throw new Error("v1 mainnet refund requires a 0x-prefixed bytes32 order id.");
        }
        const chain = isTestnet() ? sepolia : mainnet;
        const rpcUrl = isTestnet()
          ? (import.meta as any).env.VITE_SEPOLIA_RPC_URL
          : (import.meta as any).env.VITE_MAINNET_RPC_URL;
        const publicClient = createPublicClient({
          chain,
          transport: rpcUrl ? http(rpcUrl) : http(),
        });
        const walletClient = createWalletClient({
          chain,
          transport: custom(window.ethereum),
          account: props.userAddress,
        });
        const { request } = await publicClient.simulateContract({
          address: props.v1ContractAddress,
          abi: MAINNET_HTLC_ABI,
          functionName: "refundOrder",
          args: [orderIdBytes32],
          account: props.userAddress,
        });
        hash = await walletClient.writeContract(request);
      }

      setTxHash(hash);
      setPhase("done");
      props.onRefunded?.(hash);
    } catch (err) {
      setError(err instanceof Error ? err.message : "unknown error");
      setPhase("error");
    }
  }

  const explorer = isTestnet() ? "https://sepolia.etherscan.io" : "https://etherscan.io";

  // Human-readable status for the aria-live status region.
  const statusAnnouncement =
    phase === "submitting" ? "Submitting refund transaction…" :
    phase === "done"       ? "Refund submitted successfully." :
    phase === "error"      ? `Refund failed: ${error ?? "unknown error"}` :
    phase === "waiting"    ? `Refund not yet available. Time remaining: ${formatRemaining(remaining)}` :
    phase === "ready"      ? "The timelock has expired. You can refund this order." :
    "";

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      className="max-w-md rounded-2xl border border-cyan-200/20 bg-[#070b1c]/95 p-6 shadow-2xl shadow-black/55 backdrop-blur-2xl w-full"
    >
      {/* Hidden live region — announces phase changes to screen readers */}
      <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
        {statusAnnouncement}
      </div>

      <div className="flex items-start justify-between mb-4">
        <div>
          <h2 id={titleId} className="text-xl font-bold text-white mb-1">Refund order</h2>
          <p className="text-gray-400 text-sm">
            Refund is permissionless — your wallet calls the contract directly.
          </p>
        </div>
        {props.onClose && (
          <button
            onClick={props.onClose}
            className="text-gray-400 hover:text-white transition-colors text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400 rounded"
            aria-label="Close refund dialog"
          >
            ✕
          </button>
        )}
      </div>

      <dl className="space-y-2 mb-4 text-sm">
        <div className="flex justify-between">
          <dt className="text-gray-400">Order id</dt>
          <dd className="text-white font-mono">{props.orderId}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-gray-400">Locked amount</dt>
          <dd className="text-white font-mono">{props.amountWei} wei</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-gray-400">Timelock</dt>
          <dd className="text-white">{new Date(props.timelockUnixSeconds * 1000).toISOString()}</dd>
        </div>
      </dl>

      {phase === "waiting" && (
        <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3 flex items-center gap-2 mb-4">
          <Clock className="h-5 w-5 text-yellow-400" aria-hidden="true" />
          <div className="text-sm">
            <p className="text-yellow-300">Refund not yet available.</p>
            <p className="text-gray-400">Time remaining: {formatRemaining(remaining)}</p>
          </div>
        </div>
      )}

      {phase === "ready" && (
        <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-3 flex items-center gap-2 mb-4">
          <ShieldCheck className="h-5 w-5 text-emerald-400" aria-hidden="true" />
          <p className="text-sm text-emerald-300">
            The timelock has expired. You can refund this order at any time.
          </p>
        </div>
      )}

      {phase === "error" && error && (
        <div
          role="alert"
          className="bg-red-500/10 border border-red-500/30 rounded-lg p-3 flex items-start gap-2 mb-4"
        >
          <AlertCircle className="h-5 w-5 text-red-400 mt-0.5" aria-hidden="true" />
          <div className="text-sm">
            <p className="text-red-300 font-medium">Refund failed</p>
            <p className="text-gray-400 break-all">{error}</p>
          </div>
        </div>
      )}

      {phase === "done" && txHash && (
        <div className="bg-emerald-500/10 border border-emerald-500/30 rounded-lg p-3 mb-4">
          <p className="text-sm text-emerald-300 font-medium mb-1">Refund submitted.</p>
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
        onClick={handleRefund}
        disabled={(phase !== "ready" && phase !== "error") || networkState.hasAnyMismatch}
        className="brand-cta flex w-full items-center justify-center gap-2 rounded-lg px-4 py-3 font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
      >
        {phase === "submitting" && <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />}
        {phase === "submitting" ? "Submitting refund…" : "Refund from contract"}
      </button>
    </div>
  );
}

export default RefundDialog;
