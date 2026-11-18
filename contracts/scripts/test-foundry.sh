#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# scripts/test-foundry.sh
#
# Convenience wrapper around `forge test` for the HTLCEscrow Foundry suite.
# Runs unit tests, fuzz tests, invariant tests, and gas benchmarks in sequence,
# reporting a combined pass/fail exit code suitable for CI gating.
#
# Usage:
#   ./scripts/test-foundry.sh              # run everything
#   ./scripts/test-foundry.sh --unit       # unit + fuzz only
#   ./scripts/test-foundry.sh --invariant  # invariant tests only
#   ./scripts/test-foundry.sh --gas        # gas benchmarks only
#   ./scripts/test-foundry.sh --security   # security tests only
#
# Environment overrides:
#   FOUNDRY_FUZZ_RUNS=<n>           override fuzz run count (default: foundry.toml)
#   FOUNDRY_INVARIANT_RUNS=<n>      override invariant run count
#   FOUNDRY_INVARIANT_DEPTH=<n>     override invariant call depth
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONTRACTS_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Change to the contracts directory so forge picks up foundry.toml.
cd "${CONTRACTS_DIR}"

# ── Build environment overrides ─────────────────────────────────────────────
FORGE_EXTRA_ARGS=()
if [[ -n "${FOUNDRY_FUZZ_RUNS:-}" ]]; then
  FORGE_EXTRA_ARGS+=("--fuzz-runs" "${FOUNDRY_FUZZ_RUNS}")
fi
if [[ -n "${FOUNDRY_INVARIANT_RUNS:-}" ]]; then
  FORGE_EXTRA_ARGS+=("--invariant-runs" "${FOUNDRY_INVARIANT_RUNS}")
fi
if [[ -n "${FOUNDRY_INVARIANT_DEPTH:-}" ]]; then
  FORGE_EXTRA_ARGS+=("--invariant-depth" "${FOUNDRY_INVARIANT_DEPTH}")
fi

MODE="${1:-}"

run_forge() {
  local label="$1"; shift
  echo ""
  echo "════════════════════════════════════════════════════════════════════"
  echo "  ${label}"
  echo "════════════════════════════════════════════════════════════════════"
  forge test "$@" "${FORGE_EXTRA_ARGS[@]}" --color
}

case "${MODE}" in
  --unit)
    run_forge "Unit + Fuzz Tests" \
      --match-path "test/foundry/HTLCEscrow.t.sol" -v
    ;;
  --invariant)
    run_forge "Invariant Tests (stateful fuzz campaign)" \
      --match-contract "InvariantHTLCEscrowTest" -v
    ;;
  --gas)
    run_forge "Gas Profiling Benchmarks" \
      --match-contract "InvariantHTLCEscrowTest" --match-test "testGas" -v
    ;;
  --security)
    run_forge "Security Tests" \
      --match-contract "HTLCEscrowSecurityTest" -v
    ;;
  "")
    # Run everything in sequence.
    run_forge "Unit + Fuzz Tests" \
      --match-path "test/foundry/HTLCEscrow.t.sol" -v

    run_forge "Invariant Tests (stateful fuzz campaign)" \
      --match-contract "InvariantHTLCEscrowTest" -v

    run_forge "Security Tests" \
      --match-contract "HTLCEscrowSecurityTest" -v

    run_forge "Gas Profiling Benchmarks" \
      --match-contract "InvariantHTLCEscrowTest" --match-test "testGas" -v

    echo ""
    echo "════════════════════════════════════════════════════════════════════"
    echo "  ✅  All Foundry tests passed."
    echo "════════════════════════════════════════════════════════════════════"
    ;;
  *)
    echo "Unknown option: ${MODE}"
    echo "Usage: $0 [--unit | --invariant | --gas | --security]"
    exit 1
    ;;
esac
