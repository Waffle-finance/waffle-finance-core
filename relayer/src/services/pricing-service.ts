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
 * Source selection and fallback policy (single place — see SAFETY_DEPOSIT_PRICING.md)
 * -----------------------------------------------------------------------------------
 * CoinGecko is the primary provider. An optional independent secondary
 * provider (`PRICE_SECONDARY_PROVIDER`) is queried alongside it:
 *
 *   both healthy, within bound  → primary values, cross-checked
 *   both healthy, beyond bound  → NOT usable (provider_divergence); deposits refused
 *   one healthy                 → that provider's values, not cross-checked
 *   none healthy                → outage policy:
 *       last trusted observation younger than PRICE_MAX_STALE_MS → serve it, flagged `stale`
 *       no observation yet, outage younger than PRICE_MAX_STALE_MS → static fallback, flagged
 *       beyond PRICE_MAX_STALE_MS → PRICE_OUTAGE_POLICY:
 *           static_fallback (default) → static fallback, flagged
 *           reject                    → NOT usable (outage_threshold_exceeded); deposits refused
 *
 * Every result is a typed `PriceSnapshot` carrying its provider, observation
 * time, freshness and fallback status, so a fallback is never presented to a
 * caller as a fresh market quote.
 *
 * Safety deposit calculator
 * -------------------------
 * `calculateDynamicSafetyDeposit` converts an ETH amount to USD (using the
 * resolved price), applies tiered rates, then enforces network-specific
 * minimums (testnet requires ≥0.01 ETH per the EscrowFactory contract). It
 * throws `PriceUnavailableError` when the policy cannot establish a
 * trustworthy price.
 */

import { ethers } from 'ethers';
import { getLogger } from '../logger.js';
import {
  priceProviderRequestsTotal,
  priceFallbackTotal,
  priceFallbackActive,
  priceObservationAgeSeconds,
  priceProviderDivergenceBps,
  safetyDepositPriceRejectionsTotal,
} from '../metrics.js';

const logger = getLogger().child({ component: 'pricing-service' });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PriceProviderName = 'coingecko' | 'coinbase' | 'cryptocompare';

/**
 * `fresh`    — live market quote (cached within the SWR fresh window or just fetched).
 * `stale`    — a real market observation that is older than the fresh window
 *              (SWR stale window, or last-known value served during an outage).
 * `fallback` — synthetic (hardcoded) price, or providers disagreed.
 *
 * Values match the frontend's `staleness` indicator.
 */
export type PriceFreshness = 'fresh' | 'stale' | 'fallback';

export type PriceFallbackReason = 'provider_unavailable' | 'provider_divergence';

export type PriceRejectReason = 'outage_threshold_exceeded' | 'provider_divergence';

export type PriceOutagePolicy = 'static_fallback' | 'reject';

export interface PriceSnapshot {
  xlmUsdPrice: number;
  ethUsdPrice: number;
  /** Derived: ethUsdPrice / xlmUsdPrice */
  ethToXlmRate: number;
  /** When the relayer resolved this snapshot (drives the SWR cache windows). */
  fetchedAt: number;
  /** When the underlying market observation was made; null for synthetic prices. */
  observedAt: number | null;
  /** Legacy summary of where the value came from (kept for /api/prices consumers). */
  source: PriceProviderName | 'fallback' | 'cache';
  /** Provider that produced the values, or 'static' for the hardcoded fallback. */
  provider: PriceProviderName | 'static';
  freshness: PriceFreshness;
  /** True whenever the values are not a live market quote from this resolution. */
  fallback: boolean;
  fallbackReason: PriceFallbackReason | null;
  /** True when a secondary provider confirmed the value within the divergence bound. */
  crossChecked: boolean;
  /** Measured divergence between providers (basis points), when both answered. */
  divergenceBps: number | null;
  /** False when the safety policy forbids pricing deposits/quotes from this snapshot. */
  usable: boolean;
  rejectReason: PriceRejectReason | null;
}

