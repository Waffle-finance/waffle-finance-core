# Coordinator and relayer public API contract

This document is the public HTTP and event-flow contract for the
WaffleFinance coordinator and relayer. It describes the supported integration
surface in the current repository. Routes that happen to exist for debugging
or local administration are not public unless they are listed here.

The HTTP paths are currently unversioned. Backwards-incompatible changes to a
listed path, request, response, error, or limit require either a new versioned
path or a coordinated migration of all callers.

## Conventions

- Both services listen on port `3001` by default. Deployments may publish a
  different origin or port.
- JSON request bodies use `Content-Type: application/json`.
- Amounts in atomic units are decimal strings, never JSON numbers. Human-unit
  amounts on the legacy relayer API are also strings.
- Unix timestamps are seconds unless a field name ends in `Ms` or its endpoint
  explicitly says milliseconds.
- A nullable field is returned as `null`; it is not necessarily omitted.
- Examples use shortened transaction hashes and calldata for readability.

The coordinator is the persistent order book and secret coordination API. The
relayer endpoints are the legacy transaction-building and settlement
compatibility API. An order ID created by one service is not interchangeable
with an ID created by the other:

| Name                        | Format                                               | Owner                |
| --------------------------- | ---------------------------------------------------- | -------------------- |
| Coordinator public order ID | `wf_0x` followed by 64 hex characters                | Coordinator          |
| Relayer order ID            | `order_<unix-ms>_<six base36 chars>`                 | Relayer              |
| On-chain order ID           | Chain-specific string or integer encoded as a string | HTLC/escrow contract |

## Coordinator API

Default local base URL: `http://localhost:3001`.

### Transport, authentication, and request IDs

The coordinator accepts JSON bodies up to 1 MiB. All listed routes are
currently unauthenticated. A bearer token configured through
`COORDINATOR_API_KEYS` does not grant access to additional data; it only
bypasses the three rate limits documented below.

Every response has an `X-Request-ID` header. A non-empty caller-supplied
`X-Request-ID` of at most 128 characters is echoed; otherwise the coordinator
generates a UUID. Include this value in support requests.

### Endpoint summary

| Method | Path                          | Purpose                           | Success      |
| ------ | ----------------------------- | --------------------------------- | ------------ |
| `GET`  | `/health`                     | Service and reconciliation health | `200`        |
| `GET`  | `/healthz`                    | Process liveness                  | `200`        |
| `GET`  | `/readyz`                     | Dependency readiness              | `200`, `503` |
| `GET`  | `/metrics`                    | Prometheus text exposition        | `200`        |
| `POST` | `/api/orders/announce`        | Publish a swap intent             | `201`        |
| `GET`  | `/api/orders/history`         | List orders for one wallet        | `200`        |
| `GET`  | `/api/orders/{id}`            | Read one order                    | `200`        |
| `POST` | `/api/orders/{id}/src-locked` | Record a source-chain lock        | `200`        |
| `POST` | `/api/orders/{id}/dst-locked` | Record a destination-chain lock   | `200`        |
| `POST` | `/api/secrets/reveal`         | Validate and record a preimage    | `200`        |
| `GET`  | `/api/secrets/{publicId}`     | Read a revealed preimage          | `200`        |
| `GET`  | `/api/quotes/eth-xlm`         | Read an ETH/XLM quote             | `200`        |
| `GET`  | `/api/quotes/eth-sol`         | Read an ETH/SOL quote             | `200`        |
| `GET`  | `/api/prices`                 | Read the aggregate price feed     | `200`        |

### Error envelope

Coordinator JSON errors have this shape:

```json
{
  "error": "validation_error",
  "message": "Request validation failed",
  "details": [
    {
      "code": "invalid_type",
      "path": ["hashlock"],
      "message": "Required"
    }
  ],
  "retryable": false
}
```

`error` and `message` are always present. `details` is present for Zod request
validation errors. `retryable` is present on classified secret-reveal errors.
The normal error codes are:

