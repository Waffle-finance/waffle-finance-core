# @wafflefinance/frontend

React + Vite frontend interface for WaffleFinance cross-chain atomic swaps.

## What this app does

- Connects user wallets (MetaMask for Ethereum, Freighter for Stellar, Phantom for Solana)
- Lets users create and execute cross-chain swaps
- Shows transaction history and status updates
- Provides fallback refund/claim dialogs for stuck swaps

## Quick start

```bash
# From repository root
pnpm --filter @wafflefinance/frontend dev

# Or from frontend directory
cd frontend
pnpm install
pnpm dev
```

Open [http://localhost:5173](http://localhost:5173) in your browser.

## Architecture

```
src/
├── App.tsx                 # Root component
├── main.tsx                # App entry point
├── index.css               # Global styles
├── components/
│   ├── BridgeForm.tsx       # Main swap form
│   ├── DarkVeil.tsx         # Modal backdrop
│   ├── NetworkMismatchBanner.tsx
│   ├── MainnetVersionBanner.tsx
│   ├── TestnetFaucet.tsx
│   ├── TransactionHistory.tsx
│   └── index.ts
├── config/                 # App config
├── features/               # Feature modules
│   ├── bridge/
│   │   └── BridgeFormContainer.tsx
│   ├── claim/
│   │   └── ClaimFallbackDialog.tsx
│   └── refund/
│       └── RefundDialog.tsx
├── hooks/                  # Custom React hooks
│   ├── useEthereumWallet.ts
│   ├── useFreighter.ts
│   ├── useSolanaWallet.ts
│   └── useTransactionHistoryCache.ts
├── lib/
│   ├── sdk-context.ts
│   ├── fetchWithRetry.ts
│   ├── parseHtlcReceipt.ts
│   ├── sanitizeAmountInput.ts
│   └── useNetworkMode.ts
└── services/
    └── oneInch.ts
```

## Configuration

Requires environment variables (see repository root `env.example`):

- `VITE_API_BASE_URL`: Coordinator API base URL (default: `http://localhost:3001`)
- `VITE_NETWORK_MODE`: `testnet` or `mainnet`
- `VITE_MAINNET_ENABLED`: Set to `true` to enable mainnet UI

## Tests

```bash
# Run all tests
pnpm --filter @wafflefinance/frontend test

# Watch mode
pnpm --filter @wafflefinance/frontend test --watch
```

## Soroban Smart Contract Integration

When integrating with the Soroban HTLC contract, please refer to the formal IDL documentation and account schema reference located in the main `soroban` workspace:

[Soroban HTLC IDL Reference](../../soroban/docs/HTLC_IDL.md)

This IDL is critical for understanding the structure of `Order` data, order statuses, and entrypoints.
