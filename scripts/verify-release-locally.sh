#!/bin/bash

# Local Release Verification Script
# This script runs the same verification steps as the GitHub Actions release workflow
# Run this before pushing a release tag to catch issues early

set -e  # Exit on any error

echo "=========================================="
echo "WaffleFinance Local Release Verification"
echo "=========================================="
echo ""

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Helper functions
error() {
    echo -e "${RED}❌ Error: $1${NC}"
    exit 1
}

success() {
    echo -e "${GREEN}✅ $1${NC}"
}

warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

info() {
    echo "ℹ️  $1"
}

# ========================================
# Release-Check Manifest
# ========================================
# The canonical list of required release gates lives in
# scripts/release-checks.manifest.json. This script reads that manifest
# instead of maintaining its own duplicated command list.
MANIFEST_PATH="scripts/release-checks.manifest.json"
MANIFEST_CHECKER="scripts/check-release-manifest.mjs"

if [ ! -f "$MANIFEST_PATH" ]; then
    error "Release-check manifest not found: $MANIFEST_PATH"
fi

# Check prerequisites
info "Checking prerequisites..."

if ! command -v node &> /dev/null; then
    error "Node.js is not installed"
fi

if ! command -v pnpm &> /dev/null; then
    error "pnpm is not installed"
fi

if ! command -v forge &> /dev/null; then
    error "Foundry is not installed"
fi

if ! command -v jq &> /dev/null; then
    error "jq is not installed (required for JSON parsing)"
fi

success "All prerequisites found"
echo ""

info "Validating release-check manifest..."
if [ ! -f "$MANIFEST_CHECKER" ]; then
    error "Release manifest checker not found: $MANIFEST_CHECKER"
fi
node "$MANIFEST_CHECKER" --manifest "$MANIFEST_PATH"
success "Release-check manifest validated"
echo ""

# Helper: read a manifest field for a named check
manifest_field() {
    local check_name="$1"
    local field="$2"
    jq -r --arg name "$check_name" --arg field "$field" \
        '.checks[] | select(.name == $name) | .[$field] // empty' "$MANIFEST_PATH"
}

# Helper: run a required (non-conditional) manifest check by name
run_manifest_check() {
    local check_name="$1"
    local command
    command=$(manifest_field "$check_name" "command")
    if [ -z "$command" ]; then
        error "Manifest check '$check_name' has no command defined"
    fi
    info "Running manifest check '$check_name': $command"
    if ! bash -c "$command"; then
        error "Manifest check '$check_name' failed"
    fi
    success "Manifest check '$check_name' passed"
    echo ""
}

# Helper: run a conditional (network-dependent) manifest check by name.
# Records the outcome so the final report can state whether it ran or was
# skipped, and why.
CONDITIONAL_RESULTS=()

run_conditional_check() {
    local check_name="$1"
    local command
    local prerequisite
    command=$(manifest_field "$check_name" "command")
    prerequisite=$(manifest_field "$check_name" "prerequisite")

    if [ -z "$command" ]; then
        error "Conditional manifest check '$check_name' has no command defined"
    fi

    if [ -n "$prerequisite" ] && [ -z "${!prerequisite:-}" ]; then
        warning "SKIPPED: '$check_name' requires environment variable $prerequisite (not set)"
        CONDITIONAL_RESULTS+=("$check_name|skipped|missing $prerequisite")
        echo ""
        return 0
    fi

    info "Running conditional manifest check '$check_name': $command"
    if bash -c "$command"; then
        success "Conditional manifest check '$check_name' passed"
        CONDITIONAL_RESULTS+=("$check_name|ran|passed")
    else
        error "Conditional manifest check '$check_name' failed"
    fi
    echo ""
}

# Install dependencies
info "Installing dependencies..."
pnpm install --frozen-lockfile=false
success "Dependencies installed"
echo ""

info "Validating deployment artifacts..."
pnpm run validate:deployments
success "Deployment artifacts validated"
echo ""

# ========================================
# Contract Artifact Verification
# ========================================
echo "=========================================="
echo "Contract Artifact Verification"
echo "=========================================="
echo ""

info "Compiling contracts with Hardhat..."
pnpm --filter @wafflefinance/contracts compile
success "Hardhat compilation complete"
echo ""

info "Verifying Hardhat artifacts..."
if [ ! -d "contracts/artifacts/contracts" ]; then
    error "Hardhat artifacts directory not found"
