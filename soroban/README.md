# WaffleFinance Soroban contracts

This workspace contains the Stellar side of the WaffleFinance bridge. There
are two contracts:

| Crate | Purpose |
|---|---|
| `wafflefinance-htlc` | Per-order hash + time-lock contract (mirrors the Ethereum `HTLCEscrow`). |
| `wafflefinance-resolver-registry` | Open stake/slash registry for community resolvers. |

The HTLC enforces that locked funds can only move when one of two
conditions is satisfied:

1. The beneficiary reveals a preimage whose sha256 matches the stored
   `hashlock`, before the `timelock` expires.
2. The `timelock` expires and **anyone** calls `refund_order`, which
   returns the locked amount to the original `refund_address`.

No address — including the contract admin — can spend locked funds
without satisfying one of those conditions. This is the property that
v1 review feedback identified as missing in the legacy design.

## Toolchain

Install the Stellar Soroban toolchain (Rust + the `stellar` CLI):

```bash
# Rust + wasm target
rustup target add wasm32-unknown-unknown

# Stellar CLI (Soroban)
cargo install --locked stellar-cli
```

The contracts target `soroban-sdk = "22.x"` and Rust edition 2021.

## Build

```bash
cd soroban
stellar contract build
# or, with vanilla cargo:
cargo build --release --target wasm32-unknown-unknown
```

WASM artefacts land in
`target/wasm32-unknown-unknown/release/*.wasm`.

## Test

```bash
cd soroban
cargo test
```

Tests use the Soroban `testutils` Env and cover:

- happy-path claim
- permissionless refund after timelock
- claim with wrong preimage
- claim after expiry
- double claim
- refund after claim
- timelock outside allowed bounds
- safety deposit minimum
- admin role transfer
- double initialisation

## Deploy (testnet)

```bash
# Generate or import a deployer identity
stellar keys generate --global --network testnet deployer
stellar keys fund deployer --network testnet

# Build (if not already)
stellar contract build

# Install the wasm
stellar contract install \
    --network testnet \
    --source deployer \
    --wasm target/wasm32-unknown-unknown/release/wafflefinance_htlc.wasm

# Deploy + initialise
HTLC_ID=$(stellar contract deploy \
    --network testnet \
    --source deployer \
    --wasm target/wasm32-unknown-unknown/release/wafflefinance_htlc.wasm)

stellar contract invoke \
    --network testnet \
    --source deployer \
    --id $HTLC_ID \
    -- initialize \
    --admin $(stellar keys address deployer) \
    --min_safety_deposit 1000000
```

Repeat for `wafflefinance_resolver_registry.wasm`. Record the contract IDs
in `.env` as `SOROBAN_HTLC_TESTNET` and
`SOROBAN_RESOLVER_REGISTRY_TESTNET`.

## TS bindings

After deploy, regenerate the TypeScript bindings that the coordinator
and frontend consume from `@wafflefinance/sdk`:

```bash
stellar contract bindings typescript \
    --network testnet \
    --contract-id $HTLC_ID \
    --output-dir ../packages/sdk/src/soroban/htlc-bindings
```

## Trust model summary

| Actor | What they can do | What they cannot do |
|---|---|---|
| Coordinator | Observe events, relay secrets, run an optional reference resolver | Move locked funds; sign on behalf of users |
| Admin | Update min safety deposit, set resolver registry address, slash registered resolvers | Move locked HTLC funds; bypass timelock; alter an existing order |
| Resolver | Stake, register, fill orders permissionlessly | Steal stake of other resolvers; claim without a valid preimage |
| User | Lock funds, claim with preimage, refund after timeout | Claim without a valid preimage; refund before timeout |

## IDL and Account Schema Reference

For full details on contract entrypoints, data types, and account storage schemas, please refer to the formal IDL documentation at [HTLC IDL Reference](./docs/HTLC_IDL.md). This documentation is essential for SDK and frontend integration.
