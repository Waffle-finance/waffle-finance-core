# Safety-deposit price behavior

`src/services/pricing-service.ts` is the single place that decides which
price a safety deposit (or quote) uses. `calculateDynamicSafetyDeposit` and
`getRealTimePrices` both read `getUsablePriceSnapshot`; neither has a
fallback of its own.

## Price result

Every resolution returns one typed `PriceSnapshot`:

| Field | Meaning |
| --- | --- |
| `provider` | `coingecko`, `coinbase`, `cryptocompare`, or `static` (hardcoded fallback) |
| `observedAt` | When the market observation was made; `null` for synthetic prices |
| `fetchedAt` | When the relayer resolved the snapshot (drives the cache windows) |
| `freshness` | `fresh` (live quote), `stale` (real but aged observation), `fallback` (synthetic or disputed) |
| `fallback` / `fallbackReason` | `true` whenever the value is not a live quote; reason `provider_unavailable` or `provider_divergence` |
| `crossChecked` / `divergenceBps` | Whether a secondary provider confirmed the value, and by how much they differed |
| `usable` / `rejectReason` | `false` when the policy forbids pricing from it (`outage_threshold_exceeded` or `provider_divergence`) |

`GET /api/prices` forwards these as `provider`, `staleness`, `fallback`,
`fallbackReason`, `crossChecked` and `observedAt`, so the frontend's staleness
indicator shows fallbacks. When the snapshot is not usable the endpoint returns
`503` with `code` set to the reject reason.

## Cache windows

Snapshots younger than 15 seconds are served from cache. From 15 seconds up
to, but not including, 60 seconds, the cached snapshot is served (a cached
live quote is labelled `stale`) while a background refresh runs. At 60
seconds or older, the caller waits for a new resolution.

## Source selection

CoinGecko is the primary provider. An optional independent secondary provider
is queried in parallel, each with its own timeout:

| Primary | Secondary | Result |
| --- | --- | --- |
| healthy | disabled | Primary quote (unchanged behavior) |
| healthy | healthy, within `PRICE_MAX_DIVERGENCE_BPS` | Primary quote, `crossChecked: true` |
| healthy | healthy, beyond `PRICE_MAX_DIVERGENCE_BPS` | **Not usable** (`provider_divergence`); deposits refused |
| healthy | unavailable / timed out / malformed | Primary quote, `crossChecked: false` |
| unavailable | healthy | Secondary quote, `crossChecked: false` |
| unavailable | unavailable | Outage policy (below) |

Divergence is the larger relative difference of the ETH/USD and XLM/USD
prices, in basis points of the lower value. Providers are never averaged. A
disputed reading never becomes the "last trusted observation".

## Outage policy

When no provider answers, the age of the last trusted observation (or, if
there has never been one, the time since the outage began) is compared to
`PRICE_MAX_STALE_MS`:

1. **Within the max stale age, with a previous observation:** the last trusted
   price is served with `freshness: 'stale'`, `fallback: true`.
2. **Within the max stale age, no observation yet** (cold start): the static
   fallback, **ETH/USD $3,500** and XLM/USD $0.12, is served with
   `freshness: 'fallback'`, `provider: 'static'`.
3. **Beyond the max stale age:** `PRICE_OUTAGE_POLICY` decides:
   - `static_fallback` (default): the $3,500 static fallback is still used,
     flagged, and logged at error level on every resolution.
   - `reject`: the snapshot is not usable. `calculateDynamicSafetyDeposit`
     and `getRealTimePrices` throw `PriceUnavailableError`
     (`code: 'outage_threshold_exceeded'`). `POST /api/orders/create` returns
     `503 { error: 'price_unavailable', code }`, and relayer-side escrow
     creation holds the order (`priceUnavailableReason` on the order).

The first successful provider response clears the outage.