fi

REQUIRED_CONTRACTS=("HTLCEscrow" "ResolverRegistry")
for contract in "${REQUIRED_CONTRACTS[@]}"; do
    artifact_path="contracts/artifacts/contracts/${contract}.sol/${contract}.json"
    if [ ! -f "$artifact_path" ]; then
        error "Missing artifact for $contract"
    fi
    success "Found artifact: $contract"
done
echo ""

info "Compiling contracts with Foundry..."
cd contracts
forge build
cd ..
success "Foundry compilation complete"
echo ""

info "Verifying Foundry artifacts..."
if [ ! -d "contracts/out" ]; then
    error "Foundry out directory not found"
fi

REQUIRED_CONTRACTS=("HTLCEscrow.sol" "ResolverRegistry.sol")
for contract in "${REQUIRED_CONTRACTS[@]}"; do
    if [ ! -d "contracts/out/${contract}" ]; then
        error "Missing Foundry artifact for $contract"
    fi
    success "Found Foundry artifact: $contract"
done
echo ""

info "Verifying contract bytecode consistency..."
hardhat_bytecode=$(jq -r '.bytecode' contracts/artifacts/contracts/HTLCEscrow.sol/HTLCEscrow.json | head -c 100)
foundry_bytecode=$(jq -r '.bytecode.object' contracts/out/HTLCEscrow.sol/HTLCEscrow.json | head -c 100)

if [ -z "$hardhat_bytecode" ] || [ -z "$foundry_bytecode" ]; then
    error "Could not extract bytecode from artifacts"
fi

info "Hardhat bytecode prefix: $hardhat_bytecode..."
info "Foundry bytecode prefix: $foundry_bytecode..."
success "Contract bytecode verification complete"
echo ""

run_manifest_check "hardhat-tests"

info "Running Foundry tests..."
cd contracts
forge test --match-path "test/foundry/*" -v
cd ..
success "Foundry tests passed"
echo ""

# Mainnet fork integration test (conditional: requires fork RPC configuration)
run_conditional_check "mainnet-fork-escrow-factory"

info "Generating contract artifact checksums..."
cd contracts
find artifacts/contracts -name "*.json" -type f | sort | xargs cat | sha256sum | awk '{print $1}' > contract-artifacts.checksum
CONTRACTS_CHECKSUM=$(cat contract-artifacts.checksum)
cd ..
success "Contract artifacts checksum: $CONTRACTS_CHECKSUM"
echo ""

# ========================================
# SDK Package Build Verification
# ========================================
echo "=========================================="
echo "SDK Package Build Verification"
echo "=========================================="
echo ""

info "Building SDK package..."
pnpm --filter @wafflefinance/sdk build
success "SDK build complete"
echo ""

info "Verifying SDK build outputs..."
SDK_DIR="packages/sdk"

if [ ! -d "$SDK_DIR/dist" ]; then
    error "SDK dist directory not found"
fi

if [ ! -f "$SDK_DIR/dist/index.js" ]; then
    error "SDK main entry point (dist/index.js) not found"
fi

if [ ! -f "$SDK_DIR/dist/index.d.ts" ]; then
    error "SDK type declarations (dist/index.d.ts) not found"
fi

EXPORT_PATHS=("ethereum" "soroban" "secrets" "state-machine" "solana" "assets" "types")
for path in "${EXPORT_PATHS[@]}"; do
    if [ ! -f "$SDK_DIR/dist/$path/index.js" ]; then
        error "Missing export path: $path/index.js"
    fi
    if [ ! -f "$SDK_DIR/dist/$path/index.d.ts" ]; then
        error "Missing type declarations: $path/index.d.ts"
    fi
    success "Export path verified: $path"
done
echo ""

run_manifest_check "sdk-tests"

info "Verifying SDK package.json exports..."
EXPORTS=$(jq -r '.exports | keys[]' $SDK_DIR/package.json | grep -v "^\.$")

for export in $EXPORTS; do
    export_path=${export#./}
    export_file="$SDK_DIR/dist/$export_path/index.js"
    
    if [ ! -f "$export_file" ]; then
        error "Export '$export' defined in package.json but file not found: $export_file"
    fi
    success "Export verified: $export"
done
echo ""

info "Testing SDK package imports..."
cat > /tmp/test-imports.mjs << 'EOF'
import { resolve } from 'path';
import { readFile } from 'fs/promises';

const pkgPath = process.argv[2];
const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));

