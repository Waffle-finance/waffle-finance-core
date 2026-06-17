<p align="center">
  <img src="frontend/public/images/wafflefinance-logo.svg" alt="WaffleFinance" width="120" />
</p>

<h1 align="center">WaffleFinance</h1>

<p align="center">
  <strong>Non-custodial cross-chain atomic swap — Ethereum · Stellar · Solana</strong><br/>
  No validator set. No attester. No admin escape hatch.
</p>

<p align="center">
  <a href="https://sepolia.etherscan.io/address/0xb352339BEb146f2699d28D736700B953988bB178">Sepolia Contract</a> ·
  <a href="https://stellar.expert/explorer/testnet/contract/CDIKSJKVMXKGBRD3BBEBMF7Q4GQJ52ECU6R6G5HEKXKXVGGWK2CTA6JK">Stellar Testnet</a> ·
  <a href="https://github.com/Waffle-finance/waffle-finance-core/actions">CI</a>
</p>

---

## What it is

WaffleFinance locks funds in Hash Time-Lock Contracts (HTLCs) on each chain simultaneously. Settlement is a `sha256` preimage reveal — not a multisig, not an attester signature.

If anything fails — coordinator down, resolver offline, RPC unavailable, frontend unreachable — locked funds either settle to the beneficiary or refund permissionlessly to the user. There is no state where funds are stuck under operator control.

> **Status:** Live on testnet (Sepolia + Stellar testnet). Solana support is live in simulation mode — full settlement activates once the Anchor HTLC program is deployed on devnet. Mainnet gated until independent audit (Q1 2027).

---

## Supported chains

| Chain | Asset | Status |
|---|---|---|
| Ethereum (Sepolia) | ETH | ✅ Live |
| Stellar | XLM | ✅ Live |
| Solana | SOL | 🟡 Simulation mode (Anchor program pending deployment) |

---

## How it works

```
User locks ETH (24h timelock)       →    Resolver locks XLM/SOL (12h timelock)
                                                       ↓
                                          User claims XLM/SOL, revealing secret
                                                       ↓
Resolver claims ETH using secret    ←    Secret is now public on-chain
```

Both legs settle, or both legs refund. The 12h vs 24h timelock gap ensures the resolver's destination refund always expires before the user's source — so neither party can ever be stuck.

---

## Trust model

Funds move under exactly two conditions:

1. A caller submits a preimage where `sha256(preimage) == hashlock` before `timelock` — funds go to `beneficiary`
2. `timelock` has expired — anyone calls `refundOrder` and funds return to `refundAddress` (always the original user)

**Robust native-ETH payout.** A `beneficiary` / `refundAddress` that is a smart contract may revert on receipt or exhaust the bounded gas stipend. Rather than letting that block a settlement backed by a valid preimage or an expired timelock, `HTLCEscrow` attempts a direct push and, if it fails, **credits the amount to the recipient's pull-payment balance** instead of reverting. The claim/refund still finalises (the preimage is revealed on-chain either way), and the recipient — and *only* that recipient — recovers the funds permissionlessly via `withdraw()`. This adds no custodial surface: credited funds are never pooled or operator-movable, and `withdraw()` can only return a caller's own balance, never locked order funds.

The coordinator is a metadata service that never signs transactions touching user funds. Resolvers stake into `ResolverRegistry`; misbehaviour is slashable on-chain.

| Attack vector | Validator-set bridge | WaffleFinance |
|---|---|---|
| Compromise off-chain signers | **Funds lost** | No effect — no signers |
| Compromise first-party attester | **Funds lost** | No effect — no attesters |
| Break sha256 | Safe | Funds at risk (breaks all of crypto) |
| Compromise chain consensus | Funds at risk | Funds at risk (inherited) |

---

## Deployed contracts (testnet)

