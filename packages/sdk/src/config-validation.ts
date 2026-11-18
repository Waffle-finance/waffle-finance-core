import { Address as SorobanAddress, Networks } from "@stellar/stellar-sdk";
import { PublicKey } from "@solana/web3.js";
import { getAddress, isAddress, type Address } from "viem";
import { assertSupportedRoute, directionForChains, type RouteDefinition } from "./routes/index.js";
import type { AssetMappingNetwork } from "./assets/index.js";
import type { Chain } from "./types/index.js";

export type SdkConfigIssueCode =
  | "missing_required_config"
  | "invalid_rpc_url"
  | "invalid_chain_id"
  | "invalid_address"
  | "invalid_network"
  | "unsupported_chain_pair";

export interface SdkConfigIssue {
  field: string;
  code: SdkConfigIssueCode;
  message: string;
}

export class SdkConfigurationError extends Error {
  constructor(
    message: string,
    public readonly issues: ReadonlyArray<SdkConfigIssue>,
  ) {
    super(`${message}: ${issues.map((i) => `${i.field} ${i.message}`).join("; ")}`);
    this.name = "SdkConfigurationError";
  }
}

function requireText(value: unknown, field: string, issues: SdkConfigIssue[]): string | null {
  if (typeof value !== "string" || value.trim() === "") {
    issues.push({
      field,
      code: "missing_required_config",
      message: "is required and must be a non-empty string",
    });
    return null;
  }
  return value.trim();
}

export function validateRpcUrl(value: unknown, field = "rpcUrl", options: { allowHttp?: boolean } = {}): string {
  const issues: SdkConfigIssue[] = [];
  const text = requireText(value, field, issues);
  if (text) {
    try {
      const url = new URL(text);
      const protocolOk = url.protocol === "https:" || (options.allowHttp && url.protocol === "http:");
      if (!protocolOk) {
        issues.push({
          field,
          code: "invalid_rpc_url",
          message: options.allowHttp
            ? "must be an http(s) URL"
            : "must be an https URL; pass allowHttp only for local sandboxes",
        });
      }
    } catch {
      issues.push({ field, code: "invalid_rpc_url", message: "must be a valid absolute URL" });
    }
  }
  if (issues.length) throw new SdkConfigurationError("Invalid SDK configuration", issues);
  return text!;
}

export function validateChainId(value: unknown, field = "chainId"): number {
  const numeric = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) {
    throw new SdkConfigurationError("Invalid SDK configuration", [{
      field,
      code: "invalid_chain_id",
      message: "must be a positive safe integer",
    }]);
  }
  return numeric;
}

export function validateEthereumAddress(value: unknown, field = "address"): Address {
  const issues: SdkConfigIssue[] = [];
  const text = requireText(value, field, issues);
  if (text && !isAddress(text)) {
    issues.push({ field, code: "invalid_address", message: "must be a 20-byte EVM address" });
  }
  if (issues.length) throw new SdkConfigurationError("Invalid SDK configuration", issues);
  return getAddress(text!) as Address;
}

export function validateSolanaAddress(value: unknown, field = "address"): string {
  const issues: SdkConfigIssue[] = [];
  const text = requireText(value, field, issues);
  if (text) {
    try {
      return new PublicKey(text).toBase58();
    } catch {
      issues.push({ field, code: "invalid_address", message: "must be a valid Solana public key" });
    }
  }
  throw new SdkConfigurationError("Invalid SDK configuration", issues);
}

export function validateSorobanAddress(value: unknown, field = "address"): string {
  const issues: SdkConfigIssue[] = [];
  const text = requireText(value, field, issues);
  if (text) {
    try {
      return new SorobanAddress(text).toString();
    } catch {
      issues.push({ field, code: "invalid_address", message: "must be a valid Stellar account or contract address" });
    }
  }
  throw new SdkConfigurationError("Invalid SDK configuration", issues);
}

export function validateNetworkPassphrase(value: unknown, field = "networkPassphrase"): string {
  const text = requireText(value, field, []);
  if (!text) {
    throw new SdkConfigurationError("Invalid SDK configuration", [{
      field,
      code: "missing_required_config",
      message: "is required and must be a non-empty string",
    }]);
  }
  const known = new Set<string>([Networks.PUBLIC, Networks.TESTNET, Networks.FUTURENET, Networks.SANDBOX, Networks.STANDALONE]);
  if (!known.has(text)) {
    throw new SdkConfigurationError("Invalid SDK configuration", [{
      field,
      code: "invalid_network",
      message: "must be a recognized Stellar network passphrase",
    }]);
  }
  return text;
}

export interface ChainPairValidationInput {
  src: Chain;
  dst: Chain;
  network?: AssetMappingNetwork;
  tokenGroup?: string;
}

export function validateChainPair(input: ChainPairValidationInput): RouteDefinition {
  const direction = directionForChains(input.src, input.dst);
  if (!direction) {
    throw new SdkConfigurationError("Invalid SDK configuration", [{
      field: "chainPair",
      code: "unsupported_chain_pair",
      message: `${input.src}->${input.dst} is not declared in the SDK route matrix`,
    }]);
  }
  return assertSupportedRoute({
    direction,
    network: input.network,
    tokenGroup: input.tokenGroup,
  });
}