| HTTP  | `error`                  | Meaning                                                        |
| ----- | ------------------------ | -------------------------------------------------------------- |
| `400` | `validation_error`       | A path, query, or body value has the wrong shape.              |
| `400` | `order_validation_error` | The request violates order state or uniqueness rules.          |
| `400` | `invalid_cursor`         | The history cursor cannot be decoded.                          |
| `400` | `invalid_preimage`       | The preimage does not match the order hashlock; not retryable. |
| `404` | `not_found`              | A validly formatted order ID is unknown.                       |
| `404` | `not_revealed`           | No preimage has been revealed for this order.                  |
| `404` | `unknown_order`          | A reveal references an unknown order; not retryable.           |
| `409` | `reveal_conflict`        | The order state no longer accepts a reveal; not retryable.     |
| `429` | `too_many_requests`      | The caller exceeded an enforced per-IP limit.                  |
| `500` | `storage_failure`        | Secret persistence failed; retryable.                          |
| `500` | `internal_error`         | An unexpected, sanitized server error.                         |

Unknown paths use Express's default `404` response and are not guaranteed to
use the JSON envelope.

### Rate limits

Limits are fixed-window, per client IP, and stored in process memory. Each
coordinator instance therefore maintains its own counters.

| Endpoint                               |                Limit |     Window |
| -------------------------------------- | -------------------: | ---------: |
| `POST /api/orders/announce`            |          20 requests | 60 seconds |
| `POST /api/secrets/reveal`             |           5 requests | 60 seconds |
| `GET /api/secrets/{publicId}`          |          30 requests | 60 seconds |
| All other listed coordinator endpoints | No application limit |          — |

