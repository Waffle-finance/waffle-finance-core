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
