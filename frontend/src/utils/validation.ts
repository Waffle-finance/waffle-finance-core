/**
 * Cross-chain form validation utilities.
 *
 * These helpers surface edge cases — unsupported routes, malformed addresses,
 * amount constraints — before a request hits the relayer.
 *
 * All user-facing messages are sourced from the i18n catalog so they can be
 * translated without touching this file.
 */

import { t } from '../i18n';

export type ValidationResult =
  | { isValid: true }
  | { isValid: false; message: string };

/** Ethereum address: 0x-prefixed, 42 chars, hex. */
export function validateEthereumAddress(value: string): ValidationResult {
  if (!value) return { isValid: false, message: t('validation.ethereum.required') };
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    return { isValid: false, message: t('validation.ethereum.invalid') };
  }
  return { isValid: true };
}

/** Stellar address: starts with G, max 56 chars, base32. */
export function validateStellarAddress(value: string): ValidationResult {
  if (!value) return { isValid: false, message: t('validation.stellar.required') };
  if (value.startsWith("$") || value.startsWith("M")) {
    return { isValid: false, message: t('validation.stellar.memoNotAccepted') };
  }
  if (!/^G[A-Z2-7]{55}$/.test(value)) {
    return { isValid: false, message: t('validation.stellar.invalid') };
  }
  return { isValid: true };
}

/** Solana address: base58, 32-44 chars. */
export function validateSolanaAddress(value: string): ValidationResult {
  if (!value) return { isValid: false, message: t('validation.solana.required') };
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)) {
    return { isValid: false, message: t('validation.solana.invalid') };
  }
  return { isValid: true };
}

/** Positive decimal string with bounded decimals. */
export function validateAmount(
  value: string,
  maxDecimals: number,
  min = "0"
): ValidationResult {
  if (!value) return { isValid: false, message: t('validation.amount.required') };
  if (Number(value) <= 0) return { isValid: false, message: t('validation.amount.tooLow') };
  const decimalPart = value.split(".")[1];
  if (decimalPart && decimalPart.length > maxDecimals) {
    return { isValid: false, message: t('validation.amount.tooManyDecimals', { maxDecimals }) };
  }
  if (Number(value) < Number(min)) {
    return { isValid: false, message: t('validation.amount.belowMinimum', { min }) };
  }
  return { isValid: true };
}

/** Ensure the user's wallet balance covers the requested amount. */
export function validateBalance(
  amount: string,
  balance: string,
  symbol: string
): ValidationResult {
  if (!amount || !balance) return { isValid: true };
  const a = parseFloat(amount);
  const b = parseFloat(balance);
  if (a > b) {
    return { isValid: false, message: t('validation.balance.insufficient', { symbol, balance: String(b) }) };
  }
  return { isValid: true };
}

/** Route-specific wallet requirements. */
export function validateRouteWallets(
  direction: string,
  eth: string,
  stellar: string,
  solana: string
): ValidationResult {
  const needsStellar =
    direction === "eth_to_xlm" ||
    direction === "xlm_to_eth" ||
    direction === "xlm_to_sol" ||
    direction === "sol_to_xlm";
  const needsSolana =
    direction === "eth_to_sol" ||
    direction === "sol_to_eth" ||
    direction === "xlm_to_sol" ||
    direction === "sol_to_xlm";

  const missing: string[] = [];
  if (!eth) missing.push("Ethereum wallet");
  if (needsStellar && !stellar) missing.push("Stellar wallet");
  if (needsSolana && !solana) missing.push("Solana wallet");

  if (missing.length > 0) {
    return { isValid: false, message: t('validation.route.missingWallets', { wallets: missing.join(" and ") }) };
  }
  return { isValid: true };
}

/** Destination chain must match the route token. */
export function validateDestinationChain(
  direction: string,
  destinationAddress: string
): ValidationResult {
  if (!destinationAddress) return { isValid: true };
  if (direction.endsWith("_eth") && !/^0x[0-9a-fA-F]{40}$/.test(destinationAddress)) {
    return { isValid: false, message: t('validation.destination.mustBeEthereum') };
  }
  if (direction.endsWith("_xlm") && !/^G[A-Z2-7]{55}$/.test(destinationAddress)) {
    return { isValid: false, message: t('validation.destination.mustBeStellar') };
  }
  if (direction.endsWith("_sol") && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(destinationAddress)) {
    return { isValid: false, message: t('validation.destination.mustBeSolana') };
  }
  return { isValid: true };
}

/** Reject unsupported asset pairs. */
export function validateAssetPair(
  fromToken: string,
  toToken: string
): ValidationResult {
  const supported = [
    ["ETH", "XLM"],
    ["XLM", "ETH"],
    ["ETH", "SOL"],
    ["SOL", "ETH"],
    ["XLM", "SOL"],
    ["SOL", "XLM"],
  ] as const;
  const key = `${fromToken}->${toToken}`;
  const supportedKey = supported.find(
    ([f, to]) => `${f}->${to}` === key
  );
  if (!supportedKey) {
    return { isValid: false, message: t('validation.assetPair.unsupported', { from: fromToken, to: toToken }) };
  }
  return { isValid: true };
}
