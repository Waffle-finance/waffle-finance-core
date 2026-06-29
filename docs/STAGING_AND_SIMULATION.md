# Staging and Simulation Environments Guide

This guide covers running the WaffleFinance stack in simulation (mock/local-only) and staging (testnet/real-contracts) modes using environment presets.

---

## 1. Simulation Mode

Simulation mode boots the entire stack—coordinator, relayer, resolver, and frontend—with simulated blockchain interactions. It does **not** connect to real network RPCs or require real wallet keys. It uses local SQLite instances and a pre-configured set of dummy keys.

### How to Run
From the repository root, run:
```bash
pnpm dev:simulation
```

### Configuration Preset
The configuration is loaded from `.env.simulation` at the root. Key preset highlights:
- `NETWORK_MODE=testnet` (forces SDK to map Sepolia + Stellar testnet configurations under the hood)
- `ENABLE_MOCK_MODE=true` (forces the relayer to mock block polling and transaction submissions)
- `DATABASE_URL=file:./wafflefinance_sim.db` (isolates order data from standard developer state)
- Pre-filled dummy developer reference keys (`RESOLVER_ETH_PRIVATE_KEY`, `RESOLVER_STELLAR_SECRET`, `RELAYER_PRIVATE_KEY`, etc.) allowing immediate startup.

### Flow testing
1. Open `http://localhost:5173` in your browser.
2. Select any route (e.g. `ETH → SOL` or `XLM → ETH`). Since Solana is on testnet simulation, it will show a warning banner indicating transactions are simulated.
3. Submit a transaction. The relayer will capture the announcement, register the order, and mock the finalization lifecycle locally without hitting actual RPC endpoints.

---

## 2. Staging Mode

Staging mode configures the stack to run against actual public testnets (Ethereum Sepolia, Stellar Testnet, and Solana Devnet) with isolated databases and dedicated staging credentials.

### How to Run
From the repository root, run:
```bash
pnpm dev:staging
```

### Configuration Preset
The configuration is loaded from `.env.staging` at the root. Key preset highlights:
- `NETWORK_MODE=testnet`
- `DATABASE_URL=file:./wafflefinance_staging.db` (isolates staging state)
- `ENABLE_MOCK_MODE=false` (runs real listeners and transaction submissions)
- Pre-filled contract addresses from `deployments.testnet.json`.

### Prerequisites for Staging
Before running staging, you must edit `.env.staging` at the root and provide valid testnet credentials:
- Set a valid Sepolia Ethereum RPC URL (`SEPOLIA_RPC_URL`).
- Provide actual test keys with testnet funds for the relayer (`RELAYER_PRIVATE_KEY`, `RELAYER_STELLAR_SECRET`, `RELAYER_STELLAR_PUBLIC`).

---

## 3. How It Works Under the Hood

### Custom Environment Loading
Our custom environment loader in `@wafflefinance/config` (`packages/config/src/node.ts`) checks the `ENV_FILE` environment variable:
- If `process.env.ENV_FILE` is defined, it maps its absolute path and loads configuration values from it instead of defaulting to `.env`.
- Our workspaces scripts set `ENV_FILE=$PWD/.env.simulation` or `ENV_FILE=$PWD/.env.staging` at execution time, which propagates down to all node processes.

### Frontend Integration
To avoid duplicating configurations in the frontend subpackage:
- We configured Vite (`frontend/vite.config.ts`) to direct `envDir` to the root workspace directory.
- This allows both the Vite compiler (`loadEnv`) and the runtime frontend dApp (`import.meta.env`) to read from the exact same unified environment presets (`.env.simulation` and `.env.staging`).
