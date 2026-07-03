# Coordinator API Integration Guide

## Overview

The WaffleFinance Coordinator is a REST API responsible for coordinating cross-chain swap metadata between supported blockchains. It tracks order lifecycle events, exposes pricing information, manages secret revelation, and provides operational endpoints for monitoring.

The coordinator **does not custody user funds or sign blockchain transactions**. Settlement is enforced by the underlying HTLC smart contracts, while the coordinator acts as a metadata and orchestration service.

---

# Base URL

For local development:

```
http://localhost:3000/api
```

Health and monitoring endpoints are available outside the `/api` prefix.

---

# Authentication

The current Coordinator API does **not require bearer tokens or JWT authentication**.

Instead:

- Public endpoints are accessible without authentication.
- Write endpoints are protected using rate limiting.
- Trusted resolvers may be configured with API keys to bypass certain rate limits.

If deploying the coordinator publicly, it is recommended to place it behind an API gateway or reverse proxy with appropriate access controls.

---

# API Endpoints

---

## Announce an Order

**POST**

```
/api/orders/announce
```

Creates a new coordinator order after validating the payload.

### Example Request

```json
{
  "direction": "eth_to_xlm",
  "hashlock": "0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  "srcChain": "ethereum",
  "srcAddress": "0x1234567890123456789012345678901234567890",
  "srcAsset": "ETH",
  "srcAmount": "1000000000000000000",
  "srcSafetyDeposit": "10000000000000000",
  "dstChain": "stellar",
  "dstAddress": "GBRPYHIL2C2K7YQEXAMPLEADDRESS1234567890ABCDE",
  "dstAsset": "XLM",
  "dstAmount": "250000000"
}
```

### Validation Rules

- `direction` must match the selected source and destination chains.
- `hashlock` must be a 32-byte hexadecimal value prefixed with `0x`.
- Amounts must be decimal integer strings.
- Source and destination addresses are validated according to their blockchain.

### Success Response (201)

```json
{
  "id": "order_123",
  "direction": "eth_to_xlm",
  "status": "announced",
  "hashlock": "0x012345...",
  "src": {
    "chain": "ethereum",
    "address": "0x123...",
    "asset": "ETH",
    "amount": "1000000000000000000"
  },
  "dst": {
    "chain": "stellar",
    "address": "GBR...",
    "asset": "XLM",
    "amount": "250000000"
  },
  "secret": {
    "revealed": false,
    "preimage": null,
    "revealedTx": null
  },
  "resolver": null,
  "createdAt": "2026-06-30T10:00:00Z",
  "updatedAt": "2026-06-30T10:00:00Z"
}
```

---

# Retrieve an Order

**GET**

```
/api/orders/{id}
```

Returns the current coordinator record for an order.

### Example

```
GET /api/orders/order_123
```

### Success Response

Returns the serialized order including:

- status
- source information
- destination information
- resolver
- secret status
- timestamps

---

# Retrieve Order History

**GET**

```
/api/orders/history
```

### Query Parameters

| Parameter | Description |
|------------|-------------|
| address | Required wallet address |
| limit | Maximum results (default 50, max 200) |
| cursor | Cursor-based pagination token |
| offset | Legacy offset pagination |

Cursor-based pagination is recommended for new integrations.

### Example

```
GET /api/orders/history?address=0x123...&limit=25
```

---

# Record Source Lock

**POST**

```
/api/orders/{id}/src-locked
```

Records that the source-chain HTLC has been locked.

### Request

```json
{
  "orderId": "12345",
  "txHash": "0xabc123",
  "blockNumber": 123456,
  "timelock": 1735600000
}
```

### Response

```json
{
  "ok": true
}
```

---

# Record Destination Lock

**POST**

```
/api/orders/{id}/dst-locked
```

Records that the destination-chain HTLC has been locked.

### Request

```json
{
  "orderId": "67890",
  "txHash": "0xdef456",
  "blockNumber": 654321,
  "timelock": 1735601000,
  "resolver": "0xResolverAddress"
}
```

The `resolver` field is optional.

### Response

```json
{
  "ok": true
}
```

---

# ETH/XLM Quote

**GET**

```
/api/quotes/eth-xlm
```

Returns pricing information for ETH/XLM swaps.

### Example Response

