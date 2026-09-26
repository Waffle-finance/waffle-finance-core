# E2E Devnet Setup Guide

> Issue #480 — comprehensive cross-chain differential E2E test suite with real devnet support.

This guide describes how to configure and run the live-devnet E2E tests against
real Sepolia, Stellar testnet, and Solana devnet endpoints. The simulator tests
(`cross-chain.test.ts`, `solana-settlement.test.ts`) run on every PR with no
configuration required. This doc covers the **devnet tests only**.

---

## Table of contents

- [Prerequisites](#prerequisites)
- [Environment variables](#environment-variables)
- [Funded test accounts](#funded-test-accounts)
- [Contract addresses](#contract-addresses)
- [Running the tests](#running-the-tests)
- [Expected runtime and cost](#expected-runtime-and-cost)
- [Troubleshooting](#troubleshooting)
- [CI integration](#ci-integration)

---

## Prerequisites

| Tool | Version | Purpose |
|------|---------|---------|
| Node.js | ≥ 20 | Test runner |
| pnpm | ≥ 9 | Package manager |
| Funded Sepolia wallet | — | EVM devnet tests |
| Funded Stellar testnet account | — | Soroban devnet tests |
| Funded Solana devnet keypair | — | Solana devnet tests |

You do **not** need to install Anchor, Foundry, or Hardhat to run the E2E tests.
The `@solana/web3.js`, `viem`, and `@stellar/stellar-sdk` packages are already
listed as devDependencies in `e2e/package.json`.

---

## Environment variables

All variables are optional. Tests for a chain are **automatically skipped** when
its required variable is absent. The global guard variable `RUN_DEVNET_E2E`
must always be set to opt in.

### Global

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RUN_DEVNET_E2E` | **YES** | `false` | Set to `"true"` to enable all devnet tests |
| `DEVNET_TIMELOCK_TESTS` | no | `false` | Set to `"true"` to enable tests that wait 300 s for timelock expiry |

### EVM (Sepolia)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DEVNET_EVM_PRIVATE_KEY` | **YES** | — | Hex-encoded 32-byte signer private key (`0x...`) |
| `DEVNET_EVM_RPC_URL` | no | `https://ethereum-sepolia-rpc.publicnode.com` | Sepolia HTTP RPC endpoint |
| `DEVNET_EVM_CONTRACT_ADDRESS` | no | `0xb352339BEb146f2699d28D736700B953988bB178` | Deployed `HTLCEscrow` address |
| `DEVNET_EVM_BENEFICIARY` | no | signer address | Claim recipient |
| `DEVNET_EVM_TOKEN` | no | `0x000...` (native ETH) | ERC-20 token address |
| `DEVNET_EVM_AMOUNT` | no | `1000000000000000` (0.001 ETH) | Wei amount per order |

### Soroban (Stellar testnet)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DEVNET_STELLAR_SECRET_KEY` | **YES** | — | Stellar secret key (`S...`) |
| `DEVNET_STELLAR_RPC_URL` | no | `https://soroban-testnet.stellar.org` | Soroban RPC endpoint |
| `DEVNET_STELLAR_CONTRACT_ID` | no | `CDIKSJKVMXKGBRD3BBEBMF7Q4GQJ52ECU6R6G5HEKXKXVGGWK2CTA6JK` | HTLC contract ID |
| `DEVNET_STELLAR_PASSPHRASE` | no | `Test SDF Network ; September 2015` | Network passphrase |
| `DEVNET_STELLAR_TOKEN` | no | — | SAC contract ID (uses native XLM when absent) |

### Solana (devnet)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DEVNET_SOLANA_SECRET_KEY` | **YES** | — | Base-58 encoded keypair secret |
| `DEVNET_SOLANA_PROGRAM_ID` | **YES** | — | Deployed Anchor HTLC program ID (base-58) |
| `DEVNET_SOLANA_RPC_URL` | no | `https://api.devnet.solana.com` | Solana cluster URL |
| `DEVNET_SOLANA_AMOUNT` | no | `1000000` (0.001 SOL) | Lamports per order |

---

## Funded test accounts

Each chain requires a funded testnet account to pay transaction fees and to
provide the lock amount for each test order.

### Sepolia (ETH)

1. Generate a new private key: `node -e "console.log(require('viem').generatePrivateKey())"`
2. Derive the address: `node -e "const {privateKeyToAccount} = require('viem/accounts'); console.log(privateKeyToAccount('<key>').address)"`
3. Fund via the [Sepolia PoW Faucet](https://sepolia-faucet.pk910.de/) or [Alchemy Sepolia Faucet](https://sepoliafaucet.com/).
4. Ensure the account holds at least **0.05 ETH** — the devnet suite runs ~10 tests × 0.001 ETH + gas.

### Stellar testnet (XLM)

1. Generate a keypair: `stellar keys generate devnet-test --network testnet`
2. Fund via [Stellar Friendbot](https://friendbot.stellar.org/?addr=<public_key>) or the [Stellar Laboratory](https://laboratory.stellar.org/#account-creator?network=test).
3. Ensure the account holds at least **100 XLM** (each `create_order` costs 1 XLM + fee).

### Solana devnet (SOL)

1. Generate a keypair: `solana-keygen new --outfile devnet-keypair.json --no-bip39-passphrase`
2. Convert to base-58 secret: `solana-keygen show-private-key devnet-keypair.json`
3. Airdrop SOL: `solana airdrop 2 <pubkey> --url devnet`
4. Ensure the account holds at least **0.1 SOL** (each `createOrder` costs ~0.001 SOL for rent + fee).

> **Tip:** Airdrop limits on Solana devnet are 2 SOL/request. Repeat the command if you need more.

---

## Contract addresses

The default addresses in the environment-variable table above point to the
latest testnet deployments recorded in `deployments.testnet.json` at the
repository root. If you deploy new contracts (e.g. after a Soroban upgrade),
override them with the `DEVNET_*_CONTRACT_ADDRESS` / `DEVNET_*_CONTRACT_ID`
variables.

```jsonc
// deployments.testnet.json — reference
{
  "ethereum": {
    "sepolia": {
      "htlcEscrow": "0xb352339BEb146f2699d28D736700B953988bB178"
    }
  },
  "stellar": {
    "testnet": {
      "htlc": "CDIKSJKVMXKGBRD3BBEBMF7Q4GQJ52ECU6R6G5HEKXKXVGGWK2CTA6JK"
    }
  }
}
```

---

## Running the tests

### Quick start (EVM + Soroban only)

```powershell
# Set required secrets
$env:RUN_DEVNET_E2E="true"
$env:DEVNET_EVM_PRIVATE_KEY="0x<your-key>"
$env:DEVNET_STELLAR_SECRET_KEY="S<your-key>"

# Run from the e2e package
cd e2e
pnpm test
```

### All three chains

```powershell
$env:RUN_DEVNET_E2E="true"
$env:DEVNET_EVM_PRIVATE_KEY="0x<your-key>"
$env:DEVNET_STELLAR_SECRET_KEY="S<your-key>"
$env:DEVNET_SOLANA_SECRET_KEY="<base58-secret>"
$env:DEVNET_SOLANA_PROGRAM_ID="<program-id>"

cd e2e
pnpm test
```

### Including timelock-expiry tests (adds ~10 min)

```powershell
$env:DEVNET_TIMELOCK_TESTS="true"
# ... other vars ...
pnpm test
```

### Simulator tests only (no devnet, fast path for PR CI)

```powershell
cd e2e
pnpm test
# RUN_DEVNET_E2E is not set → devnet tests are skipped automatically
```

### Run a specific test file

```powershell
cd e2e
npx vitest run devnet.test.ts
npx vitest run devnet-edge-cases.test.ts
npx vitest run cross-chain.test.ts
```

---

## Expected runtime and cost

| Test suite | Chains required | Approx. runtime | Approx. cost |
|------------|----------------|-----------------|--------------|
| `cross-chain.test.ts` (simulators) | none | < 5 s | free |
| `solana-settlement.test.ts` (simulators) | none | < 5 s | free |
| `devnet.test.ts` (EVM only) | Sepolia | 3–5 min | ~0.005 ETH |
| `devnet.test.ts` (Soroban only) | Stellar testnet | 3–5 min | ~20 XLM |
| `devnet.test.ts` (Solana only) | Solana devnet | 3–5 min | ~0.01 SOL |
| `devnet.test.ts` (all chains) | all three | 5–10 min | all of above |
| `devnet-edge-cases.test.ts` (all) | all three | 8–15 min | ~3× devnet.test.ts |
| `devnet-edge-cases.test.ts` (timelock tests) | all three | +10 min | ~1× more |

> **Note:** Testnet RPC endpoints are public and shared. High latency (5–30 s
> per transaction) is normal. The test timeouts are set conservatively (60–180 s
> per test) to account for this.

---

## Troubleshooting

### "Transaction failed: insufficient funds"

Your testnet account does not hold enough of the chain's native token. See
[Funded test accounts](#funded-test-accounts) for faucet links.

### "Error: could not connect to RPC" / "fetch failed"

The public RPC endpoints listed in the defaults are sometimes rate-limited or
temporarily unavailable. Override with a dedicated endpoint:

- **Sepolia:** [Infura](https://infura.io), [Alchemy](https://alchemy.com), or [QuickNode](https://quicknode.com) all offer free Sepolia tiers.
- **Soroban:** The `https://soroban-testnet.stellar.org` endpoint is operated by SDF and is generally reliable.
- **Solana devnet:** `https://api.devnet.solana.com` is the public endpoint. For higher throughput use a dedicated provider.

### "OrderCreated event not found in receipt"

The EVM test signer may not be the `sender` the `HTLCEscrow` contract emits events
for, or the contract ABI used by `EvmHtlcDevnet` is out of sync with the deployed
contract. Verify `DEVNET_EVM_CONTRACT_ADDRESS` points to the correct deployment
and compare the `OrderCreated` event signature in `devnet-sim.ts` with the contract's
ABI in `contracts/contracts/HTLCEscrow.sol`.

### "Soroban transaction failed: ERROR"

Common causes:
1. **Insufficient XLM** — fund the account via Friendbot.
2. **Expired ledger** — Soroban transactions have a 30-second `setTimeout` window. If your machine clock is skewed, `prepareTransaction` may fail. Run `w32tm /resync` (Windows) or `ntpdate` (Linux/macOS).
3. **Wrong contract ID** — verify `DEVNET_STELLAR_CONTRACT_ID` against `deployments.testnet.json`.

### "Anchor account not found for id=1"

The Solana HTLC program's global state PDA does not exist. The Anchor program
must be deployed and initialized before running devnet tests. Verify
`DEVNET_SOLANA_PROGRAM_ID` and confirm the program is live on devnet:

```sh
solana account <PROGRAM_ID> --url devnet
```

### Tests are very slow (> 5 min per test)

This is normal for heavily loaded devnets. If tests are timing out (not just slow),
increase the vitest timeout in `vitest.config.ts` or run with a private RPC endpoint.

### "skipped — set RUN_DEVNET_E2E=true to enable"

Expected when `RUN_DEVNET_E2E` is not set. This is the correct behaviour for
PR CI. Set the variable and re-run to enable devnet tests.

---

## CI integration

The devnet tests are integrated into GitHub Actions as a **nightly scheduled
job** so they never block PR CI.

### Nightly schedule (`.github/workflows/frontend.yml` or a dedicated workflow)

```yaml
# .github/workflows/e2e-devnet.yml (example — add to your workflows directory)
name: E2E Devnet
on:
  schedule:
    - cron: "0 2 * * *"   # 02:00 UTC nightly
  workflow_dispatch:        # manual trigger

jobs:
  devnet-e2e:
    runs-on: ubuntu-latest
    timeout-minutes: 60
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v3
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: "20", cache: "pnpm" }
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @wafflefinance/sdk build
      - name: Run devnet E2E tests
        working-directory: e2e
        env:
          RUN_DEVNET_E2E: "true"
          DEVNET_EVM_PRIVATE_KEY: ${{ secrets.DEVNET_EVM_PRIVATE_KEY }}
          DEVNET_STELLAR_SECRET_KEY: ${{ secrets.DEVNET_STELLAR_SECRET_KEY }}
          DEVNET_SOLANA_SECRET_KEY: ${{ secrets.DEVNET_SOLANA_SECRET_KEY }}
          DEVNET_SOLANA_PROGRAM_ID: ${{ secrets.DEVNET_SOLANA_PROGRAM_ID }}
        run: pnpm test
```

### PR CI (fast path — simulators only)

The `frontend.yml` and `soroban-contracts.yml` workflows do **not** set
`RUN_DEVNET_E2E`, so simulator tests run on every PR and devnet tests are
skipped automatically. No changes to existing workflows are required.

### Secrets required in GitHub repository settings

| Secret name | Description |
|-------------|-------------|
| `DEVNET_EVM_PRIVATE_KEY` | Funded Sepolia signer key |
| `DEVNET_STELLAR_SECRET_KEY` | Funded Stellar testnet secret |
| `DEVNET_SOLANA_SECRET_KEY` | Funded Solana devnet keypair secret |
| `DEVNET_SOLANA_PROGRAM_ID` | Deployed Anchor HTLC program ID |
