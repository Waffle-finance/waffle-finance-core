import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';

type Pricing = typeof import('../src/services/pricing-service.js');
type Metrics = typeof import('../src/metrics.js');

interface Feed {
  coingecko?: { eth: number; xlm: number } | 'offline' | 'hang';
  coinbase?: { eth: number; xlm: number } | 'offline' | 'hang';
  cryptocompare?: { eth: number; xlm: number } | 'offline';
}

const ok = (body: unknown) => ({ ok: true, json: async () => body });

/** Deterministic synthetic providers keyed by URL; no network access. */
function installFeed(feed: Feed) {
  const fn = vi.fn((url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => {
    const hang = () => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
    if (url.includes('coingecko')) {
      const v = feed.coingecko;
      if (!v || v === 'offline') return Promise.reject(new Error('offline'));
      if (v === 'hang') return hang();
      return Promise.resolve(ok({ ethereum: { usd: v.eth }, stellar: { usd: v.xlm } }));
    }
    if (url.includes('coinbase')) {
      const v = feed.coinbase;
      if (!v || v === 'offline') return Promise.reject(new Error('offline'));
      if (v === 'hang') return hang();
      const amount = url.includes('ETH-USD') ? v.eth : v.xlm;
      return Promise.resolve(ok({ data: { amount: String(amount) } }));
    }
    if (url.includes('cryptocompare')) {
      const v = feed.cryptocompare;
      if (!v || v === 'offline') return Promise.reject(new Error('offline'));
      return Promise.resolve(ok({ ETH: { USD: v.eth }, XLM: { USD: v.xlm } }));
    }
    return Promise.reject(new Error(`unexpected url ${url}`));
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

async function counterValue(metrics: Metrics, name: keyof Metrics, labels: Record<string, string>) {
  const metric = metrics[name] as unknown as { get(): Promise<{ values: { labels: Record<string, string>; value: number }[] }> };
  const { values } = await metric.get();
  return values.find(v => Object.entries(labels).every(([k, val]) => v.labels[k] === val))?.value ?? 0;
}

let pricing: Pricing;
let metrics: Metrics;
const deposit = () => pricing.calculateDynamicSafetyDeposit(ethers.parseEther('0.02'), 'mainnet', 'mainnet');

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(100_000);
  metrics = await import('../src/metrics.js');
  pricing = await import('../src/services/pricing-service.js');
  pricing.configurePricingPolicy({ ...pricing.DEFAULT_PRICING_POLICY, maxStaleMs: 120_000 });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('centralized price fallback policy (prolonged outage)', () => {
  it('labels a live quote as fresh and never labels a cached or fallback price as fresh', async () => {
    installFeed({ coingecko: { eth: 2000, xlm: 0.1 } });
    expect(await pricing.getPriceSnapshot()).toMatchObject({
      provider: 'coingecko', source: 'coingecko', freshness: 'fresh', fallback: false,
      observedAt: 100_000, usable: true,
    });

    vi.setSystemTime(120_000);
    expect(await pricing.getPriceSnapshot()).toMatchObject({ source: 'cache', freshness: 'stale', fallback: false });
  });

  it('flags the static fallback as synthetic when no observation exists yet', async () => {
    installFeed({ coingecko: 'offline' });
    expect(await pricing.getPriceSnapshot()).toMatchObject({
      provider: 'static', source: 'fallback', freshness: 'fallback', fallback: true,
      observedAt: null, usable: true, ethUsdPrice: 3500,
    });
    expect(await counterValue(metrics, 'priceFallbackTotal', { mode: 'static' })).toBe(1);
  });

  it('serves last-known within max stale age, then the explicit static fallback beyond it (static_fallback policy)', async () => {
    installFeed({ coingecko: { eth: 2000, xlm: 0.1 } });
    expect(await deposit()).toBe(ethers.parseEther('0.00005'));

    installFeed({ coingecko: 'offline' });
    vi.setSystemTime(170_000); // 70s after the last observation (< 120s)
    expect(await pricing.getPriceSnapshot()).toMatchObject({ ethUsdPrice: 2000, freshness: 'stale', fallback: true });
    expect(await deposit()).toBe(ethers.parseEther('0.00005'));

    vi.setSystemTime(240_000); // 140s after the last observation (> 120s)
    const snap = await pricing.getPriceSnapshot();
    expect(snap).toMatchObject({ ethUsdPrice: 3500, provider: 'static', freshness: 'fallback', fallback: true, usable: true });
    expect(await deposit()).toBe(ethers.parseEther('0.0001'));
    expect(await counterValue(metrics, 'priceFallbackTotal', { mode: 'last_known' })).toBe(1);
    expect(await counterValue(metrics, 'priceFallbackTotal', { mode: 'static_outage' })).toBe(1);
  });

  it('refuses to calculate a deposit beyond max stale age under the reject policy', async () => {
    pricing.configurePricingPolicy({ outagePolicy: 'reject' });
    installFeed({ coingecko: { eth: 2000, xlm: 0.1 } });
    await pricing.getPriceSnapshot();

    installFeed({ coingecko: 'offline' });
    vi.setSystemTime(240_000);
    const snap = await pricing.getPriceSnapshot();
    expect(snap).toMatchObject({ usable: false, rejectReason: 'outage_threshold_exceeded', fallback: true });

    await expect(deposit()).rejects.toBeInstanceOf(pricing.PriceUnavailableError);
    await expect(deposit()).rejects.toMatchObject({ code: 'outage_threshold_exceeded' });
    await expect(pricing.getRealTimePrices()).rejects.toBeInstanceOf(pricing.PriceUnavailableError);
    expect(await counterValue(metrics, 'safetyDepositPriceRejectionsTotal', { reason: 'outage_threshold_exceeded' })).toBe(3);
  });

  it('rejects a cold-start outage once it outlasts max stale age under the reject policy', async () => {
    pricing.configurePricingPolicy({ outagePolicy: 'reject' });
    installFeed({ coingecko: 'offline' });
    expect(await deposit()).toBe(ethers.parseEther('0.0001')); // within threshold: flagged static fallback
    vi.setSystemTime(230_000);
    await expect(deposit()).rejects.toMatchObject({ code: 'outage_threshold_exceeded' });
  });

  it('returns to fresh pricing when the provider recovers', async () => {
    pricing.configurePricingPolicy({ outagePolicy: 'reject' });
    installFeed({ coingecko: 'offline' });
    vi.setSystemTime(100_000);
    await pricing.getPriceSnapshot();
    vi.setSystemTime(230_000);
    expect((await pricing.getPriceSnapshot()).usable).toBe(false);

    installFeed({ coingecko: { eth: 4000, xlm: 0.1 } });
    vi.setSystemTime(300_000);
    expect(await pricing.getPriceSnapshot()).toMatchObject({ freshness: 'fresh', fallback: false, usable: true });
    expect(await deposit()).toBe(ethers.parseEther('0.0001'));
  });

  it('reads the policy from environment variables, ignoring invalid values', () => {
    expect(pricing.loadPricingPolicy({
      PRICE_MAX_STALE_MS: '90000', PRICE_OUTAGE_POLICY: 'reject', PRICE_PROVIDER_TIMEOUT_MS: '2500',
      PRICE_MAX_DIVERGENCE_BPS: '150', PRICE_SECONDARY_PROVIDER: 'Coinbase',
    })).toMatchObject({ maxStaleMs: 90_000, outagePolicy: 'reject', providerTimeoutMs: 2500, maxDivergenceBps: 150, secondaryProvider: 'coinbase' });

    expect(pricing.loadPricingPolicy({
      PRICE_MAX_STALE_MS: '-1', PRICE_OUTAGE_POLICY: 'maybe', PRICE_SECONDARY_PROVIDER: 'unknown',
    })).toMatchObject({ ...pricing.DEFAULT_PRICING_POLICY });
  });
});

describe('secondary price source with discrepancy safeguards', () => {
  beforeEach(() => {
    pricing.configurePricingPolicy({ secondaryProvider: 'coinbase', maxDivergenceBps: 300 });
  });

  it('keeps primary pricing when the secondary agrees within the bound', async () => {
    installFeed({ coingecko: { eth: 2000, xlm: 0.1 }, coinbase: { eth: 2020, xlm: 0.1 } });
    const snap = await pricing.getPriceSnapshot();
    expect(snap).toMatchObject({ provider: 'coingecko', ethUsdPrice: 2000, crossChecked: true, divergenceBps: 100, usable: true });
    expect(await deposit()).toBe(ethers.parseEther('0.00005'));
  });

  it('does not query a secondary provider when none is configured', async () => {
    pricing.configurePricingPolicy({ secondaryProvider: null });
    const feed = installFeed({ coingecko: { eth: 2000, xlm: 0.1 }, coinbase: { eth: 9999, xlm: 9 } });
    expect(await pricing.getPriceSnapshot()).toMatchObject({ provider: 'coingecko', crossChecked: false, divergenceBps: null });
    expect(feed).toHaveBeenCalledTimes(1);
  });

  it('uses the secondary when the primary is unavailable', async () => {
    installFeed({ coingecko: 'offline', coinbase: { eth: 4000, xlm: 0.1 } });
    expect(await pricing.getPriceSnapshot()).toMatchObject({
      provider: 'coinbase', source: 'coinbase', freshness: 'fresh', fallback: false, crossChecked: false, usable: true,
    });
    expect(await deposit()).toBe(ethers.parseEther('0.0001'));
  });

  it('uses the primary when the secondary is unavailable', async () => {
    installFeed({ coingecko: { eth: 2000, xlm: 0.1 }, coinbase: 'offline' });
    expect(await pricing.getPriceSnapshot()).toMatchObject({ provider: 'coingecko', crossChecked: false, usable: true });
  });

  it('times out a hanging secondary and still prices from the primary', async () => {
    pricing.configurePricingPolicy({ providerTimeoutMs: 1_000 });
    installFeed({ coingecko: { eth: 2000, xlm: 0.1 }, coinbase: 'hang' });
    const pending = pricing.getPriceSnapshot();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toMatchObject({ provider: 'coingecko', usable: true });
    expect(await counterValue(metrics, 'priceProviderRequestsTotal', { provider: 'coinbase', result: 'timeout' })).toBe(1);
  });

  it('refuses to produce a deposit when providers diverge beyond the bound', async () => {
    installFeed({ coingecko: { eth: 2000, xlm: 0.1 }, coinbase: { eth: 2100, xlm: 0.1 } });
    const snap = await pricing.getPriceSnapshot();
    expect(snap).toMatchObject({
      usable: false, rejectReason: 'provider_divergence', fallbackReason: 'provider_divergence',
      divergenceBps: 500, freshness: 'fallback', crossChecked: false,
    });
    await expect(deposit()).rejects.toMatchObject({ name: 'PriceUnavailableError', code: 'provider_divergence' });
    expect(await counterValue(metrics, 'priceFallbackTotal', { mode: 'divergence' })).toBe(1);
    expect(await counterValue(metrics, 'safetyDepositPriceRejectionsTotal', { reason: 'provider_divergence' })).toBe(1);
    expect((await metrics.priceProviderDivergenceBps.get()).values[0]?.value).toBe(500);
  });

  it('does not treat a divergent reading as the last trusted observation', async () => {
    pricing.configurePricingPolicy({ maxStaleMs: 300_000 });
    installFeed({ coingecko: { eth: 2000, xlm: 0.1 }, coinbase: { eth: 2000, xlm: 0.1 } });
    await pricing.getPriceSnapshot();

    installFeed({ coingecko: { eth: 5000, xlm: 0.1 }, coinbase: { eth: 2000, xlm: 0.1 } });
    vi.setSystemTime(170_000);
    expect((await pricing.getPriceSnapshot()).usable).toBe(false);

    installFeed({ coingecko: 'offline', coinbase: 'offline' });
    vi.setSystemTime(240_000);
    expect(await pricing.getPriceSnapshot()).toMatchObject({ ethUsdPrice: 2000, freshness: 'stale', observedAt: 100_000 });
  });

  it('sends the CryptoCompare credential as a header, not in the URL', async () => {
    pricing.configurePricingPolicy({ secondaryProvider: 'cryptocompare', secondaryApiKey: 'test-key' });
    const feed = installFeed({ coingecko: { eth: 2000, xlm: 0.1 }, cryptocompare: { eth: 2000, xlm: 0.1 } });
    expect(await pricing.getPriceSnapshot()).toMatchObject({ crossChecked: true, divergenceBps: 0 });
    const call = feed.mock.calls.find(([url]) => String(url).includes('cryptocompare'));
    expect(String(call?.[0])).not.toContain('test-key');
    expect(call?.[1]?.headers).toEqual({ authorization: 'Apikey test-key' });
  });
});