```json
{
  "ethUsd": "3500",
  "xlmUsd": "0.12",
  "rate": 29166.66,
  "source": "coingecko",
  "staleness": "fresh",
  "fetchedAt": 1735600000000,
  "ageMs": 800
}
```

---

# ETH/SOL Quote

**GET**

```
/api/quotes/eth-sol
```

Returns pricing information for ETH/SOL swaps.

---

# Aggregated Prices

**GET**

```
/api/prices
```

Returns combined pricing information for supported assets.

### Response

```json
{
  "ethUsd": 3500,
  "xlmUsd": 0.12,
  "solUsd": 150,
  "xlmPerEth": 29166.66,
  "ethPerXlm": 0.000034,
  "source": "coingecko",
  "staleness": "fresh",
  "fetchedAt": 1735600000000,
  "ageMs": 1200
}
```

---

# Reveal Secret

**POST**

```
/api/secrets/reveal
```

Records the revealed HTLC preimage.

### Request

```json
{
  "publicId": "order_123",
  "preimage": "0xabcdef1234567890",
  "txHash": "0xdeadbeef"
}
```

### Success Response

```json
{
  "ok": true
}
```

---

# Retrieve Revealed Secret

**GET**

```
/api/secrets/{publicId}
```

### Success Response

```json
{
  "publicId": "order_123",
  "preimage": "0xabcdef1234567890"
}
```

If the secret has not yet been revealed:

```json
{
  "error": "not_revealed",
  "message": "Secret has not been revealed for this order"
}
```

---

# Health Endpoints

## Health

```
GET /health
```

Returns service status and reconciliation information.

---

## Health Check

```
GET /healthz
```

Lightweight health endpoint suitable for load balancers.

---

## Readiness

```
GET /readyz
```

Returns readiness status and dependency checks.

Returns:

- HTTP 200 when ready
- HTTP 503 when degraded

---

## Metrics

```
GET /metrics
```

Returns Prometheus-compatible metrics for monitoring.

---

# Error Handling

All error responses follow a consistent structure.

```json
{
  "error": "validation_error",
  "message": "Request validation failed",
  "details": []
}
```

## Common Errors

| HTTP Status | Error | Meaning |
|--------------|--------|----------|
| 400 | validation_error | Request validation failed |
| 400 | order_validation_error | Business validation failed |
| 404 | not_found | Resource not found |
| 404 | not_revealed | Secret not yet available |
| 500 | internal_error | Unexpected server error |

Secret reveal failures may also include:

```json
{
  "error": "temporary_failure",
  "message": "...",
  "retryable": true
}
```

Applications should use the `retryable` field to determine whether an operation should be retried.

---

# Typical Integration Flow

1. Announce a new order using `POST /api/orders/announce`.
2. Monitor the order using `GET /api/orders/{id}`.
3. Record the source-chain lock using `POST /api/orders/{id}/src-locked`.
4. Record the destination-chain lock using `POST /api/orders/{id}/dst-locked`.
5. Reveal the HTLC secret using `POST /api/secrets/reveal`.
6. Retrieve the revealed secret using `GET /api/secrets/{publicId}` if needed.

---

# Troubleshooting

| Issue | Cause | Resolution |
|-------|-------|------------|
| `validation_error` | Invalid request payload | Ensure the payload matches the documented schema. |
| `order_validation_error` | Business rule violation | Verify chain direction, amounts, and order state. |
| `not_found` | Unknown order ID | Confirm the order was announced successfully. |
| `not_revealed` | Secret has not yet been published | Retry after the destination claim has completed. |
| `invalid_cursor` | Invalid or expired pagination cursor | Restart pagination without the cursor. |
| HTTP 429 | Rate limit exceeded | Retry later or configure a trusted resolver API key where appropriate. |
| HTTP 503 | Coordinator not ready | Wait until the readiness endpoint reports a healthy status. |

---

# Example cURL

Announce an order:

```bash
curl -X POST http://localhost:3000/api/orders/announce \
  -H "Content-Type: application/json" \
  -d @order.json
```

Retrieve an order:

```bash
curl http://localhost:3000/api/orders/order_123
```

Retrieve prices:

```bash
curl http://localhost:3000/api/prices
```

---

# JavaScript Example

```javascript
const response = await fetch("http://localhost:3000/api/orders/order_123");

if (!response.ok) {
  throw new Error("Request failed");
}

const order = await response.json();

console.log(order.status);
```
