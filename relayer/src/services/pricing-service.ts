/**
 * @fileoverview Real-time price feed and dynamic safety-deposit calculator.
 *
 * Extracted from relayer/src/index.ts to isolate all pricing concerns.
 *
 * Price cache (stale-while-revalidate)
 * -------------------------------------
 * CoinGecko's free public API is rate-limited (~10–30 calls/min per IP).
 * We use a two-tier SWR cache:
 *
 *   FRESH  (0–15s):  serve cached data, no upstream call.
 *   STALE (15–60s):  serve cached data immediately AND kick off a background
 *                    refresh so the next caller gets a fresher snapshot.
 *   EXPIRED (>60s):  block on a fresh fetch, de-duped via an inflight promise
 *                    so a burst of swap requests collapses into one CoinGecko hit.
 *
 * Both the frontend quote and the relayer's settlement read from the same cache
 * window, so the price a user is quoted matches the price they settle at.
 *
 * Safety deposit calculator
 * -------------------------
 * `calculateDynamicSafetyDeposit` converts an ETH amount to USD (using a
 * configurable price), applies tiered rates, then enforces network-specific
 * minimums (testnet requires ≥0.01 ETH per the EscrowFactory contract).
 */

import { ethers } from 'ethers';
import { getLogger } from '../logger.js';

const logger = getLogger().child({ component: 'pricing-service' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PriceSnapshot {
  xlmUsdPrice: number;
  ethUsdPrice: number;
  /** Derived: ethUsdPrice / xlmUsdPrice */
  ethToXlmRate: number;
  fetchedAt: number;
  source: 'coingecko' | 'fallback' | 'cache';
}

export interface RealTimePrices {
  xlmUsdPrice: number;
  ethUsdPrice: number;
  ethToXlmRate: number;
}

// ---------------------------------------------------------------------------
// Cache state (module-level singletons)
// ---------------------------------------------------------------------------

const PRICE_CACHE_FRESH_MS = 15_000;
const PRICE_CACHE_STALE_MS = 60_000;

let cachedPrices: PriceSnapshot | null = null;
let inflightPriceFetch: Promise<PriceSnapshot> | null = null;

// ---------------------------------------------------------------------------
// CoinGecko fetch
// ---------------------------------------------------------------------------

const FALLBACK_PRICES: PriceSnapshot = {
  xlmUsdPrice: 0.12,
  ethUsdPrice: 3500,
  ethToXlmRate: 3500 / 0.12,
  fetchedAt: 0, // Will be overwritten at call time
  source: 'fallback',
};

async function fetchPricesFromCoinGecko(): Promise<PriceSnapshot> {
  const fallback: PriceSnapshot = { ...FALLBACK_PRICES, fetchedAt: Date.now() };

  try {
    const priceResponse = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=stellar,ethereum&vs_currencies=usd'
    );
    if (!priceResponse.ok) {
      logger.warn({ status: priceResponse.status }, 'CoinGecko API returned non-OK status');
      return fallback;
    }

    const priceData = (await priceResponse.json()) as Record<string, Record<string, number>>;
    const xlmUsdPrice = priceData.stellar?.usd;
    const ethUsdPrice = priceData.ethereum?.usd;

    if (
      typeof xlmUsdPrice !== 'number' ||
      typeof ethUsdPrice !== 'number' ||
      !Number.isFinite(xlmUsdPrice) ||
      !Number.isFinite(ethUsdPrice) ||
      xlmUsdPrice <= 0 ||
      ethUsdPrice <= 0
    ) {
      logger.warn({ priceData }, 'CoinGecko returned malformed prices, using fallback');
      return fallback;
    }

    logger.info({ xlmUsdPrice, ethUsdPrice }, 'Real-time prices fetched from CoinGecko');
    return {
      xlmUsdPrice,
      ethUsdPrice,
      ethToXlmRate: ethUsdPrice / xlmUsdPrice,
      fetchedAt: Date.now(),
      source: 'coingecko',
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ err: message }, 'Price fetch failed, using fallback prices');
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Background refresh
// ---------------------------------------------------------------------------

function triggerBackgroundRefresh(): void {
  if (inflightPriceFetch) return;
  inflightPriceFetch = fetchPricesFromCoinGecko()
    .then((snapshot) => {
      cachedPrices = snapshot;
      return snapshot;
    })
    .catch((err: unknown) => {
      // SWR background refresh: keep the stale entry, log the failure.
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err: message }, 'Background price refresh failed; keeping stale entry');
      return (
        cachedPrices ?? { ...FALLBACK_PRICES, fetchedAt: Date.now() }
      );
    })
    .finally(() => {
      inflightPriceFetch = null;
    });
}

// ---------------------------------------------------------------------------
// Public price API
// ---------------------------------------------------------------------------