export interface RealTimePrices {
  xlmUsdPrice: number;
  ethUsdPrice: number;
  ethToXlmRate: number;
  freshness: PriceFreshness;
  fallback: boolean;
  provider: PriceProviderName | 'static';
}

/** A single market observation returned by a provider. */
export interface PriceQuote {
  xlmUsdPrice: number;
  ethUsdPrice: number;
  observedAt: number;
}

/** Upstream price source. Implementations must throw on any non-usable response. */
export interface PriceProvider {
  readonly name: PriceProviderName;
  fetchQuote(signal: AbortSignal): Promise<PriceQuote>;
}

export interface PricingPolicy {
  /** Max age of the last trusted observation before the outage policy applies. */
  maxStaleMs: number;
  /** Behaviour once the outage exceeds `maxStaleMs`. */
  outagePolicy: PriceOutagePolicy;
  /** Per-provider request timeout. */
  providerTimeoutMs: number;
  /** Max allowed primary/secondary disagreement (basis points) on either asset. */
  maxDivergenceBps: number;
  /** Optional independent secondary provider. */
  secondaryProvider: PriceProviderName | null;
  /** Credential for providers that need one (never logged). */
  secondaryApiKey: string | undefined;
}

/** Thrown when the pricing policy cannot establish a trustworthy price. */
export class PriceUnavailableError extends Error {
  readonly code: PriceRejectReason;
  readonly snapshot: PriceSnapshot;

  constructor(snapshot: PriceSnapshot) {
    const code = snapshot.rejectReason ?? 'outage_threshold_exceeded';
    super(
      code === 'provider_divergence'
        ? `Price providers disagree by ${snapshot.divergenceBps ?? '?'} bps; refusing to price`
        : 'Price feed outage exceeded the maximum stale age; refusing to price',
    );
    this.name = 'PriceUnavailableError';
    this.code = code;
    this.snapshot = snapshot;
  }
}

// ---------------------------------------------------------------------------
// Policy configuration
// ---------------------------------------------------------------------------

const PRICE_CACHE_FRESH_MS = 15_000;
const PRICE_CACHE_STALE_MS = 60_000;

export const DEFAULT_PRICING_POLICY: PricingPolicy = {
  maxStaleMs: 5 * 60_000,
  outagePolicy: 'static_fallback',
  providerTimeoutMs: 5_000,
  maxDivergenceBps: 300,
  secondaryProvider: null,
  secondaryApiKey: undefined,
};

function positiveInt(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    logger.warn({ name, value: raw, fallback }, 'Invalid pricing configuration value; using default');
    return fallback;
  }
  return Math.floor(n);
}

/** Read the pricing policy from environment variables (see SAFETY_DEPOSIT_PRICING.md). */
export function loadPricingPolicy(rawEnv: NodeJS.ProcessEnv = process.env): PricingPolicy {
  const outageRaw = rawEnv.PRICE_OUTAGE_POLICY?.trim();
  let outagePolicy = DEFAULT_PRICING_POLICY.outagePolicy;
  if (outageRaw === 'reject' || outageRaw === 'static_fallback') {
    outagePolicy = outageRaw;
  } else if (outageRaw) {
    logger.warn({ value: outageRaw }, 'Unknown PRICE_OUTAGE_POLICY; using static_fallback');
  }

  const secondaryRaw = rawEnv.PRICE_SECONDARY_PROVIDER?.trim().toLowerCase();
  let secondaryProvider: PriceProviderName | null = null;
  if (secondaryRaw === 'coinbase' || secondaryRaw === 'cryptocompare') {
    secondaryProvider = secondaryRaw;
  } else if (secondaryRaw) {
    logger.warn({ value: secondaryRaw }, 'Unknown PRICE_SECONDARY_PROVIDER; secondary source disabled');
  }

  return {
    maxStaleMs: positiveInt(rawEnv.PRICE_MAX_STALE_MS, 'PRICE_MAX_STALE_MS', DEFAULT_PRICING_POLICY.maxStaleMs),
    outagePolicy,
    providerTimeoutMs: positiveInt(rawEnv.PRICE_PROVIDER_TIMEOUT_MS, 'PRICE_PROVIDER_TIMEOUT_MS', DEFAULT_PRICING_POLICY.providerTimeoutMs),
    maxDivergenceBps: positiveInt(rawEnv.PRICE_MAX_DIVERGENCE_BPS, 'PRICE_MAX_DIVERGENCE_BPS', DEFAULT_PRICING_POLICY.maxDivergenceBps),
    secondaryProvider,
    secondaryApiKey: rawEnv.PRICE_SECONDARY_API_KEY?.trim() || undefined,
  };
}

