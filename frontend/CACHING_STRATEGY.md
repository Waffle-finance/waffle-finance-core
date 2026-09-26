# Frontend Caching Strategy

## Overview

The frontend implements a multi-layered caching strategy to ensure reliable data presentation under unstable network conditions.

## Cache Layers

### 1. LocalStorage Cache (Persistent)

**Location**: `localStorage` with prefix `wafflefinance_`

**TTL**: 5 minutes for API cache, 60 seconds for transaction history

**Key Patterns**:
- `wafflefinance_transactions_v2` - Legacy transaction cache
- `wafflefinance_history_cache_v1:{eth}:{stellar}` - Per-wallet history cache
- `wafflefinance_api_cache_v1:{key}` - API response cache

### 2. In-Memory Cache (Session)

**Location**: React state in `useTransactionHistoryCache`

**Purpose**: Immediate UI updates without storage reads

### 3. Stale-While-Revalidate

**Implementation**: `fetchWithStaleWhileRevalidate` in `lib/fetchWithRetry.ts`

**Behavior**:
- Returns cached data immediately if available
- Fetches fresh data in background
- Updates cache on successful fetch
- Falls back to stale data if refresh fails

## Retry Strategy

### Exponential Backoff

**Configuration**:
- Max retries: 3
- Base delay: 1000ms
- Backoff multiplier: 2x
- Retryable statuses: 408, 429, 500, 502, 503, 504
- Network errors: Always retryable

**Usage**:

```typescript
import { fetchWithRetry } from './lib/fetchWithRetry';

const response = await fetchWithRetry(url, {
  maxRetries: 3,
  retryDelayMs: 1000,
  onRetry: (attempt, error) => {
    console.log(`Retry ${attempt}:`, error);
  }
});
```

## Graceful Degradation

### Loading States

- **isLoading**: No data available, showing initial load
- **isRefreshing**: Data available, updating in background
- **isStale**: Data exists but may be outdated

### Error Handling

1. **Network Errors**: Retry with exponential backoff
2. **HTTP Errors**: 
   - 4xx: User error, don't retry
   - 5xx: Server error, retry if in retryable list
3. **Cache Fallback**: Use cached data if available
4. **Final Fallback**: Show error state with retry option

## Cache Invalidation

### Automatic Invalidation

- TTL-based expiration (5 minutes for API cache)
- Stale data detection (60 seconds for history)

### Manual Invalidation

```typescript
import { clearApiCache } from './lib/fetchWithRetry';

// Clear all API cache
clearApiCache();

// Clear specific wallet cache
localStorage.removeItem(`wafflefinance_history_cache_v1:${eth}:${stellar}`);
```

## Best Practices

### 1. Always Use Retry for Network Requests

```typescript
// Bad
const response = await fetch(url);

// Good
const response = await fetchWithRetry(url, { maxRetries: 2 });
```

### 2. Provide Loading States

```typescript
const { transactions, isLoading, isRefreshing } = useTransactionHistoryCache();

if (isLoading) return <Spinner />;
if (isRefreshing) return <DataWithSpinner data={transactions} />;
```

### 3. Handle Offline Scenarios

The caching layer automatically handles offline scenarios:
- Cached data is returned immediately
- Background refresh attempts continue
- UI remains functional with stale data

### 4. Monitor Cache Health

```typescript
const { isStale, lastFetchedAt } = useTransactionHistoryCache();

if (isStale) {
  // Show "Last updated X minutes ago" indicator
}
```

## Performance Considerations

- Cache reads are synchronous (localStorage)
- Cache writes are synchronous but fast
- Background refresh doesn't block UI
- Retry delays are non-blocking (await in async)

## Testing

Test caching behavior by:
1. Simulating network failures (Chrome DevTools)
2. Testing offline mode
3. Verifying stale-while-revalidate behavior
4. Checking cache invalidation

## Future Improvements

- Service Worker for offline-first support
- IndexedDB for larger cache storage
- Cache warming on app load
- Predictive prefetching
| Phase          | Meaning                                                   |
| -------------- | --------------------------------------------------------- |
| `development`  | Only enabled in local dev. Not expected in testnet/prod.  |
| `testnet`      | Enabled on testnet deployments, gated in production.       |
| `production`   | Safe for all environments. Can be enabled in production.   |
| `deprecated`   | Permanently disabled. Retained for audit trail.            |

## Current flags

| Flag                    | Phase         | Production default | Description                                    |
| ----------------------- | ------------- | ------------------ | ---------------------------------------------- |
| `faucetEnabled`         | `testnet`     | `false`            | Testnet faucet UI component                    |
| `historyStreamEnabled`  | `testnet`     | `false`            | Real-time transaction history stream           |
| `refundFlowEnabled`     | `testnet`     | `false`            | Permissionless refund dialog                   |
| `solanaRoutesEnabled`   | `development` | `false`            | Solana bridge routes (simulation mode)         |
| `introAnimationEnabled` | `production`  | `true`             | Branded intro animation on first visit         |
| `darkVeilEnabled`       | `production`  | `true`             | Dark-veil WebGL background effect              |
| `claimFallbackEnabled`  | `testnet`     | `false`            | Direct on-chain claim when coordinator is down |

## Adding a new flag

1. Add an entry to `FEATURE_FLAG_REGISTRY` in `src/config/feature-flags.ts`:
   ```typescript
   myNewFeature: {
     key: 'myNewFeature',
     description: 'What this flag gates.',
     owner: 'frontend',
     phase: 'testnet',
     productionDefault: false,
   },
   ```
2. Add a selector in `src/config/selectors.ts`:
   ```typescript
   export function selectMyNewFeatureEnabled(): boolean {
     return featureFlags.myNewFeature;
   }
   ```
3. Add the `VITE_FEATURE_MY_NEW_FEATURE` env var to `src/types/global.d.ts`.
4. Wire it into the relevant component:
   ```tsx
   import { selectMyNewFeatureEnabled } from '../../config/selectors';
   
   const enabled = selectMyNewFeatureEnabled();
   if (!enabled) return null;
   ```
5. Add or update tests in `src/config/feature-flags.test.ts`.
6. Add tests for the component's gated behavior.

## Overriding in production

To enable a flag in production without a redeploy (using Vite env vars at build
time — Vite inlines `VITE_*` vars at compile time, so they require a rebuild):

```bash
VITE_FEATURE_SOLANA_ROUTES_ENABLED=true pnpm build
```

For runtime-configurable flags (future), use a different mechanism like a URL
parameter or an API-fetched config, but the evaluation function in
`feature-flags.ts` will still be the single integration point.

## Logging

On first evaluation, the resolved flag set is logged at `console.debug` level so
operators can inspect which flags are active in the browser console during
development. In production builds, `console.debug` is stripped by Vite's esbuild
config (`vite.config.ts` → `esbuild.drop`).

## Deterministic behavior

- Flags are evaluated **once** at module load time and the result is frozen with
  `Object.freeze()`.
- The same input (env vars, build mode) always produces the same output.
- Flags cannot be mutated at runtime — this is intentional to prevent accidental
  state changes and to make the system simple to reason about.
