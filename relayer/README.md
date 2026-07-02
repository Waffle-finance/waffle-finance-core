# @wafflefinance/relayer

Relayer service for WaffleFinance cross-chain atomic swaps. Monitors blockchain events, manages refunds, and ensures swaps complete or revert safely.

## What this service does

- Monitors Ethereum and Stellar HTLC contract events
- Automatically processes refunds when swaps fail or time out
- Maintains gas tracking for efficient transaction execution
- Provides health and metrics endpoints for monitoring

## What this service does NOT do

- Hold user funds
- Sign transactions on behalf of users
- Modify or override on-chain HTLC logic

## Quick start

```bash
# From repository root
pnpm --filter @wafflefinance/relayer dev

# Or from relayer directory
cd relayer
pnpm install
pnpm dev
```

## Architecture

```
src/
├── index.ts                # Service bootstrap
├── metrics.ts              # Prometheus metrics
├── listeners/
│   ├── ethereum-listener.ts    # Ethereum event listener
│   ├── contract-event-poller.ts # Polling for contract events
│   └── eth-incoming-monitor.ts # Monitors incoming ETH swaps
├── services/
│   ├── gas-tracker.ts      # Gas price tracking
│   ├── refund-watchdog.ts  # Automatic refund processing
│   ├── xlm-refund.ts       # Stellar XLM refund handling
│   └── recovery-service.ts # Failed swap recovery
└── utils/
    ├── adaptive-poll.ts    # Dynamic polling interval
    ├── cursor-store.ts     # Event cursor persistence
    ├── event-history.ts    # Event history management
    └── sanitize-for-log.ts # Log sanitization
```

## Configuration

Requires environment variables (see repository root `env.example`):

- `SEPOLIA_RPC_URL` / `ETHEREUM_RPC_URL`: Ethereum JSON-RPC endpoint
- `RELAYER_PRIVATE_KEY`: Ethereum private key for gas payments
- `RELAYER_STELLAR_SECRET`: Stellar secret key
- `NETWORK_MODE`: `testnet` or `mainnet`

## Tests

```bash
# Run all tests
pnpm --filter @wafflefinance/relayer test

# Watch mode
pnpm --filter @wafflefinance/relayer test --watch
```

## Logging Conventions

The relayer includes structured identifiers in its logs for easier tracking and correlation:

- `orderId=` refers to the **on-chain order ID** (e.g. the bigint from the HTLC Bridge contract events).
- `orderHash=` refers to the **hashlock** (or 1inch Fusion hash). 

**Note:** `orderId` and `orderHash` represent distinct values and are not interchangeable.

### Known Gaps (Follow-ups)
1. **Full Correlation:** Full cross-service correlation with the coordinator's `publicId` is not currently implemented in these logs.
2. **Winston Migration:** A migration from `console.log`/`console.error` to structured JSON logging via Winston is planned but not yet implemented.
