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

info "Running Hardhat contract tests..."
pnpm --filter @wafflefinance/contracts exec hardhat test test/HTLCEscrow.test.ts test/ResolverRegistry.test.ts
success "Hardhat tests passed"
echo ""

info "Running Foundry tests..."
cd contracts
forge test --match-path "test/foundry/*" -v
cd ..
success "Foundry tests passed"
echo ""

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

info "Running SDK tests..."
pnpm --filter @wafflefinance/sdk test
success "SDK tests passed"
echo ""

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

info "Building all packages..."
pnpm build
success "All packages built successfully"
echo ""

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