| Contract | Chain | Address |
|---|---|---|
| `HTLCEscrow` | Sepolia | [`0xb352339BEb…988bB178`](https://sepolia.etherscan.io/address/0xb352339BEb146f2699d28D736700B953988bB178) |
| `ResolverRegistry` | Sepolia | [`0x7D9ce70Aa4…1B6D1D99`](https://sepolia.etherscan.io/address/0x7D9ce70Aa40E144E8BbE266a0dc3b3F91B6D1D99) |
| `wafflefinance-htlc` | Stellar testnet | [`CDIKSJKV…CTA6JK`](https://stellar.expert/explorer/testnet/contract/CDIKSJKVMXKGBRD3BBEBMF7Q4GQJ52ECU6R6G5HEKXKXVGGWK2CTA6JK) |
| `wafflefinance-resolver-registry` | Stellar testnet | [`CBSR7Z4M…Z4WGF`](https://stellar.expert/explorer/testnet/contract/CBSR7Z4MHLPMLFFM5K3PK3YLZAVCOMJ4KPVRWO4VPL3FF64MSTIZ4WGF) |
| Anchor HTLC | Solana devnet | Pending deployment |

---

## Refund layers

Four independent recovery mechanisms — each a backstop for the previous one.

| Layer | Trigger | Latency |
|---|---|---|
| On-chain HTLC refund | `timelock` expires; anyone calls `refundOrder` | ≤ 24h |
| Frontend refund dialog | "Refund" button in transaction history | User-driven |
| Automatic refund | Destination leg fails mid-request; relayer refunds inline | < 30s |
| Background watchdog | Swap pending > 5 min; background scanner fires | < 6 min |

Even with the coordinator, relayer, and frontend all offline, layer 1 alone is sufficient — the user calls `refundOrder` directly from any wallet.

---

## Repository layout

```
contracts/          Solidity — HTLCEscrow + ResolverRegistry (Ethereum)
soroban/            Rust — Soroban HTLC + ResolverRegistry (Stellar)

packages/
  sdk/              @wafflefinance/sdk — shared TS types, asset mappings,
                    state machine, Solana + Stellar + Ethereum HTLC clients

coordinator/        Order book service (SQLite/Postgres, REST, never holds keys)
  src/
    listeners/      Ethereum + Soroban + Solana event listeners
    services/       OrderService, SecretService, QuoteService
    persistence/    Schema, migrations, repository
    server/         Express routes (/orders, /quotes, /secrets, /metrics)
    state-machine/  Shared order state machine
  migrations/
    001_initial.sql     Base schema
    002_solana_support.sql  Adds solana to Chain/Direction constraints

relayer/            Bridge relay service
  src/
    listeners/      Block polling, contract event poller
    services/       Gas tracker, refund watchdog, XLM refund, recovery

resolver/           Open-source resolver runner + Docker image
frontend/           React + Vite dApp (Ethereum · Stellar · Solana)
e2e/                Cross-chain differential test harness
```

---

## Quick start

Requirements: Node 22.5+, pnpm 9+, Rust + `stellar-cli`, Foundry.

```bash
git clone https://github.com/Waffle-finance/waffle-finance-core
cd waffle-finance-core
pnpm install
cp env.example .env          # fill in RPC URLs and private keys
```

```bash
# Build shared SDK
pnpm --filter @wafflefinance/sdk build

# Compile + test Solidity contracts
pnpm --filter @wafflefinance/contracts exec hardhat test

# Test Soroban contracts
cd soroban && cargo test --release && cd ..

# Start coordinator
pnpm --filter @wafflefinance/coordinator dev

# Start frontend
pnpm --filter @wafflefinance/frontend dev
```

---

## Wallet support

| Wallet | Chain | Hook |
|---|---|---|
| MetaMask | Ethereum | `window.ethereum` |
| Freighter | Stellar | `useFreighter()` |
| Phantom | Solana | `useSolanaWallet()` |

All three wallets can be connected simultaneously from the wallet menu. The bridge form automatically selects the correct wallets based on the chosen route.

---

## Solana integration

The Solana leg is fully wired end-to-end:

- **SDK** — `SolanaHTLCClient` in `packages/sdk/src/solana/` handles `createOrder`, `claimOrder`, `refundOrder`. Runs in simulation mode until the Anchor program is deployed.
- **Coordinator** — `SolanaListener` polls RPC for HTLC program logs and forwards `OrderCreated`, `OrderClaimed`, `OrderRefunded` events into `OrderService`.
- **DB** — `Chain` type includes `"solana"`, `Direction` includes `"eth_to_sol"` and `"sol_to_eth"`. Migration `002_solana_support.sql` upgrades existing databases.
- **Frontend** — `useSolanaWallet()` handles Phantom connection. Route selector in `BridgeForm` exposes all four routes. Solana swaps are announced to the coordinator immediately; full settlement goes live once the Anchor program is deployed on devnet.
- **Asset mappings** — `resolveSolanaAsset()` and `resolveEthereumTokenFromSolana()` in `packages/sdk/src/assets/` cover testnet (devnet USDC) and mainnet (native SOL).

To activate full Solana settlement, deploy the Anchor HTLC program to devnet and set:

```env
SOLANA_RPC_URL=https://api.devnet.solana.com
SOLANA_HTLC_PROGRAM=<your_program_id>
```

---

## Running a resolver

Anyone who stakes into `ResolverRegistry` can run a resolver.

```bash
docker run ghcr.io/wafflefinance/resolver:latest register
docker run ghcr.io/wafflefinance/resolver:latest run
```

See [`resolver/`](resolver/) for environment variable reference.

---

## Deploying contracts

```bash
cp env.example .env

# Sepolia testnet
pnpm --filter @wafflefinance/contracts exec hardhat run scripts/deploy.ts --network sepolia

# Mainnet (after audit)
pnpm --filter @wafflefinance/contracts exec hardhat run scripts/deploy.ts --network mainnet
```

Deployment addresses are written to `deployments.<network>.json` and picked up automatically by the coordinator and frontend.

---

## Test coverage

| Layer | Tests | Framework |
|---|---|---|
| Soroban HTLC | 10 | Rust `#[contracttest]` |
| Soroban ResolverRegistry | 6 | Rust `#[contracttest]` |
| EVM HTLCEscrow | 15 | Hardhat + Chai |
| EVM ResolverRegistry | 6 | Hardhat + Chai |
| SDK | 8 | Vitest |
| Coordinator | 4 | Vitest |

All suites gate every pull request via GitHub Actions.

---

## Key environment variables

| Variable | Used by | Description |
|---|---|---|
| `ETHEREUM_RPC_URL` | relayer, coordinator | Sepolia or mainnet RPC |
| `RELAYER_PRIVATE_KEY` | relayer | ETH signing key |
| `RELAYER_STELLAR_SECRET` | relayer | Stellar signing key |
| `SOLANA_RPC_URL` | coordinator | Solana RPC endpoint |
| `SOLANA_HTLC_PROGRAM` | coordinator | Anchor program ID (leave blank for simulation mode) |
| `NETWORK_MODE` | relayer, frontend | `testnet` or `mainnet` |
| `VITE_MAINNET_ENABLED` | frontend | Set `true` post-audit to unlock mainnet UI |

Full reference in [`env.example`](env.example).

---

## License

MIT. See [`LICENSE`](LICENSE).
