# @wafflefinance/resolver

Reference resolver implementation for WaffleFinance cross-chain atomic swaps. Allows anyone to stake and become a resolver to earn fees.

## What this service does

- Listens for announced swap orders from the coordinator
- Fills orders by locking assets on the destination chain
- Reveals preimages to complete swaps and claim fees
- Manages resolver stake and registration with on-chain registry

## What this service does NOT do

- Hold user funds (funds are locked in HTLC contracts only)
- Have any privileged access to contracts
- Modify or override on-chain HTLC logic

## Quick start

### Prerequisites

1. Stake assets in the on-chain ResolverRegistry
2. Configure required environment variables

### Running the resolver

```bash
# From repository root
pnpm --filter @wafflefinance/resolver dev

# Or from resolver directory
cd resolver
pnpm install
pnpm dev
```

### Docker

```bash
# Register resolver
docker run ghcr.io/wafflefinance/resolver:latest register

# Run resolver
docker run ghcr.io/wafflefinance/resolver:latest run
```

## Architecture

```
src/
├── index.ts                # Service entry point
├── config.ts               # Environment configuration
├── logger.ts               # Logging setup
├── health.ts               # Health check endpoints
├── retry.ts                # Retry utilities
├── supervisor.ts           # Process supervisor
├── validation.ts           # Input validation
├── commands/
│   ├── register.ts         # Resolver registration command
│   └── run.ts              # Run resolver service command
└── listeners/
    ├── ethereum.ts         # Ethereum event listener
    └── soroban.ts          # Stellar Soroban event listener
```

## Configuration

Requires environment variables (see repository root `env.example`):

- `RESOLVER_ETH_PRIVATE_KEY`: Ethereum private key
- `RESOLVER_STELLAR_SECRET`: Stellar secret key
- `COORDINATOR_URL`: Coordinator API base URL
- `NETWORK_MODE`: `testnet` or `mainnet`

## Tests

```bash
# Run all tests
pnpm --filter @wafflefinance/resolver test

# Watch mode
pnpm --filter @wafflefinance/resolver test --watch
```