Limited responses include `X-RateLimit-Limit`, `X-RateLimit-Remaining`, and
`X-RateLimit-Reset` (seconds until this process's bucket resets). A `429` also
includes `Retry-After` and:

```json
{
  "error": "too_many_requests",
  "message": "Rate limit exceeded. Try again shortly.",
  "retryAfterSeconds": 42
}
```

Resolvers that receive an operator-issued key may send
`Authorization: Bearer <key>` to bypass these limits. `X-Forwarded-For` is
only used when the direct proxy address is configured in
`COORDINATOR_TRUSTED_PROXIES`.

### Order representation

Order endpoints return the following representation. `createdAt` and
`updatedAt` are Unix seconds. `amount`, `safetyDeposit`, and on-chain order IDs
are strings to avoid precision loss.

```json
{
  "id": "wf_0xabababababababababababababababababababababababababababababababab",
  "direction": "eth_to_xlm",
  "status": "announced",
  "hashlock": "0xabababababababababababababababababababababababababababababababab",
  "src": {
    "chain": "ethereum",
    "address": "0x1111111111111111111111111111111111111111",
    "asset": "native",
    "amount": "1000000000000000000",
    "safetyDeposit": "1000000000000000",
    "orderId": null,
    "lockTx": null,
    "lockBlock": null,
    "timelock": null
  },
  "dst": {
    "chain": "stellar",
    "address": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422",
    "asset": "native",
    "amount": "100000000",
    "orderId": null,
    "lockTx": null,
    "lockBlock": null,
    "timelock": null
  },
  "secret": {
    "revealed": false,
    "preimage": null,
    "revealedTx": null
  },
  "resolver": null,
  "createdAt": 1751193600,
  "updatedAt": 1751193600
}
```

`direction` is one of `eth_to_xlm`, `xlm_to_eth`, `eth_to_sol`, or
`sol_to_eth`. `chain` is one of `ethereum`, `stellar`, or `solana`. `status`
is one of `announced`, `src_locked`, `dst_locked`, `secret_revealed`,
`completed`, `refunded`, `failed`, or `expired`.

Once revealed, `secret.preimage` contains the plaintext preimage. Treat order
responses after reveal as sensitive even when encryption at rest is enabled.

### `POST /api/orders/announce`

Publishes an intent. It does not lock or transfer funds. The public ID is
deterministic: `wf_` plus the lower-cased hashlock.

Request:

```json
{
  "direction": "eth_to_xlm",
  "hashlock": "0xabababababababababababababababababababababababababababababababab",
  "srcChain": "ethereum",
  "srcAddress": "0x1111111111111111111111111111111111111111",
  "srcAsset": "native",
  "srcAmount": "1000000000000000000",
  "srcSafetyDeposit": "1000000000000000",
  "dstChain": "stellar",
  "dstAddress": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422",
  "dstAsset": "native",
  "dstAmount": "100000000"
}
```

All fields are required. Amounts must match `^\d+$`; the hashlock must be a
`0x`-prefixed 32-byte hex string. Direction fixes the chain pair:

| Direction    | Source   | Destination |
| ------------ | -------- | ----------- |
| `eth_to_xlm` | Ethereum | Stellar     |
| `xlm_to_eth` | Stellar  | Ethereum    |
| `eth_to_sol` | Ethereum | Solana      |
| `sol_to_eth` | Solana   | Ethereum    |

Ethereum addresses are non-zero, 20-byte hex addresses; Stellar addresses are
`G` plus 55 base32 characters; Solana addresses are 32–44 base58 characters.
Success is `201` with an Order. A duplicate hashlock returns
`400 order_validation_error`.

### `GET /api/orders/history`

Required query parameter:

- `address`: a valid Ethereum, Stellar, or Solana address.

Optional query parameters:

- `limit`: default `50`; values greater than `200` are capped at `200`.
  Supported client values are integers from 1 through 200.
- `offset`: non-negative integer, default `0`. Used when `cursor` is absent.
- `cursor`: a non-empty opaque base64url cursor. When present it takes
  precedence over `offset`.

Offset-mode response:

```json
{
  "transactions": [],
  "pagination": { "limit": 50, "offset": 0, "count": 0 }
}
```

Cursor-mode response:

```json
{
  "transactions": [],
  "pagination": { "limit": 50, "count": 0, "nextCursor": null }
}
```

Results are newest first. The current HTTP route starts in offset mode and
does not return a cursor on that first page; cursor mode is therefore only for
callers that already hold a cursor. An empty cursor selects offset mode. This
bootstrap limitation is part of the current behavior, not a recommendation
to manufacture cursors.

### `GET /api/orders/{id}`

`id` must match `wf_0x` plus 64 hex characters. Success is `200` with an
Order. A malformed ID returns `400 validation_error`; a well-formed unknown ID
returns `404 not_found`.

### Lock recording endpoints

These endpoints are supported for trusted chain indexers. Normal clients
should let the coordinator's chain listeners record locks from events.

`POST /api/orders/{id}/src-locked` request:

```json
{
  "orderId": "42",
  "txHash": "0x1234...",
  "blockNumber": 6123456,
  "timelock": 1751200800
}
```

`POST /api/orders/{id}/dst-locked` accepts the same fields plus an optional
nullable resolver:

```json
{
  "orderId": "99123",
  "txHash": "a1b2c3...",
  "blockNumber": 987654,
  "timelock": 1751197200,
  "resolver": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422"
}
```

`orderId` and `txHash` are non-empty strings. `blockNumber` and `timelock` are
non-negative integers and numeric strings are coerced. Success is:

```json
{ "ok": true }
```

Invalid state transitions and unknown orders return
`400 order_validation_error`.

### Secret endpoints

`POST /api/secrets/reveal` request:

```json
{
  "publicId": "wf_0xabababababababababababababababababababababababababababababababab",
  "preimage": "0x0123456789abcdef",
  "txHash": "0x9876..."
}
```

The coordinator accepts a non-empty `publicId`, an even or odd length
`0x`-prefixed hex `preimage`, and a non-empty `txHash`. It validates both
SHA-256 and Keccak-256 against the stored hashlock. Success is:

```json
{ "ok": true }
```

Classified failures are `invalid_preimage` (`400`), `unknown_order` (`404`),
`reveal_conflict` (`409`), and `storage_failure` (`500`), each with a
`retryable` boolean.

`GET /api/secrets/{publicId}` returns:

```json
{
  "publicId": "wf_0xabababababababababababababababababababababababababababababababab",
  "preimage": "0x0123456789abcdef"
}
```

It returns `404 not_revealed` both when the order is unknown and when its
preimage has not been revealed. Preimages are public settlement material once
revealed, but clients should still avoid retaining them in logs.

### Quote endpoints

`GET /api/quotes/eth-xlm` returns USD values as strings:

```json
{
  "ethUsd": "3500",
  "xlmUsd": "0.12",
  "rate": 29166.666666666668,
  "source": "coingecko",
  "staleness": "fresh",
  "fetchedAt": 1751193600000,
  "ageMs": 8
}
```

`GET /api/quotes/eth-sol` has the same shape with `solUsd` in place of
`xlmUsd`. The USD strings and `rate` can be `null` for an unknown internal
pair, although the two listed pairs have numeric fallbacks.

`GET /api/prices` returns numeric aggregate values:

```json
{
  "ethUsd": 3500,
  "xlmUsd": 0.12,
  "solUsd": 150,
  "xlmPerEth": 29166.666666666668,
  "ethPerXlm": 0.000034285714285714285,
  "source": "coingecko",
  "staleness": "fresh",
  "fetchedAt": 1751193600000,
  "ageMs": 8
}
```

`source` is `coingecko`, `cache`, or `fallback`; `staleness` is `fresh`,
`stale`, or `fallback`. The aggregate reports the worst source/staleness and
the oldest fetch time across both pairs. `xlmPerEth` or `ethPerXlm` is `null`
only if its divisor is zero. CoinGecko failures normally produce a `200`
fallback response rather than an error.

### Health and metrics

`GET /health` returns `status: "ok"`, service metadata, and either a
reconciliation object or `null`:

```json
{
  "status": "ok",
  "service": "wafflefinance-coordinator",
  "version": "1.0.0",
  "uptimeSeconds": 123,
  "timestamp": "2026-06-29T12:00:00.000Z",
  "reconciliation": {
    "lastRunAt": 1782734399000,
    "lastRunOk": true,
    "eventsReplayed": 0
  }
}
```

`GET /healthz` omits reconciliation and always returns liveness with `200`.

`GET /readyz` returns `200` with `status: "ok"` when every check passes or
`503` with `status: "degraded"` otherwise. Checks cover `database`,
`ethereum_rpc`, `soroban_rpc`, `solana_rpc`, and `reconciliation`:

```json
{
  "status": "degraded",
  "service": "wafflefinance-coordinator",
  "version": "1.0.0",
  "uptimeSeconds": 123,
  "timestamp": "2026-06-29T12:00:00.000Z",
  "checks": [
    { "name": "database", "ok": true, "latencyMs": 1 },
    { "name": "ethereum_rpc", "ok": false, "detail": "unavailable", "latencyMs": 751 }
  ]
}
```

`GET /metrics` returns Prometheus text using the registry content type. A
collection failure returns `500` as plain text.

## Relayer API

Default local base URL: `http://localhost:3001`.

This is a legacy compatibility surface backed by an in-memory order map.
Orders are lost when the process restarts. Response objects include additional
implementation fields and differ between testnet, mainnet, and mock mode;
clients must rely only on the fields documented below.

The relayer accepts JSON bodies up to 10 MiB and has no inbound authentication
or application-level rate limiter on its public endpoints. It does not return
rate-limit headers and has no `429` contract. RPC-provider retries visible in
the implementation are outbound protections, not client quotas. Production
operators should apply authentication and rate limiting at the gateway.

### Endpoint summary

| Method        | Path                        | Purpose                             | Success      |
| ------------- | --------------------------- | ----------------------------------- | ------------ |
| `GET`         | `/`                         | Service banner                      | `200`        |
| `GET`         | `/health`                   | Aggregate service health            | `200`, `503` |
| `GET`         | `/healthz`                  | Process liveness                    | `200`        |
| `GET`         | `/readyz`                   | Chain/service readiness             | `200`, `503` |
| `GET`         | `/metrics`                  | Legacy JSON monitoring snapshot     | `200`        |
| `GET`         | `/uptime`                   | Compact uptime snapshot             | `200`        |
| `GET`, `POST` | `/api/wake`                 | Mark a browser session present      | `204`        |
| `GET`         | `/api/prices`               | Cached ETH/XLM price feed           | `200`        |
| `POST`        | `/api/transactions/history` | In-memory address history           | `200`        |
| `POST`        | `/api/orders/create`        | Create a relayer order/instructions | `200`        |
| `POST`        | `/api/orders/process`       | Settle an existing relayer order    | `200`        |
| `POST`        | `/api/orders/xlm-to-eth`    | Release ETH after an XLM payment    | `200`        |
| `POST`        | `/api/orders/manual-refund` | Verify and refund an XLM payment    | `200`        |
| `GET`         | `/api/escrow/info`          | Read the configured mainnet factory | `200`        |

Relayer errors are not normalized. Each error response contains at least an
`error` string, but may also contain `success`, `message`, `details`,
`errorCode`, `errorName`, `refund`, `required`, or an order/transaction ID.
Callers must branch on HTTP status first and treat extra fields as diagnostic.

### Service and price endpoints

`GET /` returns:

```json
{ "message": "WaffleFinance Relayer API", "status": "running" }
```

`GET` or `POST /api/wake` returns an empty `204` response. It records recent
frontend presence and wakes already-running pollers; it does not itself start
chain RPC polling when no order is in flight.

`GET /api/prices` returns numeric prices and cache timing in milliseconds:

```json
{
  "xlmUsd": 0.12,
  "ethUsd": 3500,
  "ethPerXlm": 0.000034285714285714285,
  "xlmPerEth": 29166.666666666668,
  "source": "coingecko",
  "fetchedAt": 1751193600000,
  "cacheFreshMs": 15000,
  "cacheStaleMs": 60000
}
```

`source` is `coingecko`, `cache`, or `fallback`. A feed failure outside the
normal fallback path returns `503` with `error` and `details` strings.

### `POST /api/transactions/history`

Request fields are optional strings; at least one address is recommended:

```json
{
  "ethAddress": "0x1111111111111111111111111111111111111111",
  "stellarAddress": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422"
}
```

The route performs exact, case-sensitive comparisons against the in-memory
orders and returns newest first:

```json
{
  "success": true,
  "transactions": [
    {
      "id": "order_1751193600000_a1b2c3",
      "txHash": "order_1751193600000_a1b2c3",
      "fromNetwork": "Stellar Testnet",
      "toNetwork": "ETH Sepolia",
      "fromToken": "XLM",
      "toToken": "ETH",
      "amount": "0",
      "estimatedAmount": "0",
      "status": "pending",
      "timestamp": 1751193600000,
      "direction": "xlm_to_eth"
    }
  ],
  "count": 1
}
```

The normalized history status is `completed`, `failed`, `cancelled`, or
`pending`. Unexpected failures return `500` with `error` and `details`.

### `POST /api/orders/create`

Request:

```json
{
  "fromChain": "ethereum",
  "toChain": "stellar",
  "fromToken": "ETH",
  "toToken": "XLM",
  "amount": "0.001",
  "ethAddress": "0x1111111111111111111111111111111111111111",
  "stellarAddress": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422",
  "direction": "eth_to_xlm",
  "exchangeRate": 29166.666666666668,
  "networkMode": "testnet"
}
```

`fromChain`, `toChain`, `fromToken`, `toToken`, `amount`, `ethAddress`, and
`stellarAddress` are required non-empty values. Supported `direction` values
are `eth_to_xlm` and `xlm_to_eth`. `networkMode` is `testnet` or `mainnet` and
takes precedence over the optional `network` body field, `network` query
parameter, and service default, in that order. `exchangeRate` is optional.

The route currently performs presence checks rather than full address/amount
schema validation. Partners should still send canonical addresses and a
positive base-10 amount string.

A missing required value returns `400`:

```json
{
  "error": "Missing required fields",
  "required": [
    "fromChain",
    "toChain",
    "fromToken",
    "toToken",
    "amount",
    "ethAddress",
    "stellarAddress"
  ]
}
```

For live `eth_to_xlm`, the stable success fields are:

```json
{
  "success": true,
  "orderId": "order_1751193600000_a1b2c3",
  "orderData": {
    "status": "pending_direct_escrow"
  },
  "approvalTransaction": {
    "to": "0x0ABa862Da2F004bCa6ce2990EbC0f77184B6d3a8",
    "value": "0x27147114878000",
    "data": "0x<ABI-encoded calldata>",
    "gas": "0x2DC6C0"
  },
  "message": "...",
  "nextStep": "...",
  "instructions": ["..."],
  "safetyDeposit": "0.01",
  "totalCost": "0.011",
  "contractType": "ESCROW_FACTORY_DIRECT_TESTNET",
  "contractAddress": "0x0ABa862Da2F004bCa6ce2990EbC0f77184B6d3a8",
  "note": "..."
}
```

Mainnet uses the same stable outer fields but returns `dstImmutables` and
`srcCancellationTimestamp` instead of `escrowConfig`, and its contract type
and transaction target differ.

For live `xlm_to_eth`, success means the relayer is waiting for payment:

```json
{
  "success": true,
  "orderId": "order_1751193600000_a1b2c3",
  "message": "⏳ XLM→ETH: Order created - Please send XLM to complete swap",
  "orderData": {
    "stellarAmount": "10000000",
    "stellarAddress": "GRELAYER...",
    "memo": "XLM-ETH-order_17",
    "expectedEthAmount": "34286000000000",
    "status": "awaiting_xlm_payment",
    "instructions": "Send 1 XLM to GRELAYER... with memo: XLM-ETH-order_17"
  }
}
```

Mock mode returns simulated `ethereum` and `stellar` objects and may omit
`approvalTransaction`. The additional `orderData` object is
implementation-defined and currently includes generated HTLC material,
including a secret. Do not log or persist it wholesale. Any other failure,
including an unsupported direction, returns `500` with `error` and `details`.

### `POST /api/orders/process`

Settles an order still present in the relayer's in-memory map.

For ETH to XLM, send exactly `txHash`:

```json
{
  "orderId": "order_1751193600000_a1b2c3",
  "txHash": "0x1234...",
  "stellarAddress": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422",
  "ethAddress": "0x1111111111111111111111111111111111111111"
}
```

For XLM to ETH, send exactly `stellarTxHash`:

```json
{
  "orderId": "order_1751193600000_a1b2c3",
  "stellarTxHash": "a1b2c3...",
  "stellarAddress": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422",
  "ethAddress": "0x1111111111111111111111111111111111111111"
}
```

`orderId` is required. Exactly one of `txHash` or `stellarTxHash` is required
by the supported contract because it selects the direction. Stored addresses
take precedence over body addresses. Sending both or neither is outside the
contract and the current handler may not complete a response.

ETH-to-XLM success:

```json
{
  "success": true,
  "orderId": "order_1751193600000_a1b2c3",
  "stellarTxId": "a1b2c3...",
  "message": "Cross-chain swap completed successfully!",
  "details": {
    "ethereum": { "txHash": "0x1234...", "status": "confirmed" },
    "stellar": {
      "txId": "a1b2c3...",
      "amount": "29.1666667 XLM",
      "destination": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422",
      "status": "completed"
    }
  }
}
```

XLM-to-ETH success has `ethTxId` and the inverse `details` structure. The
general XLM-to-ETH path waits for confirmation and reports Ethereum status
`completed`. A Stellar submission failure returns `502` with `success: false`,
chain details, and `refundHint`. Missing/unknown orders return `400`/`404`;
other settlement failures return `500`.

### `POST /api/orders/xlm-to-eth`

This is the frontend's dedicated ETH-release route. Request:

```json
{
  "orderId": "order_1751193600000_a1b2c3",
  "stellarTxHash": "a1b2c3...",
  "stellarAddress": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422",
  "ethAddress": "0x1111111111111111111111111111111111111111",
  "networkMode": "testnet"
}
```

`orderId`, `stellarTxHash`, and `ethAddress` are required. `stellarAddress` is
strongly required for safe automatic refunds even though the route's initial
presence check does not reject its absence. `networkMode` or the `network`
query parameter selects `testnet`/`mainnet`. The Ethereum address is
normalized and validated by ethers. This endpoint currently trusts the
supplied `stellarTxHash` and labels it confirmed; it does not independently
verify that payment before broadcasting ETH.

Success means the Ethereum transfer was broadcast, not confirmed:

```json
{
  "success": true,
  "orderId": "order_1751193600000_a1b2c3",
  "ethTxId": "0x9876...",
  "message": "XLM→ETH transfer broadcasted",
  "details": {
    "stellar": { "txHash": "a1b2c3...", "status": "confirmed" },
    "ethereum": {
      "txId": "0x9876...",
      "amount": "0.000034 ETH",
      "destination": "0x1111111111111111111111111111111111111111",
      "status": "pending"
    }
  }
}
```

Notable failures are `400` for missing fields or insufficient relayer balance,
and `500` for configuration/RPC/release failures. If ETH release fails after
XLM was sent, the `500` response includes a `refund` object with status
`completed` and a Stellar hash, or status `failed` plus recovery details.

### `POST /api/orders/manual-refund`

Request:

```json
{
  "stellarTxHash": "a1b2c3...",
  "stellarAddress": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422",
  "networkMode": "testnet"
}
```

The transaction must be a native XLM payment from `stellarAddress` to the
configured relayer account. The service subtracts `0.0001` XLM for fees and
uses recent transaction memos to detect a prior refund.

Success:

```json
{
  "success": true,
  "refundTxHash": "d4e5f6...",
  "amount": "0.9999000",
  "destination": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422",
  "network": "testnet",
  "message": "XLM successfully refunded to your wallet"
}
```

Failures are `400` for missing/mismatched payment data, `404` when the source
transaction cannot be verified, `409` when a refund is already detected, and
`500` for relayer configuration or submission failures.

### Relayer health, readiness, and monitoring

`GET /health` returns `200` for `healthy` or `degraded` and `503` for
`unhealthy` or a check failure:

```json
{
  "status": "healthy",
  "timestamp": 1782734400,
  "uptime": 123,
  "version": "1.0.0",
  "services": [{ "name": "ethereum", "status": "healthy", "lastCheck": 1782734390 }]
}
```

`GET /healthz` always returns process liveness:

```json
{
  "status": "ok",
  "service": "wafflefinance-relayer",
  "timestamp": 1782734400,
  "uptime": 123,
  "version": "1.0.0"
}
```

`GET /readyz` returns `200`/`503`, `status: "ok"`/`"degraded"`, the same
service metadata, and checks for `ethereum_rpc`, `stellar_rpc`, and registered
services. Each check has `name`, `ok`, optional `detail`, and optional
`latencyMs`.

`GET /metrics` currently returns the legacy JSON monitoring snapshot because
that handler is registered before the relayer's Prometheus router. Its top
level fields are `uptime`, `timestamp`, `version`, `environment`, `services`,
`system`, `network`, `database`, and `performance`. Consumers that require
Prometheus text must not assume it is available from the full relayer process.

`GET /uptime` returns:

```json
{
  "uptime": 123,
  "startTime": 1782734277,
  "currentTime": 1782734400,
  "status": "healthy"
}
```

Monitoring failures on `/metrics` or `/uptime` return `500` with `error` and
`message` strings.

`GET /api/escrow/info` returns the configured mainnet factory address:

```json
{
  "success": true,
  "escrowFactory": "0xa7bcb4eac8964306f9e3764f67db6a7af6ddf99a",
  "method": "createDstEscrow",
  "note": "Using 1inch cross-chain resolver pattern"
}
```

An unexpected lookup failure returns `500` with `success: false` and an
`error` string.

### Unsupported relayer routes

The following mounted routes are diagnostics or local administration and are
deliberately outside the public contract: `/test`, `/api/test`,
`/api/test-transaction`, `/api/debug/*`, and `/api/admin/*`. They may change or
be removed without notice. In particular, never send private keys to a hosted
HTTP endpoint.

## Event-flow contract

Neither service currently exposes WebSocket, Server-Sent Events, webhook, or
message-broker delivery to public clients. “Event flow” below means the
on-chain events the services consume and the observable HTTP state changes
they cause.

### Coordinator lifecycle

```text
POST /api/orders/announce
          |
          v
      announced
          |
          | source OrderCreated / manual src-locked
          v
      src_locked
          |
          | destination lock / manual dst-locked
          v
      dst_locked
          |
          | OrderClaimed or POST /api/secrets/reveal
          v
   secret_revealed
          |
          v
      completed

Non-terminal orders may also become refunded, failed, or expired.
```

The coordinator correlates `OrderCreated` to an announced order by hashlock.
Events without a matching local announcement do not create a public order.
Updates are idempotent where the current state already reflects the same lock.

| Chain    | Consumed event                                                                                 | Required correlation data              | Observable effect                                   |
| -------- | ---------------------------------------------------------------------------------------------- | -------------------------------------- | --------------------------------------------------- |
| Ethereum | `OrderCreated(orderId, sender, beneficiary, token, amount, safetyDeposit, hashlock, timelock)` | `hashlock`                             | Records source lock data and moves to `src_locked`. |
| Ethereum | `OrderClaimed(orderId, claimer, preimage, amount, safetyDeposit)`                              | `orderId`, `preimage`                  | Reconciliation validates and records the secret.    |
| Ethereum | `OrderRefunded(orderId, caller, amount, safetyDeposit)`                                        | `orderId`                              | Reconciliation marks the order `refunded`.          |
| Soroban  | `OrderCreated` topic                                                                           | `hashlock`, `orderId`, `timelock`      | Records source lock data.                           |
| Soroban  | `OrderClaimed` topic                                                                           | `orderId`, `preimage`                  | Records the revealed secret.                        |
| Soroban  | `OrderRefunded` topic                                                                          | `orderId`                              | Marks the order `refunded`.                         |
| Solana   | Anchor log containing `OrderCreated`                                                           | JSON `hashlock`, `orderId`, `timelock` | Records source lock data.                           |
| Solana   | Anchor log containing `OrderClaimed`                                                           | JSON `orderId`, `preimage`             | Records the revealed secret.                        |
| Solana   | Anchor log containing `OrderRefunded`                                                          | JSON `orderId`                         | Marks the order `refunded`.                         |

Live listeners and periodic reconciliation can both observe an event. Clients
must therefore treat order reads as eventually consistent and must not infer
exactly-once delivery from an `updatedAt` change. Ethereum reorg removal of an
`OrderCreated` log rolls back the recorded source lock.

### Relayer settlement flow

The relayer starts chain polling lazily when an in-memory order needs it.
Mainnet watches 1inch `SrcEscrowCreated` and `DstEscrowCreated`; testnet watches
custom `EscrowCreated` and `EscrowFunded`; the HTLC bridge listener observes
testnet `OrderCreated`. A Stellar poller also looks for XLM payments to pending
orders. These events mutate the in-memory order status and may trigger the
counter-chain action.

```text
POST /api/orders/create
          |
          +-- ETH -> XLM: return wallet transaction
          |        |
          |        +-- wallet submits Ethereum transaction
          |        +-- POST /api/orders/process
          |        `-- relayer submits Stellar payment
          |
          `-- XLM -> ETH: return Stellar payment instructions
                   |
                   +-- user submits Stellar payment
                   +-- POST /api/orders/xlm-to-eth
                   `-- relayer broadcasts Ethereum transfer
```

HTTP success has operation-specific finality: create only prepares an order;
the dedicated XLM-to-ETH endpoint reports an Ethereum broadcast; the general
process endpoint waits for the settlement transaction in its normal paths.
Use the returned chain transaction IDs to obtain canonical finality from the
relevant chain.

## Compatibility checklist for contributors

When changing a listed endpoint:

1. Update the handler and its tests.
2. Update this contract's request, success, error, and limit sections.
3. Preserve existing field types; add fields rather than changing meanings.
4. Verify examples against the serialized handler response.
5. For a breaking change, introduce a versioned route and migration window.
