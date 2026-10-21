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
# Rust + wasm targets
rustup target add wasm32-unknown-unknown   # vanilla cargo fallback
rustup target add wasm32v1-none            # target used by current stellar-cli

# Stellar CLI (Soroban) — scripts/deploy.sh requires stellar-cli >= 22.8
cargo install --locked stellar-cli
```

The contracts target `soroban-sdk = "22.x"` and Rust edition 2021.

## Build

```bash
cd soroban

# Preferred: stellar CLI, per package (mirrors scripts/deploy.sh)
stellar contract build --package wafflefinance-htlc
stellar contract build --package wafflefinance-resolver_registry

# Or the whole workspace at once
stellar contract build

# Vanilla cargo fallback (requires the wasm32-unknown-unknown target above)
cargo build --release --target wasm32-unknown-unknown
```

### Output path

Do not hard-code the artefact directory — it depends on how the contract was
built. Current `stellar contract build` releases land in
`target/wasm32v1-none/release/`, while the vanilla cargo fallback writes to
`target/wasm32-unknown-unknown/release/`. Ask the CLI for the directory it
actually used:

```bash
TARGET_DIR=$(stellar contract build --print-build-dir)
ls "$TARGET_DIR"/wafflefinance_*.wasm
```

This is exactly how `scripts/deploy.sh` locates the artefacts (falling back
to `target/wasm32v1-none/release` when `--print-build-dir` is unavailable),
so resolving the path this way always matches what deployment tooling
consumes: `wafflefinance_htlc.wasm` and
`wafflefinance_resolver_registry.wasm`.

### Verify the artefact

Record a SHA-256 checksum before deploying or sharing a build — the same
convention used by the release verification scripts
(`scripts/verify-release-locally.sh`):

```bash
TARGET_DIR=$(stellar contract build --print-build-dir)
sha256sum "$TARGET_DIR"/wafflefinance_htlc.wasm \
          "$TARGET_DIR"/wafflefinance_resolver_registry.wasm
```

Cross-check with the upload step: `stellar contract install` prints the
Wasm hash of the file it installed, which you can compare against a later
install or deploy of the same file:

```bash
stellar contract install --network testnet --source deployer \
    --wasm "$TARGET_DIR/wafflefinance_htlc.wasm"
# prints the wasm hash — record it alongside the checksum above
```

The checksum and Wasm hash prove that the file you tested is the file you
deploy. They do **not** imply byte-identical builds across different
toolchain versions or hosts — only compare checksums between artefacts built
with the same `stellar` CLI and Rust versions.

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

# Build (if not already) and resolve the artefact directory
stellar contract build
TARGET_DIR=$(stellar contract build --print-build-dir)

# Install the wasm
stellar contract install \
    --network testnet \
    --source deployer \
    --wasm "$TARGET_DIR/wafflefinance_htlc.wasm"

# Deploy (the constructor configures the contract atomically, so
# there is no separate initialize step to front-run)
HTLC_ID=$(stellar contract deploy \
    --network testnet \
    --source deployer \
    --wasm "$TARGET_DIR/wafflefinance_htlc.wasm" \
    -- \
    --admin $(stellar keys address deployer) \
    --min_safety_deposit 1000000)
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

The "cannot move locked HTLC funds" constraint on Admin and Coordinator is
enforced by the **Soroban host VM**, not merely by contract logic.  The host
evaluates the SHA-256 preimage check and the timelock before allowing any
transfer.  This is the Soroban equivalent of the EVM's immutable bytecode
guarantee: a compromised off-chain service cannot force a transfer no matter
what transaction it submits.

## Consensus model and finality

Stellar uses the **Stellar Consensus Protocol (SCP)**, a federated Byzantine
Agreement (FBA) variant.  Ledgers close with immediate finality — there are
no block reorgs or probabilistic confirmation windows.

**Operational implications:**

- The coordinator's `SorobanListener` does **not** wait for N confirmations
  before treating an event as final.  A single ledger close is sufficient.
- Out-of-order event delivery is a **node-level inconsistency** (stale RPC
  cursor, buggy relay), not a chain phenomenon.  The listener's Guard 1
  (skip events with `ledger < lastProcessedLedger`) handles this case.
- If a Soroban RPC node appears connected but its ledger sequence has stopped
  advancing, the coordinator's staleness metrics
  (`coordinator_soroban_listener_staleness_state`) will classify it as
  `degraded` or `stale` before users experience failures.

This is a meaningful difference from the Ethereum listener, which must
reconcile reorgs, block hash mismatches, and confirmation-depth policies.
Do not apply Ethereum-style "wait for N confirmations" rules to Soroban
event processing.

## IDL and Account Schema Reference

For full details on contract entrypoints, data types, and account storage schemas, please refer to the formal IDL documentation at [HTLC IDL Reference](./docs/HTLC_IDL.md). This documentation is essential for SDK and frontend integration.