For mainnet we recommend `PRICE_OUTAGE_POLICY=reject`, so a prolonged outage
stops new deposits instead of pricing them from a synthetic value.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PRICE_MAX_STALE_MS` | `300000` (5 min) | Max age of the last trusted observation before the outage policy applies |
| `PRICE_OUTAGE_POLICY` | `static_fallback` | `static_fallback` or `reject` beyond the max stale age |
| `PRICE_PROVIDER_TIMEOUT_MS` | `5000` | Per-provider request timeout |
| `PRICE_SECONDARY_PROVIDER` | unset (disabled) | `coinbase` (public spot API, no key) or `cryptocompare` |
| `PRICE_SECONDARY_API_KEY` | unset | Credential for `cryptocompare`, sent as an `authorization: Apikey …` header |
| `PRICE_MAX_DIVERGENCE_BPS` | `300` (3%) | Max allowed primary/secondary disagreement |

Invalid values are logged and replaced by the default. Never commit
`PRICE_SECONDARY_API_KEY`. Set it through the deployment's secret store or a
local, git-ignored `.env`. The key is never logged or put in a URL.

## Deposit tiers

The deposit uses USD bands, so price changes affect it when they cross a band:

| Order value in USD | Deposit in ETH |
| --- | --- |
| Up to $50 | 0.00005 |
| Above $50 through $100 | 0.0001 |
| Above $100 through $500 | 0.0002 |
| Above $500 through $1,000 | 0.0005 |
| Above $1,000 | Minimum of 0.002 ETH and 1% of the ETH order amount |

For a 0.02 ETH order, $2,000/ETH selects 0.00005 ETH; $4,000/ETH and the
$3,500 fallback select 0.0001 ETH. The existing testnet rule enforces a 0.01 ETH
minimum when either the requested or configured default mode is `testnet`.

## Metrics and alerts

| Metric | Type | Labels |
| --- | --- | --- |
| `relayer_price_provider_requests_total` | counter | `provider`, `result` (`success`\|`error`\|`timeout`\|`invalid`) |
| `relayer_price_fallback_total` | counter | `mode` (`last_known`\|`static`\|`static_outage`\|`rejected`\|`divergence`) |
| `relayer_price_fallback_active` | gauge | — (1 while the current price is a fallback) |
| `relayer_price_observation_age_seconds` | gauge | — (-1 when the price is synthetic) |
| `relayer_price_provider_divergence_bps` | gauge | — |
| `relayer_safety_deposit_price_rejections_total` | counter | `reason` (`outage_threshold_exceeded`\|`provider_divergence`) |

Suggested alerts:

- **PriceFeedOnFallback** (warning): `max_over_time(relayer_price_fallback_active[5m]) == 1`
  for 5 minutes. Deposits are being priced from a stale or synthetic value.
  Check provider reachability (`relayer_price_provider_requests_total` by
  `result`) and the provider status pages.
- **PriceFeedOutageBeyondThreshold** (critical):
  `increase(relayer_price_fallback_total{mode=~"static_outage|rejected"}[5m]) > 0`.
  The outage has exceeded `PRICE_MAX_STALE_MS`. With `static_fallback`, deposits use $3,500/ETH.
  With `reject`, new orders get `503`. Restore provider access, or
  configure a secondary provider.
- **PriceProviderDivergence** (critical):
  `increase(relayer_price_fallback_total{mode="divergence"}[5m]) > 0`.
  The providers disagree beyond the bound and deposits are refused. Compare
  the two providers against an exchange by hand before raising
  `PRICE_MAX_DIVERGENCE_BPS`, because one provider may be returning bad data.

## Tests

`test/pricing-safety-deposit.test.ts` and `test/pricing-fallback-policy.test.ts`
replace `fetch` with synthetic providers and control time, so they make no
external calls. They cover fresh, stale, expired, unavailable, and invalid
prices; serving the last-known value within the max stale age; both outage
policies after the threshold; recovery; secondary-only, primary-only and
timed-out providers; divergence rejection; tier scaling; and the testnet
minimum.
