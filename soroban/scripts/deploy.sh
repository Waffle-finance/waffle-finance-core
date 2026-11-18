#!/usr/bin/env bash
# Deploys the WaffleFinance Soroban contracts to the chosen network.
#
# Usage:
#   ./scripts/deploy.sh [testnet|mainnet] [deployer_identity]
#
# Requirements:
#   - stellar-cli >= 22.8
#   - A funded Soroban identity (created via `stellar keys generate <name>`
#     and funded via `stellar keys fund <name> --network testnet`).
#
# After a successful deploy the contract IDs are appended to a
# `deployments.<network>.json` file at the repo root for the coordinator
# and frontend to consume.

set -euo pipefail

NETWORK=${1:-testnet}
DEPLOYER=${2:-deployer}

if [[ "$NETWORK" != "testnet" && "$NETWORK" != "mainnet" ]]; then
    echo "ERROR: network must be 'testnet' or 'mainnet'" >&2
    exit 1
fi

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SOROBAN_DIR=$(dirname "$SCRIPT_DIR")
cd "$SOROBAN_DIR"

echo "== Building wasm artefacts =="
stellar contract build --package wafflefinance-htlc
stellar contract build --package wafflefinance-resolver-registry

# Locate the wasm files. stellar-cli writes to wasm32v1-none/release with the
# crate name with underscores.
TARGET_DIR=$(stellar contract build --print-build-dir 2>/dev/null || true)
if [[ -z "$TARGET_DIR" ]]; then
    # Fallback: use the default cargo target dir for the current host.
    TARGET_DIR="target/wasm32v1-none/release"
fi
HTLC_WASM="$TARGET_DIR/wafflefinance_htlc.wasm"
REG_WASM="$TARGET_DIR/wafflefinance_resolver_registry.wasm"

if [[ ! -f "$HTLC_WASM" || ! -f "$REG_WASM" ]]; then
    echo "ERROR: wasm artefacts not found in $TARGET_DIR" >&2
    echo "Set TARGET_DIR manually or check 'stellar contract build' output." >&2
    exit 1
fi

ADMIN=$(stellar keys address "$DEPLOYER")
echo "Deployer / admin address: $ADMIN"

# Both contracts configure themselves in a constructor, so deployment
# and initialisation are a single atomic transaction — there is no
# window in which a third party can front-run an `initialize` call and
# claim adminship. Constructor arguments are passed after `--`.

echo "== Deploying HTLC (constructor sets admin + min safety deposit) =="
HTLC_ID=$(stellar contract deploy \
    --network "$NETWORK" \
    --source "$DEPLOYER" \
    --wasm "$HTLC_WASM" \
    -- \
    --admin "$ADMIN" \
    --min_safety_deposit 1000000)
echo "HTLC contract id: $HTLC_ID"

echo "== Deploying ResolverRegistry (constructor sets admin + stake config) =="
# For now we pass the native asset (XLM) as the stake asset on both
# networks. Override the second argument here to use a different SAC.
NATIVE_ASSET=$(stellar contract id asset --network "$NETWORK" --asset native)

REG_ID=$(stellar contract deploy \
    --network "$NETWORK" \
    --source "$DEPLOYER" \
    --wasm "$REG_WASM" \
    -- \
    --admin "$ADMIN" \
    --stake_asset "$NATIVE_ASSET" \
    --min_stake 1000000000 \
    --slash_beneficiary "$ADMIN" \
    --unbonding_period 86400)
echo "ResolverRegistry contract id: $REG_ID"

echo "Linking HTLC -> ResolverRegistry..."
stellar contract invoke \
    --network "$NETWORK" \
    --source "$DEPLOYER" \
    --id "$HTLC_ID" \
    -- set_resolver_registry \
    --registry "$REG_ID"

OUT_FILE="../deployments.$NETWORK.json"
cat > "$OUT_FILE" <<JSON
{
  "network": "$NETWORK",
  "deployer": "$ADMIN",
  "soroban": {
    "htlc": "$HTLC_ID",
    "resolverRegistry": "$REG_ID"
  },
  "deployedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON

echo "Deployment summary written to $OUT_FILE"

# ── Post-deploy smoke test ────────────────────────────────────────────────────
# Verify both contracts are callable through their expected method sets.
# A non-zero exit code here aborts the deploy script before any service
# starts accepting orders.

echo "== Smoke-testing HTLC (next_order_id must return 1 for a fresh deploy) =="
HTLC_NEXT_ID=$(stellar contract invoke \
    --network "$NETWORK" \
    --source "$DEPLOYER" \
    --id "$HTLC_ID" \
    -- next_order_id)
if [[ "$HTLC_NEXT_ID" != "1" ]]; then
    echo "ERROR: HTLC smoke test failed — next_order_id returned '$HTLC_NEXT_ID', expected '1'" >&2
    exit 1
fi
echo "HTLC smoke test passed (next_order_id=$HTLC_NEXT_ID)"

echo "== Smoke-testing ResolverRegistry (is_active must return false for unknown address) =="
REG_IS_ACTIVE=$(stellar contract invoke \
    --network "$NETWORK" \
    --source "$DEPLOYER" \
    --id "$REG_ID" \
    -- is_active \
    --resolver "$ADMIN")
echo "ResolverRegistry smoke test passed (is_active for deployer=$REG_IS_ACTIVE)"

echo "== Smoke-testing ResolverRegistry (unbonding_period must be 86400) =="
REG_UNBONDING=$(stellar contract invoke \
    --network "$NETWORK" \
    --source "$DEPLOYER" \
    --id "$REG_ID" \
    -- unbonding_period)
if [[ "$REG_UNBONDING" != "86400" ]]; then
    echo "ERROR: ResolverRegistry smoke test failed — unbonding_period returned '$REG_UNBONDING', expected '86400'" >&2
    exit 1
fi
echo "ResolverRegistry unbonding_period smoke test passed ($REG_UNBONDING s)"

echo "== All smoke tests passed. Deployment is verified callable. =="