let policy: PricingPolicy = loadPricingPolicy();

/** Current effective policy (read-only copy). */
export function getPricingPolicy(): PricingPolicy {
  return { ...policy };
}

/**
 * Override the pricing policy (tests / embedding). Clears cached prices and
 * outage tracking so the new policy applies from a clean state.
 */
export function configurePricingPolicy(overrides: Partial<PricingPolicy>): void {
  policy = { ...policy, ...overrides };
  resetPricingState();
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

function assertPositivePrice(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

class InvalidPriceResponse extends Error {}

async function fetchJson(url: string, signal: AbortSignal, headers?: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, headers ? { signal, headers } : { signal });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

const coinGeckoProvider: PriceProvider = {
  name: 'coingecko',
  async fetchQuote(signal) {
    const priceData = (await fetchJson(
      'https://api.coingecko.com/api/v3/simple/price?ids=stellar,ethereum&vs_currencies=usd',
      signal,
    )) as Record<string, Record<string, number>> | null;
    const xlmUsdPrice = priceData?.stellar?.usd;
    const ethUsdPrice = priceData?.ethereum?.usd;
    if (!assertPositivePrice(xlmUsdPrice) || !assertPositivePrice(ethUsdPrice)) {
      throw new InvalidPriceResponse('CoinGecko returned malformed prices');
    }
    return { xlmUsdPrice, ethUsdPrice, observedAt: Date.now() };
  },
};

const coinbaseProvider: PriceProvider = {
  name: 'coinbase',
  async fetchQuote(signal) {
    const spot = async (pair: string): Promise<number> => {
      const body = (await fetchJson(`https://api.coinbase.com/v2/prices/${pair}/spot`, signal)) as
        | { data?: { amount?: string } }
        | null;
      const amount = Number(body?.data?.amount);
      if (!assertPositivePrice(amount)) {
        throw new InvalidPriceResponse(`Coinbase returned a malformed ${pair} price`);
      }
      return amount;
    };
    const [ethUsdPrice, xlmUsdPrice] = await Promise.all([spot('ETH-USD'), spot('XLM-USD')]);
    return { xlmUsdPrice, ethUsdPrice, observedAt: Date.now() };
  },
};

function createCryptoCompareProvider(apiKey: string | undefined): PriceProvider {
  return {
    name: 'cryptocompare',
    async fetchQuote(signal) {
      const body = (await fetchJson(
        'https://min-api.cryptocompare.com/data/pricemulti?fsyms=ETH,XLM&tsyms=USD',
        signal,
        apiKey ? { authorization: `Apikey ${apiKey}` } : undefined,
      )) as Record<string, Record<string, number>> | null;
      const ethUsdPrice = body?.ETH?.USD;
      const xlmUsdPrice = body?.XLM?.USD;
      if (!assertPositivePrice(xlmUsdPrice) || !assertPositivePrice(ethUsdPrice)) {
        throw new InvalidPriceResponse('CryptoCompare returned malformed prices');
      }
      return { xlmUsdPrice, ethUsdPrice, observedAt: Date.now() };
    },
  };
}

function resolveSecondaryProvider(): PriceProvider | null {
  switch (policy.secondaryProvider) {
    case 'coinbase':
      return coinbaseProvider;
    case 'cryptocompare':
      return createCryptoCompareProvider(policy.secondaryApiKey);
    default:
      return null;
  }
}

/** Query one provider with the configured timeout. Never throws. */
async function queryProvider(provider: PriceProvider): Promise<PriceQuote | null> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, policy.providerTimeoutMs);

  try {
    const quote = await provider.fetchQuote(controller.signal);
    priceProviderRequestsTotal.inc({ provider: provider.name, result: 'success' });
    logger.info({ provider: provider.name, xlmUsdPrice: quote.xlmUsdPrice, ethUsdPrice: quote.ethUsdPrice }, 'Real-time prices fetched');
    return quote;
  } catch (err: unknown) {
    const result = timedOut ? 'timeout' : err instanceof InvalidPriceResponse ? 'invalid' : 'error';
    priceProviderRequestsTotal.inc({ provider: provider.name, result });
    const message = err instanceof Error ? err.message : String(err);
    logger.warn({ provider: provider.name, result, err: message }, 'Price provider request failed');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Resolution state (module-level singletons)
// ---------------------------------------------------------------------------

const STATIC_FALLBACK_PRICES = {
  xlmUsdPrice: 0.12,
  ethUsdPrice: 3500,
} as const;

let cachedPrices: PriceSnapshot | null = null;
let inflightPriceFetch: Promise<PriceSnapshot> | null = null;
/** Last trusted market observation (cross-checked or single healthy source). */
let lastTrusted: { quote: PriceQuote; provider: PriceProviderName } | null = null;
/** When the current run of failed resolutions began (null while healthy). */
let outageStartedAt: number | null = null;

/** Clear caches and outage tracking (tests). */
export function resetPricingState(): void {
  cachedPrices = null;
  inflightPriceFetch = null;
  lastTrusted = null;
  outageStartedAt = null;
}

function divergenceBetween(a: PriceQuote, b: PriceQuote): number {
  const bps = (x: number, y: number) => (Math.abs(x - y) / Math.min(x, y)) * 10_000;
  return Math.round(Math.max(bps(a.ethUsdPrice, b.ethUsdPrice), bps(a.xlmUsdPrice, b.xlmUsdPrice)));
}

function buildSnapshot(
  values: { xlmUsdPrice: number; ethUsdPrice: number },
  fields: Omit<PriceSnapshot, 'xlmUsdPrice' | 'ethUsdPrice' | 'ethToXlmRate' | 'source'>,
): PriceSnapshot {
  return {
    xlmUsdPrice: values.xlmUsdPrice,
    ethUsdPrice: values.ethUsdPrice,
    ethToXlmRate: values.ethUsdPrice / values.xlmUsdPrice,
    source: fields.fallback ? 'fallback' : (fields.provider as PriceProviderName),
    ...fields,
  };
}

function marketSnapshot(
  quote: PriceQuote,
  provider: PriceProviderName,
  now: number,
  crossChecked: boolean,
  divergenceBps: number | null,
): PriceSnapshot {
  lastTrusted = { quote, provider };
  if (outageStartedAt !== null) {
    logger.info({ provider, outageMs: now - outageStartedAt }, 'Price feed recovered');
  }
  outageStartedAt = null;
  return buildSnapshot(quote, {
    fetchedAt: now,
    observedAt: quote.observedAt,
    provider,
    freshness: 'fresh',
    fallback: false,
    fallbackReason: null,
    crossChecked,
    divergenceBps,
    usable: true,
    rejectReason: null,
  });
}

function outageSnapshot(now: number): PriceSnapshot {
  outageStartedAt ??= now;
  const reference = lastTrusted ? lastTrusted.quote.observedAt : outageStartedAt;
  const withinThreshold = now - reference < policy.maxStaleMs;

  if (withinThreshold && lastTrusted) {
    priceFallbackTotal.inc({ mode: 'last_known' });
    logger.warn(
      { provider: lastTrusted.provider, observationAgeMs: now - lastTrusted.quote.observedAt },
      'All price providers unavailable; serving last trusted observation (stale)',
    );
    return buildSnapshot(lastTrusted.quote, {
      fetchedAt: now,
      observedAt: lastTrusted.quote.observedAt,
      provider: lastTrusted.provider,
      freshness: 'stale',
      fallback: true,
      fallbackReason: 'provider_unavailable',
      crossChecked: false,
      divergenceBps: null,
      usable: true,
      rejectReason: null,
    });
  }

  const reject = !withinThreshold && policy.outagePolicy === 'reject';
  const mode = withinThreshold ? 'static' : reject ? 'rejected' : 'static_outage';
  priceFallbackTotal.inc({ mode });
  const logFields = { mode, outageMs: now - outageStartedAt, maxStaleMs: policy.maxStaleMs };
  if (withinThreshold) {
    logger.warn(logFields, 'Price feed unavailable; using static fallback prices');
  } else {
    logger.error(logFields, reject
      ? 'Price feed outage exceeded max stale age; refusing to price (PRICE_OUTAGE_POLICY=reject)'
      : 'Price feed outage exceeded max stale age; still using static fallback (PRICE_OUTAGE_POLICY=static_fallback)');
  }

  return buildSnapshot(STATIC_FALLBACK_PRICES, {
    fetchedAt: now,
    observedAt: null,
    provider: 'static',
    freshness: 'fallback',
    fallback: true,
    fallbackReason: 'provider_unavailable',
    crossChecked: false,
    divergenceBps: null,
    usable: !reject,
    rejectReason: reject ? 'outage_threshold_exceeded' : null,
  });
}

/** Query providers and apply the source-selection policy. Never throws. */
async function resolvePrices(): Promise<PriceSnapshot> {
  const secondaryProvider = resolveSecondaryProvider();
  const [primary, secondary] = await Promise.all([
    queryProvider(coinGeckoProvider),
    secondaryProvider ? queryProvider(secondaryProvider) : Promise.resolve(null),
  ]);
  const now = Date.now();

  if (primary && secondary && secondaryProvider) {
    const divergenceBps = divergenceBetween(primary, secondary);
    priceProviderDivergenceBps.set(divergenceBps);
    if (divergenceBps > policy.maxDivergenceBps) {
      outageStartedAt ??= now;
      priceFallbackTotal.inc({ mode: 'divergence' });
      logger.error(
        {
          divergenceBps,
          maxDivergenceBps: policy.maxDivergenceBps,
          primary: { ethUsdPrice: primary.ethUsdPrice, xlmUsdPrice: primary.xlmUsdPrice },
          secondary: { provider: secondaryProvider.name, ethUsdPrice: secondary.ethUsdPrice, xlmUsdPrice: secondary.xlmUsdPrice },
        },
        'Price providers disagree beyond the configured bound; price is not trustworthy',
      );
      return buildSnapshot(primary, {
        fetchedAt: now,
        observedAt: primary.observedAt,
        provider: coinGeckoProvider.name,
        freshness: 'fallback',
        fallback: true,
        fallbackReason: 'provider_divergence',
        crossChecked: false,
        divergenceBps,
        usable: false,
        rejectReason: 'provider_divergence',
      });
    }
    return marketSnapshot(primary, coinGeckoProvider.name, now, true, divergenceBps);
  }

  if (primary) return marketSnapshot(primary, coinGeckoProvider.name, now, false, null);
  if (secondary && secondaryProvider) {
    logger.warn({ provider: secondaryProvider.name }, 'Primary price provider unavailable; using secondary provider');
    return marketSnapshot(secondary, secondaryProvider.name, now, false, null);
  }
  return outageSnapshot(now);
}

function startResolution(): Promise<PriceSnapshot> {
  if (!inflightPriceFetch) {
    inflightPriceFetch = resolvePrices()
      .then((snapshot) => {
        cachedPrices = snapshot;
        return snapshot;
      })
      .catch((err: unknown) => {
        // resolvePrices never throws; defensive — fall back to the outage policy.
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ err: message }, 'Price resolution failed unexpectedly');
        const snapshot = outageSnapshot(Date.now());
        cachedPrices = snapshot;
        return snapshot;
      })
      .finally(() => {
        inflightPriceFetch = null;
      });
  }
  return inflightPriceFetch;
}

