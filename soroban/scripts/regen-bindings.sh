#!/usr/bin/env bash
# Regenerates the TypeScript bindings for the deployed WaffleFinance Soroban
# HTLC contract.
#
# The script is read-only with respect to the network: it asks the Stellar CLI
# for the contract interface and writes TypeScript locally. It never builds,
# installs, deploys, or invokes a contract, so it is safe to run against
# testnet or mainnet from any checkout.
#
# Usage:
#   ./scripts/regen-bindings.sh [contract_id] [output_dir]
#   ./scripts/regen-bindings.sh --spec <spec.json> [output_dir]
#
# Inputs (positional arguments take precedence over the environment):
#   contract_id    Deployed HTLC contract ID (default: $SOROBAN_HTLC_TESTNET)
#   output_dir     Bindings output directory
#                  (default: $SOROBAN_BINDINGS_OUTPUT, then
#                  ../packages/sdk/src/soroban/htlc-bindings)
#
# Offline / spec mode:
#   --spec <spec.json>   Generate bindings from a committed contract spec
#                        (JSON) instead of querying a live network. No
#                        deployment credentials or RPC access are required.
#                        This is the mode used by the drift check
#                        (scripts/check-soroban-bindings-drift.mjs).
#
# Environment:
#   SOROBAN_HTLC_TESTNET     HTLC contract ID, read from the repo-root .env
#                            when it is not already exported.
#   SOROBAN_NETWORK          testnet (default) or mainnet
#   SOROBAN_RPC_URL          Optional custom Soroban RPC endpoint. When set,
#                            it is used instead of the CLI's --network preset.
#   SOROBAN_BINDINGS_OUTPUT  Optional override for the output directory.
#   SOROBAN_CONTRACT_SPEC    Optional path to a contract spec JSON used when
#                            --spec is not passed on the command line.
#
# Requirements:
#   - stellar-cli on PATH (`cargo install --locked stellar-cli`)
#   - A deployed HTLC contract ID for the selected network, or a contract
#     spec JSON when running in --spec mode
#
# Regeneration procedure (maintainers):
#   1. After changing the contract interface, rebuild the wasm and export its
#      spec (e.g. `stellar contract bindings typescript --wasm <wasm> ...` or
#      `stellar contract spec ...`) into a committed spec file.
#   2. Run `./scripts/regen-bindings.sh --spec <spec.json>` to rewrite the
#      committed bindings under packages/sdk/src/soroban/htlc-bindings.
#   3. Run `node scripts/check-soroban-bindings-drift.mjs` (also wired into
#      preflight/CI) to confirm the committed bindings match the spec.
#   4. Commit the spec and the regenerated bindings together.
#
# Exit codes:
#   0  bindings regenerated
#   1  a prerequisite is missing or the generator failed
=======

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SOROBAN_DIR=$(dirname "$SCRIPT_DIR")
REPO_ROOT=$(dirname "$SOROBAN_DIR")

