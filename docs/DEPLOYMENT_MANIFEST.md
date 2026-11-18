# Deployment Manifest Ownership and Update Flow

> **Related docs:**
> [`scripts/validate-deployments.mjs`](../scripts/validate-deployments.mjs) ·
> [`docs/OPERATIONS.md`](OPERATIONS.md) ·
> [`docs/DRIFT_DETECTION_RUNBOOK.md`](DRIFT_DETECTION_RUNBOOK.md) ·
> [`docs/DEPLOYMENT_ROLLBACK_RUNBOOK.md`](DEPLOYMENT_ROLLBACK_RUNBOOK.md)

---

## 1. What `deployments.<network>.json` is

`deployments.testnet.json` (and its `mainnet` counterpart once created) is the
**canonical address record** for every on-chain contract in the repository.
It is the single source of truth that all other documents and services must
agree with:

| Consumer | How it uses the manifest |
|---|---|
| **README.md** (deployed-contracts table) | Human-readable address links — must match the manifest |
| **Coordinator** | Reads Ethereum + Stellar addresses at startup via env vars derived from the manifest |
| **Relayer** | Same: contract addresses are injected from the manifest via `@wafflefinance/config` |
| **Frontend** | Reads addresses from `VITE_*` env vars, which operators set from the manifest |
| **`scripts/validate-deployments.mjs`** | Programmatic cross-check: validates the manifest's own addresses against README |
| **`env.example`** | Shows which env vars must be set from the manifest values |

**Owner:** The engineer who runs the deployment script is responsible for
updating the manifest immediately after deployment and opening the resulting
PR before announcing the new addresses to the team.

---

## 2. How addresses are written

The Hardhat deploy script (`contracts/scripts/deploy.ts`) writes Ethereum
addresses automatically:

```bash
# Sepolia testnet
pnpm --filter @wafflefinance/contracts exec hardhat run scripts/deploy.ts --network sepolia
```

After the script exits, `deployments.testnet.json` at the repo root is
updated with the new `HTLCEscrow` and `ResolverRegistry` addresses plus the
deployer address and a `deployedAt` date.

Stellar / Soroban addresses are written by the Soroban deploy script
(`soroban/scripts/deploy.sh`) and must be copied into the `stellar.contracts`
block of the manifest manually by the deploying engineer, along with the
deploy transaction hashes.

---

## 3. What must change after a redeploy

When one or more contracts are redeployed, update **all** of the following
before the PR is merged:

| Document / file | Field(s) to update |
|---|---|
| `deployments.testnet.json` | `ethereum.contracts.*` and/or `stellar.contracts.*`, `deployedAt`, `deployer`, `deployTransactions` (Stellar) |
| `README.md` | Deployed-contracts table — addresses and Etherscan / Stellar explorer links |
| `env.example` | Any `*_CONTRACT_ADDRESS` example values that reference old addresses |
| `docs/OPERATIONS.md` | Address references in the deployment checklist, if any were hard-coded |
| `docs/DRIFT_DETECTION_RUNBOOK.md` | Known-good address snapshots used in drift checks |

Do **not** commit private keys, Stellar secret keys, or mnemonic phrases to
any of these files. Use placeholder notation like `<your-deployer-private-key>`
or omit the field.

---

## 4. Validation command

Run this after updating the manifest and before opening the PR:

```bash
pnpm validate:deployments
```

This executes `scripts/validate-deployments.mjs`, which:

1. Confirms the JSON structure matches the expected schema for the network.
2. Validates every Ethereum address against the `0x[40 hex chars]` format and
   rejects the zero address.
3. Validates every Stellar contract address against the `C[A-Z2-7]{55}` format.
4. Checks that every address in the manifest also appears in `README.md`
   (cross-reference check).
5. Validates transaction hashes, chain IDs, and URL fields.

A non-zero exit means the manifest or `README.md` is inconsistent and the PR
must not be merged.

---

## 5. Example manifest entry (fake addresses for illustration)

The addresses below are **not real deployed contracts**. They are included
only to show the expected format and field names.

```jsonc
{
  "network": "testnet",
  "ethereum": {
    "chainId": 11155111,
    "name": "Sepolia",
    "rpcUrl": "https://ethereum-sepolia-rpc.publicnode.com",
    "contracts": {
      "HTLCEscrow": "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA00",
      "ResolverRegistry": "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB00"
    },
    "deployedAt": "2026-01-01",
    "deployer": "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC00"
  },
  "stellar": {
    "passphrase": "Test SDF Network ; September 2015",
    "horizon": "https://horizon-testnet.stellar.org",
    "rpc": "https://soroban-testnet.stellar.org",
    "contracts": {
      "HTLC": "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      "ResolverRegistry": "CBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
    },
    "deployedAt": "2026-01-01",
    "deployer": "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "deployTransactions": {
      "HTLC": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "ResolverRegistry": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    }
  }
}
```

Real Ethereum addresses are 20 bytes (40 hex characters after `0x`). Real
Stellar contract addresses begin with `C` and are 56 Crockford base-32
characters. Neither fake example above matches those lengths intentionally.

---

## 6. Checklist for a manifest update PR

Before requesting review:

- `pnpm validate:deployments` exits 0
- `README.md` deployed-contracts table links match the manifest
- `env.example` placeholder comments reference the correct field names
- No private keys, Stellar secret keys, or seed phrases appear in the diff
- The commit message includes the deployment date and network
  (e.g. `chore: update testnet deployment addresses 2026-01-01`)

---

## 7. Where this fits in the release process

Full contract deployment steps (environment setup, RPC verification, signer
balance checks, post-deploy smoke tests) are in
[`docs/OPERATIONS.md`](OPERATIONS.md).

For coordinator and relayer service deployments (config changes, restart
verification, rollback triggers), see
[`docs/DEPLOYMENT_ROLLBACK_RUNBOOK.md`](DEPLOYMENT_ROLLBACK_RUNBOOK.md).

The drift detection runbook at
[`docs/DRIFT_DETECTION_RUNBOOK.md`](DRIFT_DETECTION_RUNBOOK.md) explains how
to catch address mismatches between the manifest, README, and running
services before they reach production.
