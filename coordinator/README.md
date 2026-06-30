# @wafflefinance/coordinator

Reference coordinator (for the WaffleFinance cross-chain
bridge.

## What this service does

- Hosts the public order book — anyone can POST `/api/orders/announce`
  to publish a new HTLC swap intent.
- Watches both chains for `OrderCreated` / `OrderClaimed` /
  `OrderRefunded` events and updates a persistent local cache (SQLite).
- Coordinates secret reveals between the two chains: once a preimage is
  posted to `/api/secrets/reveal`, the coordinator validates it against
  the on-chain hashlock and broadcasts it so resolvers can settle the
  counterpart side.
- Provides a `/api/orders/history?address=...` endpoint the frontend
  consumes for transaction history.

## What this service deliberately does NOT do

- Hold user funds. Ever. Every cross-chain movement is gated by
  on-chain hashlock + timelock checks.
- Sign Ethereum or Stellar transactions on behalf of users. The
  user (or a resolver) submits all chain transactions from their own
  wallet.
- Fabricate order or secret data. If the underlying chain does not
  respond, the endpoint returns the real error.

## Secret reveal failure modes

`POST /api/secrets/reveal` classifies failures so clients can decide whether
to retry or abandon an attempt. Each failure returns a stable `error` code, an
appropriate HTTP status, and a `retryable` flag:

| `error` code       | HTTP | `retryable` | Meaning / client action |
| ------------------ | ---- | ----------- | ----------------------- |
| `validation_error` | 400  | n/a         | Malformed request body (missing/invalid fields). Fix the request. |
| `invalid_preimage` | 400  | `false`     | The preimage does not hash (sha256 or keccak256) to the order hashlock. Abandon — the secret is wrong. |
| `unknown_order`    | 404  | `false`     | No order exists for the supplied `publicId`. Abandon or check the id. |
| `reveal_conflict`  | 409  | `false`     | The order has moved past the point where a reveal is accepted (stale/replayed reveal). Abandon. |
| `storage_failure`  | 500  | `true`      | The preimage was valid but could not be persisted (transient DB error). Retry. |

Error responses never include the submitted preimage, the on-chain secret, or
the storage encryption key — only the `publicId` and a category description.
The typed error model lives in [`src/services/secret-errors.ts`](src/services/secret-errors.ts)
and is extensible: add a `SecretRevealError` subclass and the route layer maps
it automatically.

## Secure Logging

Preimages (pre-claim) are secret material. The hashlock is NOT secret and shouldn't be redacted.
Rule for contributors: **Never let a raw Error or request/response body reach a log or HTTP response outside the classified SecretRevealError path without passing through `sanitizeForLog()` first.**

## Operational Endpoint Access Control

The coordinator restricts access to privileged operational endpoints using bearer token authentication.

These endpoints require the request to present a valid bearer token in the `Authorization` header (`Authorization: Bearer <token>`). Tokens are loaded from the `COORDINATOR_OPERATOR_KEYS` environment variable.

| Endpoint | Method | Intended Caller | Required Env Var | 401 Meaning | 403 Meaning |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `/api/orders/:id/src-locked` | `POST` | Relayer / Resolver Infra | `COORDINATOR_OPERATOR_KEYS` | Missing or malformed `Authorization` header | Token is present but does not match any key in `COORDINATOR_OPERATOR_KEYS` |
| `/api/orders/:id/dst-locked` | `POST` | Relayer / Resolver Infra | `COORDINATOR_OPERATOR_KEYS` | Missing or malformed `Authorization` header | Token is present but does not match any key in `COORDINATOR_OPERATOR_KEYS` |
| `/metrics` | `GET` | Prometheus / Scraping Agent | `COORDINATOR_OPERATOR_KEYS` | Missing or malformed `Authorization` header | Token is present but does not match any key in `COORDINATOR_OPERATOR_KEYS` |

*Note: All public-facing endpoints (e.g. `/healthz`, `/readyz`, `/api/orders/announce`, and public order-read queries) do not require authorization. The privileged operational endpoints (`src-locked` and `dst-locked`) are intentionally not rate-limited to avoid throttling infrastructure under high load; if a rate limiter is introduced in the future, it must execute after the `requireRole` middleware to prevent unauthenticated requests from exhausting the operator's rate limit budget.*

## Quick start

```bash
cd coordinator
pnpm install
pnpm dev
```

By default the coordinator listens on `:3001` and writes to
`./wafflefinance.db`. Override with env vars (see `env.example`).

## Architecture

```
src/
├── index.ts                # 50-line bootstrap
├── config.ts               # zod-validated env config
├── logger.ts               # pino logger factory
├── server/
│   ├── app.ts              # Express app factory
│   └── routes/
│       ├── health.ts       # GET /health
│       ├── orders.ts       # POST /api/orders/announce, GET /api/orders/:id, ...
│       ├── secrets.ts      # POST /api/secrets/reveal, GET /api/secrets/:id
│       └── quotes.ts       # GET /api/quotes/eth-xlm
├── services/
│   ├── order-service.ts    # Order lifecycle + state machine guards
│   ├── secret-service.ts   # Preimage validation + storage
│   └── quote-service.ts    # CoinGecko price lookups (real, not mocked)
├── listeners/
│   ├── ethereum-listener.ts # viem event subscription
│   └── soroban-listener.ts  # Soroban getEvents polling
├── persistence/
│   ├── db.ts               # node:sqlite (Node 22.5+/24.x built-in)
│   ├── schema.sql          # idempotent schema
│   └── orders-repo.ts      # typed CRUD
└── state-machine/
    └── order-machine.ts    # legal transitions
```

This replaces the 3276-line monolithic `relayer/src/index.ts` from v1.

## Persistence

The coordinator stores order state in a local database. Two database engines are supported:

### SQLite (Local Development - Default)

We use Node's built-in `node:sqlite` driver — no native addons, no
build step. By default, the coordinator writes to `./wafflefinance.db` in the working directory.

```bash
pnpm dev
# Writes to ./wafflefinance.db (file:./wafflefinance.db)
```

### PostgreSQL (Production)

For production deployments, swap the database to Postgres by setting the
`DATABASE_URL` environment variable:

```bash
DATABASE_URL=postgresql://user:password@localhost:5432/wafflefinance pnpm start
```

The schema in `coordinator/migrations/` is applied automatically on startup.
All migrations are idempotent, so it's safe to run the coordinator against
an existing database.

## Tests

```bash
pnpm test
```

The test suite covers the order service state transitions, secret
validation (rejects preimages that don't hash to the stored hashlock),
and the schema bootstrapping on SQLite.

### PostgreSQL Compatibility Tests

The test suite includes comprehensive PostgreSQL compatibility tests that verify:
- SQLite-to-PostgreSQL SQL translation correctness
- Named parameter handling (`:name` syntax)
- Positional parameter handling (`?` placeholders) 
- `strftime` to `EXTRACT(EPOCH FROM NOW())` conversion
- All `OrdersRepository` operations work identically on both databases
- Database schema migrations

To run the PostgreSQL compatibility tests:

```bash
# Start a PostgreSQL test instance (requires Docker)
docker run -d --name postgres-test \
  -e POSTGRES_PASSWORD=test \
  -e POSTGRES_USER=test \
  -e POSTGRES_DB=waffle_test \
  -p 5432:5432 \
  postgres:15

# Run tests with PostgreSQL enabled
TEST_WITH_POSTGRES=true pnpm test

# Or run only the PostgreSQL compatibility tests
TEST_WITH_POSTGRES=true pnpm test db-postgres.test.ts

# Cleanup
docker stop postgres-test && docker rm postgres-test
```

The SQL translation unit tests always run (without requiring PostgreSQL),
while the full database integration tests require `TEST_WITH_POSTGRES=true`.

### Known Edge Cases — Postgres SQL Translation

The SQLite-to-Postgres translation layer (`db.ts:PostgresStatement`) uses
regex-based conversion, which has known limitations:

1. **Named params inside string literals**: `':named_param'` in SQL is still
   converted because the regex `:(\w+)` cannot distinguish SQL code from
   string contents. Use parameterized values instead of inline literals.

2. **`LIKE` case sensitivity**: SQLite's `LIKE` is case-insensitive for ASCII;
   Postgres `LIKE` is case-sensitive. Use `ILIKE` for case-insensitive
   matching, or `LOWER()` on both sides.

3. **Type coercion**: SQLite is flexible with type mixing (e.g., comparing
   `INTEGER` to `TEXT`). Postgres is strict. All current queries use
   consistent types, but custom queries should match column types exactly.

4. **`INTEGER` vs `BIGINT`**: SQLite `INTEGER` is 64-bit; Postgres `INTEGER`
   is 32-bit. Migration `006_stale_cleanup_postgres.sql` uses `BIGINT` for
   unix timestamps (`archived_at`). The other Postgres migrations use
   `BIGSERIAL` / `BIGINT` for id and timestamp columns respectively.

5. **`INSERT OR IGNORE`**: SQLite syntax; Postgres uses
   `INSERT ... ON CONFLICT DO NOTHING`. This is handled in the migration
   runner's inline SQL, not through `PostgresStatement`.

6. **Concurrent migration safety**: The Postgres migration runner uses
   `ON CONFLICT DO NOTHING` when recording applied migrations, which
   prevents duplicate records under concurrent coordinator starts.

### Testing with PostgreSQL

To test the coordinator against a PostgreSQL database:

```bash
# Start a Postgres container (requires Docker)
docker run -d \
  --name wafflefinance-postgres \
  -e POSTGRES_DB=wafflefinance \
  -e POSTGRES_PASSWORD=password \
  -p 5432:5432 \
  postgres:15

# Set DATABASE_URL and run the coordinator
DATABASE_URL=postgresql://postgres:password@localhost:5432/wafflefinance pnpm dev

# In another terminal, test an order creation
curl -X POST http://localhost:3001/api/orders/announce \
  -H "Content-Type: application/json" \
  -d '{
    "direction": "eth_to_xlm",
    "hashlock": "0x0000000000000000000000000000000000000000000000000000000000000001",
    "srcChain": "ethereum",
    "srcAddress": "0x1111111111111111111111111111111111111111",
    "srcAsset": "native",
    "srcAmount": "1000000000000000000",
    "srcSafetyDeposit": "1000000000000000",
    "dstChain": "stellar",
    "dstAddress": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB422",
    "dstAsset": "native",
    "dstAmount": "100000000"
  }'

# Cleanup
docker stop wafflefinance-postgres && docker rm wafflefinance-postgres
```

The schema migrations in `coordinator/migrations/` are applied automatically
on startup, making it easy to manage database versions.

### Migration Variants

Some migrations have Postgres-specific variants in `coordinator/migrations/`:

- `002_solana_support_postgres.sql` — uses `ALTER TABLE ... DROP/ADD CONSTRAINT`
  instead of SQLite's table-recreate approach.
- `006_stale_cleanup_postgres.sql` — uses `BIGINT` for the `archived_at`
  column instead of `INTEGER`, and `ADD COLUMN IF NOT EXISTS`.

The migration runner falls back to the SQLite variant if a Postgres-specific
file is not found, so adding a Postgres variant is always safe.