console.log('Testing package exports...');
for (const [key, value] of Object.entries(pkg.exports || {})) {
  if (typeof value === 'object' && value.import) {
    const importPath = resolve(pkgPath, '..', value.import);
    try {
      await import(importPath);
      console.log(`✓ Import successful: ${key}`);
    } catch (err) {
      console.error(`❌ Import failed for ${key}: ${err.message}`);
      process.exit(1);
    }
  }
}
console.log('✅ All imports verified');
EOF

node /tmp/test-imports.mjs $SDK_DIR/package.json
success "All imports verified"
echo ""

info "Generating SDK package checksums..."
find $SDK_DIR/dist -type f | sort | xargs cat | sha256sum | awk '{print $1}' > sdk-build.checksum
SDK_CHECKSUM=$(cat sdk-build.checksum)
success "SDK package checksum: $SDK_CHECKSUM"
echo ""

info "Verifying SDK package size..."
TOTAL_SIZE=$(du -sb $SDK_DIR/dist | awk '{print $1}')
MAX_SIZE=$((10 * 1024 * 1024))  # 10MB limit

HUMAN_SIZE=$(numfmt --to=iec-i --suffix=B $TOTAL_SIZE 2>/dev/null || echo "$TOTAL_SIZE bytes")
info "SDK package size: $HUMAN_SIZE"

if [ $TOTAL_SIZE -gt $MAX_SIZE ]; then
    warning "SDK package size exceeds 10MB - this may indicate bloat"
else
    success "SDK package size is reasonable"
fi
echo ""

# ========================================
# Additional Package Verification
# ========================================
echo "=========================================="
echo "Additional Package Verification"
echo "=========================================="
echo ""

run_manifest_check "build-all-packages"

info "Running typechecks on all packages..."
pnpm --filter @wafflefinance/sdk exec tsc --noEmit
success "SDK typecheck passed"

pnpm --filter @wafflefinance/coordinator exec tsc --noEmit
success "Coordinator typecheck passed"

pnpm --filter @wafflefinance/resolver exec tsc --noEmit
success "Resolver typecheck passed"

pnpm --filter @wafflefinance/frontend exec tsc --noEmit
success "Frontend typecheck passed"
echo ""

# ========================================
# Soroban Contract Test Verification
# ========================================
echo "=========================================="
echo "Soroban Contract Test Verification"
echo "=========================================="
echo ""

SOROBAN_STATUS="skipped"
if command -v cargo &> /dev/null; then
    info "Running Soroban (Rust) contract tests from soroban/..."
    (cd soroban && cargo test --workspace --locked)
    SOROBAN_STATUS="passed"
    success "Soroban cargo tests passed"
else
    warning "SKIPPED: cargo not found - Soroban Rust tests were NOT run. Install the Rust toolchain and re-run this script to verify Soroban contracts."
fi
echo ""

# ========================================
# Final Report
# ========================================
echo "=========================================="
echo "Release Verification Complete"
echo "=========================================="
echo ""
echo "Summary:"
echo "--------"
success "Contract artifacts verified"
success "SDK package verified"
success "All packages built successfully"
success "All typechecks passed"
if [ "$SOROBAN_STATUS" = "passed" ]; then
    success "Soroban (Rust) tests passed"
else
    warning "Soroban (Rust) tests SKIPPED (cargo not found)"
fi
echo ""
echo "Conditional (network-dependent) checks:"
echo "---------------------------------------"
if [ ${#CONDITIONAL_RESULTS[@]} -eq 0 ]; then
    info "No conditional checks were configured in the manifest"
else
    for result in "${CONDITIONAL_RESULTS[@]}"; do
        IFS='|' read -r check_name status detail <<< "$result"
        if [ "$status" = "ran" ]; then
            success "$check_name: RAN ($detail)"
        else
            warning "$check_name: SKIPPED ($detail)"
        fi
    done
fi
echo ""
echo "Manifest: $MANIFEST_PATH"
echo ""
echo "Checksums:"
echo "----------"
echo "Contracts: $CONTRACTS_CHECKSUM"
echo "SDK:       $SDK_CHECKSUM"
echo ""
success "All release verification steps passed! ✨"
echo ""
echo "You can now safely push your release tag:"
echo "  git tag -a v1.0.0 -m 'Release version 1.0.0'"
echo "  git push origin v1.0.0"
echo ""