/**
 * Return the current price snapshot, respecting the SWR cache windows.
 * Never throws — falls back to hardcoded values on any upstream failure.
 */
export async function getPriceSnapshot(): Promise<PriceSnapshot> {
  const now = Date.now();

  if (cachedPrices) {
    const age = now - cachedPrices.fetchedAt;

    if (age < PRICE_CACHE_FRESH_MS) {
      // Fully fresh — serve from cache.
      return { ...cachedPrices, source: 'cache' };
    }

    if (age < PRICE_CACHE_STALE_MS) {
      // Stale but acceptable — serve from cache and refresh in background.
      triggerBackgroundRefresh();
      return { ...cachedPrices, source: 'cache' };
    }
  }

  // No cache or expired — block on a fresh fetch, de-duplicated.
  if (!inflightPriceFetch) {
    inflightPriceFetch = fetchPricesFromCoinGecko()
      .then((snapshot) => {
        cachedPrices = snapshot;
        return snapshot;
      })
      .finally(() => {
        inflightPriceFetch = null;
      });
  }
  return inflightPriceFetch;
}

/**
 * Convenience wrapper that returns only the three rate fields needed by
 * route handlers (avoids importing the full PriceSnapshot type).
 */
export async function getRealTimePrices(): Promise<RealTimePrices> {
  const snapshot = await getPriceSnapshot();
  return {
    xlmUsdPrice: snapshot.xlmUsdPrice,
    ethUsdPrice: snapshot.ethUsdPrice,
    ethToXlmRate: snapshot.ethToXlmRate,
  };
}

/** Expose SWR window constants so the /api/prices endpoint can forward them. */
export { PRICE_CACHE_FRESH_MS, PRICE_CACHE_STALE_MS };

// ---------------------------------------------------------------------------
// Safety deposit calculator
// ---------------------------------------------------------------------------

/**
 * Calculate the relayer's safety deposit for a given ETH order amount using real-time prices.
 *
 * Uses tiered USD bands to keep the deposit proportional to order size.
 * On testnet the EscrowFactory contract enforces a hard minimum of 0.01 ETH,
 * which is applied automatically when `networkMode` resolves to 'testnet'.
 *
 * @param amountInWei  Order amount in wei (string or bigint).
 * @param networkMode  'testnet' | 'mainnet' | undefined (defaults to env).
 * @param defaultNetworkMode The resolved default network from config.
 */
export async function calculateDynamicSafetyDeposit(
  amountInWei: string | bigint,
  networkMode: string | undefined,
  defaultNetworkMode: string
): Promise<bigint> {
  let ethUsdPrice = 3500;
  try {
    const prices = await getRealTimePrices();
    ethUsdPrice = prices.ethUsdPrice;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ err: msg }, 'Failed to fetch real-time ETH price for safety deposit; using fallback');
  }

  const amountInEth = parseFloat(ethers.formatEther(amountInWei.toString()));
  const amountInUsd = amountInEth * ethUsdPrice;

  // Tiered safety deposit rates
  let safetyDepositInEth: number;
  if (amountInUsd <= 50) {
    safetyDepositInEth = 0.00005;
  } else if (amountInUsd <= 100) {
    safetyDepositInEth = 0.0001;
  } else if (amountInUsd <= 500) {
    safetyDepositInEth = 0.0002;
  } else if (amountInUsd <= 1000) {
    safetyDepositInEth = 0.0005;
  } else {
    safetyDepositInEth = Math.min(0.002, amountInEth * 0.01);
  }

  const originalSafetyDeposit = safetyDepositInEth;
  const isTestnet =
    networkMode === 'testnet' || defaultNetworkMode === 'testnet';

  if (isTestnet) {
    const TESTNET_MIN_SAFETY_DEPOSIT = 0.01;
    safetyDepositInEth = Math.max(safetyDepositInEth, TESTNET_MIN_SAFETY_DEPOSIT);
    logger.debug(
      {
        amountEth: amountInEth,
        amountUsd: amountInUsd,
        ethUsdPrice,
        dynamicDeposit: originalSafetyDeposit,
        finalDeposit: safetyDepositInEth,
        network: 'testnet',
        minimumApplied: TESTNET_MIN_SAFETY_DEPOSIT,
      },
      'Testnet safety deposit calculated'
    );
  } else {
    logger.debug(
      {
        amountEth: amountInEth,
        amountUsd: amountInUsd,
        ethUsdPrice,
        dynamicDeposit: originalSafetyDeposit,
        finalDeposit: safetyDepositInEth,
        network: 'mainnet',
      },
      'Mainnet safety deposit calculated'
    );
  }

  return ethers.parseEther(safetyDepositInEth.toString());
}

/**
 * Backward compatibility alias for calculateDynamicSafetyDeposit.
 */
export const calculateDynamicSafetyDepositAsync = calculateDynamicSafetyDeposit;
