import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ethers } from 'ethers';

describe('safety deposit price snapshots', () => {
  let pricing: typeof import('../src/services/pricing-service.js');
  let feed: ReturnType<typeof vi.fn>;
  const response = (eth: number) => ({ ok: true,
    json: async () => ({ ethereum: { usd: eth }, stellar: { usd: 0.12 } }) });
  const deposit = () => pricing.calculateDynamicSafetyDeposit(ethers.parseEther('0.02'), 'mainnet', 'mainnet');

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    feed = vi.fn();
    vi.stubGlobal('fetch', feed);
    pricing = await import('../src/services/pricing-service.js');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it.each([[2000, '0.00005'], [4000, '0.0001']])(
    'uses a fresh $%i ETH price to select the expected USD tier', async (price, expected) => {
      feed.mockResolvedValue(response(Number(price)));
      expect(await deposit()).toBe(ethers.parseEther(String(expected)));
      expect(await deposit()).toBe(ethers.parseEther(String(expected)));
      expect(feed).toHaveBeenCalledTimes(1);
    });

  it('serves the stale snapshot within 60s while refreshing in the background', async () => {
    feed.mockResolvedValueOnce(response(2000));
    await pricing.getPriceSnapshot();
    let refresh!: (value: ReturnType<typeof response>) => void;
    feed.mockImplementationOnce(() => new Promise(resolve => { refresh = resolve; }));
    vi.setSystemTime(120_000);
    expect(await deposit()).toBe(ethers.parseEther('0.00005'));
    expect(feed).toHaveBeenCalledTimes(2);
    refresh(response(4000));
    await vi.waitFor(async () => {
      expect((await pricing.getPriceSnapshot()).ethUsdPrice).toBe(4000);
    });
    expect(await deposit()).toBe(ethers.parseEther('0.0001'));
  });

  it('uses the documented $3500 fallback when the feed is unavailable', async () => {
    feed.mockRejectedValue(new Error('offline'));
    expect(await pricing.getPriceSnapshot()).toMatchObject({ source: 'fallback', ethUsdPrice: 3500 });
    expect(await deposit()).toBe(ethers.parseEther('0.0001'));
  });

  it('replaces an expired snapshot with the fallback when refresh fails', async () => {
    feed.mockResolvedValueOnce(response(2000));
    await pricing.getPriceSnapshot();
    vi.setSystemTime(160_000);
    feed.mockRejectedValue(new Error('offline'));
    expect(await deposit()).toBe(ethers.parseEther('0.0001'));
    expect((await pricing.getPriceSnapshot()).ethUsdPrice).toBe(3500);
  });

  it.each([NaN, 0, -1])('falls back on an invalid ETH price (%s)', async price => {
    feed.mockResolvedValue(response(price));
    expect(await deposit()).toBe(ethers.parseEther('0.0001'));
  });

  it('preserves the testnet minimum during a feed outage', async () => {
    feed.mockRejectedValue(new Error('offline'));
    expect(await pricing.calculateDynamicSafetyDeposit(ethers.parseEther('0.02'), 'testnet', 'testnet'))
      .toBe(ethers.parseEther('0.01'));
  });
});