/** Mark a cached snapshot as served from cache, downgrading freshness with age. */
function fromCache(snapshot: PriceSnapshot, age: number): PriceSnapshot {
  const freshness: PriceFreshness =
    snapshot.freshness === 'fresh' && age >= PRICE_CACHE_FRESH_MS ? 'stale' : snapshot.freshness;
  return { ...snapshot, source: snapshot.fallback ? 'fallback' : 'cache', freshness };
}

function recordSnapshotMetrics(snapshot: PriceSnapshot, now: number): void {
  priceFallbackActive.set(snapshot.fallback ? 1 : 0);
  priceObservationAgeSeconds.set(
    snapshot.observedAt === null ? -1 : Math.max(0, (now - snapshot.observedAt) / 1000),
  );
}

// ---------------------------------------------------------------------------
// Public price API
// ---------------------------------------------------------------------------

/**
 * Return the current price snapshot, respecting the SWR cache windows and
 * the fallback policy. Never throws — inspect `usable` / `fallback` /
 * `freshness` before using the values for anything economically significant.
 */
export async function getPriceSnapshot(): Promise<PriceSnapshot> {
  const now = Date.now();
  let snapshot: PriceSnapshot;

  const age = cachedPrices ? now - cachedPrices.fetchedAt : Infinity;
  if (cachedPrices && age < PRICE_CACHE_FRESH_MS) {
    // Fully fresh — serve from cache.
    snapshot = fromCache(cachedPrices, age);
  } else if (cachedPrices && age < PRICE_CACHE_STALE_MS) {
    // Stale but acceptable — serve from cache and refresh in background.
    snapshot = fromCache(cachedPrices, age);
    void startResolution();
  } else {
    // No cache or expired — block on a fresh resolution, de-duplicated.
    snapshot = await startResolution();
  }

  recordSnapshotMetrics(snapshot, Date.now());
  return snapshot;
}

