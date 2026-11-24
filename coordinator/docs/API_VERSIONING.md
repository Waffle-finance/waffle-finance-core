# Coordinator API Versioning

## Overview

The coordinator exposes a public HTTP API for order queries, secret retrieval, and health checks. This API is consumed by:
- The WaffleFinance frontend (browser)
- External resolvers and integrators
- Monitoring and alerting systems

As the bridge evolves, the API must adapt without breaking existing integrations. This document describes the versioning strategy and compatibility guarantees.

## Versioning Strategy

### Version Specification

API version is specified via the `Accept` header:

```http
GET /orders/wf_0x1234...
Accept: application/vnd.waffle.v1+json
```

Supported versions:
- `application/vnd.waffle.v1+json` — Current stable version
- `application/vnd.waffle.v2+json` — Future version (not yet implemented)
- `application/json` or no header — Defaults to v1

### Version Compatibility Rules

1. **Additive changes** (backward compatible):
   - New fields in responses
   - New optional query parameters
   - New routes
   - **No version bump required** — added to current version

2. **Deprecations** (backward compatible with warning):
   - Fields marked as deprecated remain in responses for 2 major versions
   - Response includes `X-Api-Warning` header with deprecation notice
   - **No version bump required** — handled within current version

3. **Breaking changes** (require new version):
   - Renaming or removing response fields
   - Changing field types (string → number, etc.)
   - Changing response structure (nested → flat)
   - Removing routes
   - **Requires new major version** (v1 → v2)

### Version Lifecycle

- **Current stable**: v1 (released, supported indefinitely)
- **Beta**: v2 (in development, may change without notice)
- **Deprecated**: (none yet)

When a version is deprecated:
- It continues to work for at least 6 months
- All responses include `X-Api-Deprecated` header with sunset date
- Documentation clearly states the deprecation and migration path

## Current API (v1)

### Routes

#### `GET /orders/:id`

Fetch a single order by public ID.

**Request:**
```http
GET /orders/wf_0x1234abcd...
Accept: application/vnd.waffle.v1+json
```

**Response (v1):**
```json
{
  "id": "wf_0x1234abcd...",
  "direction": "eth_to_xlm",
  "status": "completed",
  "isRefundable": false,
  "hashlock": "0xabcd...",
  "src": {
    "chain": "ethereum",
    "address": "0x5678...",
    "asset": "ETH",
    "amount": "1000000000000000000",
    "safetyDeposit": "10000000000000000",
    "orderId": "0x1234",
    "lockTx": "0x9876...",
    "lockBlock": 12345678,
    "timelock": 1640000000
  },
  "dst": {
    "chain": "stellar",
    "address": "GXXX...",
    "asset": "XLM",
    "amount": "10000",
    "orderId": null,
    "lockTx": "abc123...",
    "lockBlock": 987654,
    "timelock": 1640001000
  },
  "secret": {
    "revealed": true,
    "preimage": "0xdef...",
    "revealedTx": "0xfed..."
  },
  "resolver": "0xResolver...",
  "createdAt": 1639999000,
  "updatedAt": 1640000500
}
```

#### `GET /orders/history?address=...&limit=...&cursor=...`

Fetch order history for an address (cursor-based pagination).

**Request:**
```http
GET /orders/history?address=0x1234...&limit=50&cursor=eyJjcmVhdGVkQXQiOjE2NDAwMDAwMDAsImlkIjoxMjM0fQ
Accept: application/vnd.waffle.v1+json
```

**Response (v1):**
```json
{
  "transactions": [
    { /* order object */ },
    { /* order object */ }
  ],
  "pagination": {
    "limit": 50,
    "count": 50,
    "nextCursor": "eyJjcmVhdGVkQXQiOjE2Mzk5OTkwMDAsImlkIjoxMjAwfQ"
  }
}
```

#### `GET /secrets/:hashlock`

Retrieve the preimage for a given hashlock.

**Request:**
```http
GET /secrets/0xabcd1234...
Accept: application/vnd.waffle.v1+json
```

**Response (v1):**
```json
{
  "hashlock": "0xabcd1234...",
  "preimage": "0xdef5678...",
  "orderId": "wf_0x1234...",
  "revealedAt": 1640000500
}
```

#### `GET /health/ready`

Readiness check for load balancers and orchestrators.

**Request:**
```http
GET /health/ready
```

**Response (v1):**
```json
{
  "status": "ready",
  "version": "1.0.0",
  "uptime": 86400
}
```

## Future API (v2)

**Status:** Not yet implemented

### Planned Changes

1. **Order response additions:**
   - `archivedAt`: Timestamp when order was soft-deleted (if archived)
   - `lifecycle`: Enriched status with completion percentage
   - `fees`: Separate fees object for clarity

2. **History pagination improvements:**
   - Add `totalCount` to pagination metadata
   - Support filtering by status, date range, etc.

3. **Export routes:**
   - `GET /export/orders/:id` — Full order lifecycle export
   - `POST /export/orders` — Bulk export with filters

### Example v2 Order Response

