import { z } from "zod";
import type { Chain } from "../persistence/orders-repo.js";

/**
 * Centralised chain-address validation.
 *
 * These rules are the single source of truth for what a well-formed address
 * looks like on each supported chain. Both order announcements (where the
 * chain is known) and the history endpoint (where it is not) consume them so
 * that address validation stays consistent across the API.
 */

/** 0x-prefixed 20-byte Ethereum address. */
export const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** Stellar Ed25519 public key StrKey ("G..." + 55 base32 chars). */
export const STELLAR_ADDRESS = /^G[A-Z2-7]{55}$/;
/** Base-58 Solana pubkey: 32–44 chars excluding 0, O, I, l. */
export const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
/** The Ethereum zero address — never a valid counterparty. */
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
/** Order ID pattern: wf_0x followed by 64 hex chars. */
export const ORDER_ID_PATTERN = /^wf_0x[0-9a-fA-F]{64}$/;

/**
 * Returns an error message if `addr` is not well-formed for `chain`, else null.
 *
 * Exported for reuse by any route that knows which chain an address belongs to
 * (e.g. order announcements, or future /orders/:id provenance checks).
 */
export function validateChainAddress(chain: Chain, addr: string): string | null {
  if (chain === "ethereum") {
    if (!HEX_ADDRESS.test(addr)) return `${addr} is not a valid Ethereum address`;
    if (addr.toLowerCase() === ZERO_ADDRESS) return "Zero address is not a valid Ethereum address";
    return null;
  }
  if (chain === "stellar") {
    return STELLAR_ADDRESS.test(addr) ? null : `${addr} is not a valid Stellar account`;
  }
  if (chain === "solana") {
    return SOLANA_ADDRESS.test(addr) ? null : `${addr} is not a valid Solana address`;
  }
  return null;
}

/**
 * True when `addr` is a valid address on any supported chain. Used where the
 * chain is not known up front, such as a wallet-address history lookup.
 */
export function isSupportedAddress(addr: string): boolean {
  return (
    (HEX_ADDRESS.test(addr) && addr.toLowerCase() !== ZERO_ADDRESS) ||
    STELLAR_ADDRESS.test(addr) ||
    SOLANA_ADDRESS.test(addr)
  );
}

/** Human-readable summary of the formats accepted by {@link isSupportedAddress}. */
export const SUPPORTED_ADDRESS_FORMATS =
  "Ethereum (0x + 40 hex), Stellar (G + 55 base32), or Solana (base58, 32–44 chars)";

/**
 * Schema for the `address` query param of GET /orders/history. Trims input and
 * rejects anything that is not a well-formed address on a supported chain.
 */
export const historyAddressSchema = z
  .string({ required_error: "address is required", invalid_type_error: "address must be a string" })
  .trim()
  .min(1, "address is required")
  .refine(isSupportedAddress, {
    message: `address must be a valid ${SUPPORTED_ADDRESS_FORMATS}`
  });

/**
 * Schema for validating order IDs in API paths. Uses the canonical format
 * wf_0x{64 hex chars}.
 */
export const orderIdSchema = z
  .string({ required_error: "order ID is required", invalid_type_error: "order ID must be a string" })
  .trim()
  .min(1, "order ID is required")
  .refine((id) => ORDER_ID_PATTERN.test(id), {
    message: `order ID must match format wf_0x{64 hex chars}`
  });