/**
 * Return a snapshot that the safety policy allows for pricing. Throws
 * `PriceUnavailableError` (and counts the rejection) when it does not.
 */
export async function getUsablePriceSnapshot(): Promise<PriceSnapshot> {
  const snapshot = await getPriceSnapshot();
  if (!snapshot.usable) {
    const error = new PriceUnavailableError(snapshot);
    safetyDepositPriceRejectionsTotal.inc({ reason: error.code });
    throw error;
  }
  return snapshot;
}

/**
 * Convenience wrapper that returns the rate fields needed by route handlers,
 * plus freshness / fallback flags. Throws `PriceUnavailableError` when the
 * policy cannot establish a trustworthy price.
 */
export async function getRealTimePrices(): Promise<RealTimePrices> {
  const snapshot = await getUsablePriceSnapshot();
  return {
    xlmUsdPrice: snapshot.xlmUsdPrice,
    ethUsdPrice: snapshot.ethUsdPrice,
    ethToXlmRate: snapshot.ethToXlmRate,
    freshness: snapshot.freshness,
    fallback: snapshot.fallback,
    provider: snapshot.provider,
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
 * The ETH/USD price comes from the centralized fallback policy above; this
 * function has no fallback of its own.
 *
 * @param amountInWei  Order amount in wei (string or bigint).
 * @param networkMode  'testnet' | 'mainnet' | undefined (defaults to env).
 * @param defaultNetworkMode The resolved default network from config.
 * @throws PriceUnavailableError when no trustworthy price can be established.
 */
export async function calculateDynamicSafetyDeposit(
  amountInWei: string | bigint,
  networkMode: string | undefined,
  defaultNetworkMode: string
): Promise<bigint> {
  const prices = await getUsablePriceSnapshot();
  const ethUsdPrice = prices.ethUsdPrice;
  if (prices.fallback) {
    logger.warn(
      { provider: prices.provider, freshness: prices.freshness, reason: prices.fallbackReason, ethUsdPrice },
      'Safety deposit priced from a fallback price, not a live market quote',
    );
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
        priceFreshness: prices.freshness,
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
        priceFreshness: prices.freshness,
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