```json
{
  "id": "wf_0x1234abcd...",
  "direction": "eth_to_xlm",
  "status": "completed",
  "isRefundable": false,
  "hashlock": "0xabcd...",
  "src": { /* same as v1 */ },
  "dst": { /* same as v1 */ },
  "secret": { /* same as v1 */ },
  "resolver": "0xResolver...",
  "createdAt": 1639999000,
  "updatedAt": 1640000500,
  "archivedAt": null,
  "lifecycle": {
    "state": "completed",
    "completionPercent": 100
  },
  "fees": {
    "srcSafetyDeposit": "10000000000000000"
  }
}
```

## Migration Guide

### Frontend Integration

When the frontend needs to adopt v2:

1. Update all API calls to include the v2 Accept header:
   ```typescript
   const response = await fetch('/orders/wf_0x1234...', {
     headers: {
       'Accept': 'application/vnd.waffle.v2+json',
     },
   });
   ```

2. Update type definitions to match v2 response shape:
   ```typescript
   interface OrderV2 {
     // ... v1 fields ...
     archivedAt: number | null;
     lifecycle: {
       state: string;
       completionPercent: number;
     };
     fees: {
       srcSafetyDeposit: string;
     };
   }
   ```

3. Test with both v1 and v2 during the migration window.

4. Remove v1 Accept headers once v2 is stable.

### Resolver Integration

External resolvers should:

1. Pin to v1 until v2 is stable:
   ```python
   headers = {'Accept': 'application/vnd.waffle.v1+json'}
   response = requests.get(f'{coordinator_url}/orders/{order_id}', headers=headers)
   ```

2. Monitor `X-Api-Warning` headers for deprecation notices.

3. Plan v2 migration when v1 deprecation is announced.

## Testing Versioned APIs

### Unit Tests

```typescript
import { parseApiVersion, versionResponse } from './versioning';

test('parseApiVersion', () => {
  expect(parseApiVersion('application/vnd.waffle.v1+json')).toBe('v1');
  expect(parseApiVersion('application/vnd.waffle.v2+json')).toBe('v2');
  expect(parseApiVersion('application/json')).toBe('v1'); // default
  expect(parseApiVersion(undefined)).toBe('v1'); // default
});
```

### Integration Tests

```typescript
test('GET /orders/:id returns v1 response by default', async () => {
  const response = await request(app).get('/orders/wf_0x1234...');
  expect(response.body).toMatchObject({ id: 'wf_0x1234...', status: 'completed' });
  expect(response.body.lifecycle).toBeUndefined(); // v2 field not present
});

test('GET /orders/:id returns v2 response with Accept header', async () => {
  const response = await request(app)
    .get('/orders/wf_0x1234...')
    .set('Accept', 'application/vnd.waffle.v2+json');
  expect(response.body).toMatchObject({ id: 'wf_0x1234...', lifecycle: { state: 'completed' } });
});
```

## Rollout Process

When introducing a new API version:

1. **Development:**
   - Implement v2 routes and response transformers
   - Add integration tests for both v1 and v2
   - Document all changes in this file

2. **Beta:**
   - Deploy v2 to staging/testnet
   - Frontend team tests v2 integration
   - External integrators can opt-in via Accept header

3. **Stable:**
   - Deploy v2 to production
   - Announce v2 availability (docs, changelog)
   - v1 remains default for 6 months

4. **Deprecation (if needed):**
   - Announce v1 deprecation (6 months notice)
   - Add `X-Api-Deprecated` header to v1 responses
   - Monitor v1 usage via metrics

5. **Sunset:**
   - Remove v1 after deprecation window
   - All clients must have migrated to v2

## Monitoring

### Metrics

- `coordinator_api_requests_total{version="v1", route="/orders/:id"}`
- `coordinator_api_requests_total{version="v2", route="/orders/:id"}`

Track version adoption rates and identify clients still on deprecated versions.

### Alerts

- **ApiVersionMismatch:** A client is using an unsupported version
- **DeprecatedVersionUsage:** v1 usage remains high after deprecation announcement

## Route reference

A generated catalog of every public route across all three services (coordinator,
relayer, resolver) is maintained at [`docs/ROUTE_CATALOG.md`](../../docs/ROUTE_CATALOG.md).
It lists the HTTP method, path pattern, authorization class, and health semantics
for each endpoint.

The catalog is generated from `scripts/route-catalog-meta.mjs`. To regenerate it:

```bash
node scripts/generate-route-catalog.mjs
```

To validate that the metadata is consistent without writing the file (useful in CI):

```bash
node scripts/generate-route-catalog.mjs --check
# or via the root validate script:
pnpm validate:routes
```

Adding a route without a corresponding entry in `route-catalog-meta.mjs` will
cause `pnpm validate:routes` to fail with a `sourceRef` existence error on the
next CI run.

---

## References

- Versioning inspiration: [Stripe API Versioning](https://stripe.com/docs/api/versioning)
- Semantic Versioning: [semver.org](https://semver.org/)
- HTTP Accept header: [RFC 7231](https://tools.ietf.org/html/rfc7231#section-5.3.2)
- Route catalog: [docs/ROUTE_CATALOG.md](../../docs/ROUTE_CATALOG.md)