# Load the repo-root .env without overriding values the caller already
# exported. Inline comments and surrounding whitespace are stripped so entries
# copied from env.example resolve to usable values.
ENV_FILE="$REPO_ROOT/.env"
if [[ -f "$ENV_FILE" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
        [[ "$line" =~ ^[[:space:]]*# ]] && continue
        [[ "$line" != *=* ]] && continue

        key=${line%%=*}
        value=${line#*=}
        key=${key//[[:space:]]/}
        value=${value%%#*}
        value=${value#"${value%%[![:space:]]*}"}
        value=${value%"${value##*[![:space:]]}"}

        [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue
        if [[ -z "${!key:-}" ]]; then
            export "$key=$value"
        fi
    done < "$ENV_FILE"
fi

NETWORK=${SOROBAN_NETWORK:-testnet}
SPEC_FILE=""
POSITIONAL=()

# Parse arguments: --spec <file> selects offline spec-based generation; all
# other arguments are treated as the legacy positional contract_id/output_dir.
while [[ $# -gt 0 ]]; do
    case "$1" in
        --spec)
            [[ $# -ge 2 ]] || { echo "ERROR: --spec requires a file argument" >&2; exit 1; }
            SPEC_FILE=$2
            shift 2
            ;;
        --spec=*)
            SPEC_FILE=${1#--spec=}
            shift
            ;;
        --)
            shift
            POSITIONAL+=("$@")
            break
            ;;
        *)
            POSITIONAL+=("$1")
            shift
            ;;
    esac
done

if [[ -z "$SPEC_FILE" && -n "${SOROBAN_CONTRACT_SPEC:-}" ]]; then
    SPEC_FILE=$SOROBAN_CONTRACT_SPEC
fi

CONTRACT_ID=${POSITIONAL[0]:-${SOROBAN_HTLC_TESTNET:-}}
OUTPUT_DIR=${POSITIONAL[1]:-${SOROBAN_BINDINGS_OUTPUT:-$REPO_ROOT/packages/sdk/src/soroban/htlc-bindings}}

fail() {
    echo "ERROR: $*" >&2
    exit 1
}

# ── Preflight ────────────────────────────────────────────────────────────────
# Every check below runs before the generator is invoked, so a missing
# prerequisite never leaves partially rewritten bindings in the working tree.

command -v stellar >/dev/null 2>&1 || fail \
    "stellar CLI not found on PATH. Install it with 'cargo install --locked stellar-cli' and retry."

case "$NETWORK" in
    testnet) NETWORK_PASSPHRASE="Test SDF Network ; September 2015" ;;
    mainnet) NETWORK_PASSPHRASE="Public Global Stellar Network ; September 2015" ;;
    *) fail "SOROBAN_NETWORK must be 'testnet' or 'mainnet' (got '$NETWORK')." ;;
esac

if [[ -n "$SPEC_FILE" ]]; then
    [[ -f "$SPEC_FILE" ]] || fail "Contract spec file '$SPEC_FILE' does not exist."
else
    if [[ -z "$CONTRACT_ID" ]]; then
        fail "No HTLC contract ID supplied. Pass it as the first argument, use --spec <file>, or set SOROBAN_HTLC_TESTNET in .env."
    fi

    if [[ ! "$CONTRACT_ID" =~ ^C[A-Z2-7]{55}$ ]]; then
        fail "'$CONTRACT_ID' is not a valid Soroban contract ID (expected a 56-character C... address)."
    fi
fi

OUTPUT_PARENT=$(dirname "$OUTPUT_DIR")
[[ -d "$OUTPUT_PARENT" ]] || fail \
    "Output parent directory '$OUTPUT_PARENT' does not exist. Run this script from a full repository checkout."

# ── Generate ─────────────────────────────────────────────────────────────────
if [[ -n "$SPEC_FILE" ]]; then
    # Offline mode: generate from a committed contract spec. No network access
    # or deployment credentials are required.
    ARGS=(contract bindings typescript \
        --contract-id "${CONTRACT_ID:-$(basename "$SPEC_FILE" .json)}" \
        --output-dir "$OUTPUT_DIR" \
        --spec "$SPEC_FILE")

    echo "Regenerating TypeScript bindings (offline spec mode)"
    echo "  spec:   $SPEC_FILE"
    echo "  output: $OUTPUT_DIR"

    stellar "${ARGS[@]}"
else
    ARGS=(contract bindings typescript \
        --contract-id "$CONTRACT_ID" \
        --output-dir "$OUTPUT_DIR")

    if [[ -n "${SOROBAN_RPC_URL:-}" ]]; then
        ARGS+=(--rpc-url "$SOROBAN_RPC_URL" --network-passphrase "$NETWORK_PASSPHRASE")
    else
        ARGS+=(--network "$NETWORK")
    fi

    echo "Regenerating TypeScript bindings"
    echo "  network:  $NETWORK"
    echo "  contract: $CONTRACT_ID"
    echo "  output:   $OUTPUT_DIR"

    stellar "${ARGS[@]}"
fi

echo "Bindings regenerated in $OUTPUT_DIR"
