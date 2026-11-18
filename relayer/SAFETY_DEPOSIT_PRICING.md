# Safety-deposit price behavior

`src/services/pricing-service.ts` calculates the order's USD value using
`getRealTimePrices`, which reads `getPriceSnapshot`. ETH/USD falls back to
**$3,500** when the upstream feed is unavailable, non-OK, or malformed. This is
an availability fallback, not a guarantee that a deposit matches market prices.

Snapshots younger than 15 seconds are fresh. From 15 seconds up to, but not
including, 60 seconds, the cached price is used immediately while a background
refresh runs. At 60 seconds or older, the caller waits for refresh; if the feed
fails, the $3,500 fallback replaces the expired snapshot. A failed background
fetch also produces a fallback snapshot for subsequent callers.

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

`test/pricing-safety-deposit.test.ts` replaces `fetch` with a synthetic price
source and controls time. It covers fresh, stale, expired, unavailable, and
invalid prices, tier scaling, and the testnet minimum without an external call.
