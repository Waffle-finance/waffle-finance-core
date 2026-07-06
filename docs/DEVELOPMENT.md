# Development Guide

This guide covers every path from a fresh checkout to a running local stack — via dev container (recommended) or a native host setup.

---

## Table of contents

- [Stack overview](#stack-overview)
- [Option A: Dev container (recommended)](#option-a-dev-container-recommended)
- [Option B: Native host setup](#option-b-native-host-setup)
- [Environment variables](#environment-variables)
- [Package reference](#package-reference)
  - [SDK (`packages/sdk`)](#sdk-packagessdk)
  - [Contracts — Solidity (`contracts/`)](#contracts--solidity-contracts)
  - [Contracts — Soroban / Stellar (`soroban/`)](#contracts--soroban--stellar-soroban)
  - [Coordinator (`coordinator/`)](#coordinator-coordinator)
  - [Relayer (`relayer/`)](#relayer-relayer)
  - [Resolver (`resolver/`)](#resolver-resolver)
  - [Frontend (`frontend/`)](#frontend-frontend)
  - [E2E (`e2e/`)](#e2e-e2e)
- [Running the full local stack](#running-the-full-local-stack)
- [Troubleshooting](#troubleshooting)
- [Dependency updates](./DEPENDENCY_UPDATES.md) — automated Renovate workflow, review guardrails, and how to pause it for sensitive packages.

---

## Stack overview

| Layer | Language / Runtime | Toolchain |
|---|---|---|
| Ethereum contracts | Solidity 0.8.24 | Hardhat + Foundry |
| Stellar contracts | Rust (Soroban SDK 22.x) | Cargo + stellar-cli |
| SDK | TypeScript | pnpm + Vitest |
| Coordinator | Node 22+ / TypeScript | pnpm + Vitest |
| Relayer | Node 22+ / TypeScript | pnpm + Vitest |
| Resolver | Node 22+ / TypeScript | pnpm + Vitest |
| Frontend | React + Vite / TypeScript | pnpm + Vitest |

---

## Option A: Dev container (recommended)

The dev container gives every contributor an identical environment — Node 22, pnpm 8, Rust stable, stellar-cli, and Foundry — with no manual toolchain installation.

**Prerequisites:**
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) (or Docker Engine on Linux)
- [VS Code](https://code.visualstudio.com/) with the [Dev Containers extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers)

**Steps:**

```bash
git clone https://github.com/Waffle-finance/waffle-finance-core
cd waffle-finance-core
cp env.example .env        # fill in secrets before opening the container
code .                     # VS Code will prompt "Reopen in Container"
```

VS Code rebuilds the image on first open (~5 min) and runs `.devcontainer/setup.sh`, which:
1. Installs pnpm 8.15.0, Foundry, and stellar-cli.
2. Runs `pnpm install` across all workspace packages.
3. Builds the shared SDK.
4. Copies `env.example` → `.env` if no `.env` exists.

Ports `3001` (coordinator) and `5173` (frontend Vite dev server) are forwarded to localhost automatically.

**Without VS Code:** use the Dev Containers CLI or Docker Compose directly:

```bash
# Install the CLI once
npm install -g @devcontainers/cli

# Build and start the container
devcontainer up --workspace-folder .

# Open a shell
devcontainer exec --workspace-folder . bash
```

---

## Option B: Native host setup

### Required tools

| Tool | Version | Install |
|---|---|---|
| Node.js | ≥ 22.0.0 (22.x LTS recommended) | [nvm](https://github.com/nvm-sh/nvm) or [nodejs.org](https://nodejs.org) |
| pnpm | 8.15.0 | `npm install -g pnpm@8.15.0` |
| Rust | stable | [rustup.rs](https://rustup.rs) |
| wasm32 target | — | `rustup target add wasm32-unknown-unknown` |
| stellar-cli | latest | `cargo install --locked stellar-cli --features opt` |
| Foundry | latest | `curl -L https://foundry.paradigm.xyz \| bash && foundryup` |

> **Node version manager:** the repo ships an `.nvmrc`. Run `nvm use` in the repo root to switch to the correct Node version automatically.

### Install and bootstrap

```bash
git clone https://github.com/Waffle-finance/waffle-finance-core
cd waffle-finance-core
pnpm install                       # installs all workspace packages
pnpm --filter @wafflefinance/sdk build  # compile the shared SDK first
cp env.example .env                # fill in secrets — see Environment variables below
```

---

## Environment variables

Copy `env.example` to `.env` and supply values for the services you plan to run. You do not need every variable for local development — only the ones consumed by the services you start.

| Variable | Required for | Description |
|---|---|---|
| `SEPOLIA_RPC_URL` | coordinator, relayer | Sepolia JSON-RPC (Infura / Alchemy recommended) |
| `INFURA_API_KEY` | coordinator, relayer | Alternative to explicit RPC URLs |
| `ETHEREUM_RPC_URL` | coordinator, relayer | Mainnet RPC (only needed for mainnet mode) |
| `STELLAR_HORIZON_URL` | coordinator, relayer | Horizon endpoint; auto-selected if blank |
| `SOROBAN_RPC_URL` | coordinator | Soroban RPC (required after contract deploy) |
| `RESOLVER_ETH_PRIVATE_KEY` | coordinator (resolver mode) | ETH key for the reference resolver |
| `RESOLVER_STELLAR_SECRET` | coordinator (resolver mode) | Stellar secret for the reference resolver |
| `DATABASE_URL` | coordinator | `file:./wafflefinance.db` (SQLite) or Postgres URL |
| `COORDINATOR_PORT` | coordinator | Default `3001` |
| `VITE_API_BASE_URL` | frontend | Default `http://localhost:3001` |
| `VITE_NETWORK_MODE` | frontend | `testnet` or `mainnet` |
| `NETWORK_MODE` | relayer, frontend | `testnet` or `mainnet` |

Full reference in [`env.example`](../env.example).

---

## Package reference

### SDK (`packages/sdk`)

Shared TypeScript types, asset mappings, HTLC state machine, and chain clients (Ethereum, Stellar, Solana). All other packages depend on this; build it first.

```bash
# Build (required before starting other services)
pnpm --filter @wafflefinance/sdk build

# Watch mode (useful when editing the SDK alongside other services)
pnpm --filter @wafflefinance/sdk build --watch

# Tests
pnpm --filter @wafflefinance/sdk test

# Type-check only
pnpm --filter @wafflefinance/sdk exec tsc --noEmit
```

---

### Contracts — Solidity (`contracts/`)

Ethereum `HTLCEscrow` and `ResolverRegistry` — Hardhat project with Foundry for fuzz tests.

```bash
# Compile
pnpm --filter @wafflefinance/contracts compile
# or from contracts/:
npx hardhat compile

# Run all Hardhat tests
pnpm --filter @wafflefinance/contracts exec hardhat test

# Run specific test file
pnpm --filter @wafflefinance/contracts exec hardhat test test/HTLCEscrow.test.ts

# Foundry fuzz tests (from contracts/)
cd contracts
forge test

# Coverage report
pnpm --filter @wafflefinance/contracts coverage

# Deploy to Sepolia (needs SEPOLIA_RPC_URL + deployer key in .env)
pnpm --filter @wafflefinance/contracts deploy:sepolia

# Lint Solidity
pnpm --filter @wafflefinance/contracts lint
```

---

### Contracts — Soroban / Stellar (`soroban/`)

Rust crates targeting `wasm32-unknown-unknown`. Requires Rust stable + the `wasm32` target + stellar-cli.

```bash
cd soroban

# Build WASM artifacts
stellar contract build
# alternative:
cargo build --release --target wasm32-unknown-unknown

# Run unit tests (no WASM target needed)
cargo test

# Run tests with verbose output
cargo test -- --nocapture

# Deploy the HTLC to Stellar testnet
stellar keys generate --global --network testnet deployer
stellar keys fund deployer --network testnet
stellar contract build

HTLC_ID=$(stellar contract deploy \
  --network testnet \
  --source deployer \
  --wasm target/wasm32-unknown-unknown/release/wafflefinance_htlc.wasm)

stellar contract invoke \
  --network testnet \
  --source deployer \
  --id "$HTLC_ID" \
  -- initialize \
  --admin "$(stellar keys address deployer)" \
  --min_safety_deposit 1000000

# After deploy: regenerate TypeScript bindings
stellar contract bindings typescript \
  --network testnet \
  --contract-id "$HTLC_ID" \
  --output-dir ../packages/sdk/src/soroban/htlc-bindings
```

Record the deployed contract IDs in `.env` as `SOROBAN_HTLC_TESTNET` and `SOROBAN_RESOLVER_REGISTRY_TESTNET`.

---

### Coordinator (`coordinator/`)

Order book service (SQLite/Postgres, REST API). Listens on `:3001` by default.

```bash
# Dev (tsx watch — restarts on file changes)
pnpm --filter @wafflefinance/coordinator dev

# Production build + start
pnpm --filter @wafflefinance/coordinator build
pnpm --filter @wafflefinance/coordinator start

# Tests
pnpm --filter @wafflefinance/coordinator test

# PostgreSQL integration tests (requires Docker)
docker run -d --name postgres-test \
  -e POSTGRES_PASSWORD=test \
  -e POSTGRES_USER=test \
  -e POSTGRES_DB=waffle_test \
  -p 5432:5432 \
  postgres:15
TEST_WITH_POSTGRES=true pnpm --filter @wafflefinance/coordinator test
docker stop postgres-test && docker rm postgres-test

# Health check
curl http://localhost:3001/health

# Seed demo data for local development
pnpm --filter @wafflefinance/coordinator seed-demo
```

The coordinator auto-applies schema migrations on startup. SQLite (`file:./wafflefinance.db`) requires no external database.

---

### Relayer (`relayer/`)

Blockchain event relay and refund watchdog. Depends on the coordinator being reachable.

```bash
# Dev
pnpm --filter @wafflefinance/relayer dev

# Production
pnpm --filter @wafflefinance/relayer build
pnpm --filter @wafflefinance/relayer start

# Tests
pnpm --filter @wafflefinance/relayer test
```

---

### Resolver (`resolver/`)

Reference resolver implementation. Requires an ETH private key and Stellar secret staked in `ResolverRegistry`.

```bash
# Dev
pnpm --filter @wafflefinance/resolver dev

# Production (or via Docker)
docker run ghcr.io/wafflefinance/resolver:latest register
docker run ghcr.io/wafflefinance/resolver:latest run

# Tests
pnpm --filter @wafflefinance/resolver test
```

---

### Frontend (`frontend/`)

React + Vite dApp. Connects to the coordinator at `VITE_API_BASE_URL` (default `http://localhost:3001`).

```bash
# Dev server (hot reload)
pnpm --filter @wafflefinance/frontend dev
# opens at http://localhost:5173

# Build for production
pnpm --filter @wafflefinance/frontend build

# Preview production build locally
pnpm --filter @wafflefinance/frontend preview

# Tests
pnpm --filter @wafflefinance/frontend test

# Type-check
pnpm --filter @wafflefinance/frontend exec tsc --noEmit
```

---

### E2E (`e2e/`)

Cross-chain differential test harness.

```bash
pnpm --filter @wafflefinance/e2e test
# or from the root:
pnpm test:e2e
```

---

## Running the full local stack

Open four terminals (or use `tmux` / a process manager):

```bash
# Terminal 1 — coordinator
pnpm coordinator:dev

# Terminal 2 — relayer
pnpm relayer:dev

# Terminal 3 — frontend
pnpm frontend:dev

# Terminal 4 (optional) — resolver
pnpm --filter @wafflefinance/resolver dev
```

Once all services are up, open http://localhost:5173 to use the bridge UI.

**Workspace-root shortcuts** (from `package.json`):

| Command | What it runs |
|---|---|
| `pnpm dev` | `dev` script in every package |
| `pnpm build` | `build` in every package |
| `pnpm test` | `test` in every package |
| `pnpm coordinator:dev` | Coordinator only |
| `pnpm relayer:dev` | Relayer only |
| `pnpm frontend:dev` | Frontend only |
| `pnpm contracts:compile` | Hardhat compile |
| `pnpm health:check` | `curl localhost:3001/health` |

---

## Troubleshooting

### `pnpm install` fails with peer dependency errors

The monorepo targets pnpm 8.15.0. Mismatched versions can cause spurious peer warnings.

```bash
npm install -g pnpm@8.15.0
pnpm install
```

### Node version mismatch (`node:sqlite` not found)

The coordinator uses the built-in `node:sqlite` module, available from Node 22.5+. Verify:

```bash
node --version   # must be ≥ 22.5.0
```

If you're using nvm, run `nvm use` in the repo root — the `.nvmrc` pins the correct version.

### `stellar` command not found

stellar-cli is installed via Cargo. Ensure `~/.cargo/bin` is on your `PATH`:

```bash
export PATH="$HOME/.cargo/bin:$PATH"
stellar --version
```

### `forge` or `cast` not found

Foundry binaries land in `~/.foundry/bin`. Run `foundryup` after adding the directory to `PATH`:

```bash
export PATH="$HOME/.foundry/bin:$PATH"
foundryup
forge --version
```

### Rust build errors — missing `wasm32-unknown-unknown` target

```bash
rustup target add wasm32-unknown-unknown
```

### Coordinator starts but events aren't being processed

Chain listeners start lazily on the first swap order, not at boot. Send a `POST /api/wake` or announce an order to trigger listener initialisation.

### `VITE_API_BASE_URL` not set — frontend shows "network error"

The frontend reads `VITE_API_BASE_URL` from `.env`. Add it or run with the default:

```bash
VITE_API_BASE_URL=http://localhost:3001 pnpm frontend:dev
```

### PostgreSQL coordinator: `relation "orders" does not exist`

Migrations run automatically on startup. If you see this error, check that `DATABASE_URL` points to the correct database and that the coordinator process has write access.

### Dev container: `.env` not mounted

The devcontainer config tries to bind-mount `.env` from your host. If the file does not exist when the container starts, Docker skips the mount silently. Create `.env` before rebuilding the container:

```bash
cp env.example .env
# Rebuild: VS Code > Dev Containers: Rebuild Container
```

### Slow `cargo build` on first run

Soroban SDK dependencies are large. Cargo's download + compile pass typically takes 3–5 minutes on first build; subsequent builds use the incremental cache. The dev container pre-warms this cache during image build.

---

## Known gaps and planned improvements

See [`docs/TECHNICAL_DEBT.md`](TECHNICAL_DEBT.md) for the full service-level technical debt register, including architectural gaps, known limitations, and the priority order for future work.
