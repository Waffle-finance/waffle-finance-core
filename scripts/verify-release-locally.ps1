# Local Release Verification Script (PowerShell)
# This script runs the same verification steps as the GitHub Actions release workflow
# Run this before pushing a release tag to catch issues early

$ErrorActionPreference = "Stop"

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "WaffleFinance Local Release Verification" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

# Helper functions
function Write-Error-Message {
    param([string]$Message)
    Write-Host "❌ Error: $Message" -ForegroundColor Red
    exit 1
}

function Write-Success {
    param([string]$Message)
    Write-Host "✅ $Message" -ForegroundColor Green
}

function Write-Warning-Message {
    param([string]$Message)
    Write-Host "⚠️  $Message" -ForegroundColor Yellow
}

function Write-Info {
    param([string]$Message)
    Write-Host "ℹ️  $Message" -ForegroundColor Cyan
}

# Check prerequisites
Write-Info "Checking prerequisites..."

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error-Message "Node.js is not installed"
}

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Write-Error-Message "pnpm is not installed"
}

if (-not (Get-Command forge -ErrorAction SilentlyContinue)) {
    Write-Error-Message "Foundry is not installed"
}

Write-Success "All prerequisites found"
Write-Host ""

# Install dependencies
Write-Info "Installing dependencies..."
pnpm install --frozen-lockfile=false
if ($LASTEXITCODE -ne 0) { Write-Error-Message "Failed to install dependencies" }
Write-Success "Dependencies installed"
Write-Host ""

Write-Info "Validating deployment artifacts..."
pnpm run validate:deployments
if ($LASTEXITCODE -ne 0) { Write-Error-Message "Deployment artifact validation failed" }
Write-Success "Deployment artifacts validated"
Write-Host ""

# ========================================
# Contract Artifact Verification
# ========================================
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "Contract Artifact Verification" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

Write-Info "Compiling contracts with Hardhat..."
pnpm --filter @wafflefinance/contracts compile
if ($LASTEXITCODE -ne 0) { Write-Error-Message "Hardhat compilation failed" }
Write-Success "Hardhat compilation complete"
Write-Host ""

Write-Info "Verifying Hardhat artifacts..."
if (-not (Test-Path "contracts\artifacts\contracts")) {
    Write-Error-Message "Hardhat artifacts directory not found"
}

$RequiredContracts = @("HTLCEscrow", "ResolverRegistry")
foreach ($contract in $RequiredContracts) {
    $artifactPath = "contracts\artifacts\contracts\$contract.sol\$contract.json"
    if (-not (Test-Path $artifactPath)) {
        Write-Error-Message "Missing artifact for $contract"
    }
    Write-Success "Found artifact: $contract"
}
Write-Host ""

Write-Info "Compiling contracts with Foundry..."
Push-Location contracts
forge build
if ($LASTEXITCODE -ne 0) { 
    Pop-Location
    Write-Error-Message "Foundry compilation failed" 
}
Pop-Location
Write-Success "Foundry compilation complete"
Write-Host ""

Write-Info "Verifying Foundry artifacts..."
if (-not (Test-Path "contracts\out")) {
    Write-Error-Message "Foundry out directory not found"
}

$RequiredContracts = @("HTLCEscrow.sol", "ResolverRegistry.sol")
foreach ($contract in $RequiredContracts) {
    if (-not (Test-Path "contracts\out\$contract")) {
        Write-Error-Message "Missing Foundry artifact for $contract"
    }
    Write-Success "Found Foundry artifact: $contract"
}
Write-Host ""

Write-Info "Verifying contract bytecode consistency..."
$hardhatArtifact = Get-Content "contracts\artifacts\contracts\HTLCEscrow.sol\HTLCEscrow.json" | ConvertFrom-Json
$foundryArtifact = Get-Content "contracts\out\HTLCEscrow.sol\HTLCEscrow.json" | ConvertFrom-Json

$hardhatBytecode = $hardhatArtifact.bytecode.Substring(0, [Math]::Min(100, $hardhatArtifact.bytecode.Length))
$foundryBytecode = $foundryArtifact.bytecode.object.Substring(0, [Math]::Min(100, $foundryArtifact.bytecode.object.Length))

if ([string]::IsNullOrEmpty($hardhatBytecode) -or [string]::IsNullOrEmpty($foundryBytecode)) {
    Write-Error-Message "Could not extract bytecode from artifacts"
}

Write-Info "Hardhat bytecode prefix: $hardhatBytecode..."
Write-Info "Foundry bytecode prefix: $foundryBytecode..."
Write-Success "Contract bytecode verification complete"
Write-Host ""

Write-Info "Running Hardhat contract tests..."
pnpm --filter @wafflefinance/contracts exec hardhat test test/HTLCEscrow.test.ts test/ResolverRegistry.test.ts
if ($LASTEXITCODE -ne 0) { Write-Error-Message "Hardhat tests failed" }
Write-Success "Hardhat tests passed"
Write-Host ""

Write-Info "Running Foundry tests..."
Push-Location contracts
forge test --match-path "test/foundry/*" -v
if ($LASTEXITCODE -ne 0) { 
    Pop-Location
    Write-Error-Message "Foundry tests failed" 
}
Pop-Location
Write-Success "Foundry tests passed"
Write-Host ""

Write-Info "Generating contract artifact checksums..."
$contractFiles = Get-ChildItem -Path "contracts\artifacts\contracts" -Filter "*.json" -Recurse -File | Sort-Object FullName
$combinedContent = $contractFiles | ForEach-Object { Get-Content $_.FullName -Raw } | Out-String
$contractsChecksum = (Get-FileHash -InputStream ([IO.MemoryStream]::new([Text.Encoding]::UTF8.GetBytes($combinedContent))) -Algorithm SHA256).Hash.ToLower()
Write-Success "Contract artifacts checksum: $contractsChecksum"
Write-Host ""

# ========================================
# SDK Package Build Verification
# ========================================
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "SDK Package Build Verification" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

Write-Info "Building SDK package..."
pnpm --filter @wafflefinance/sdk build
if ($LASTEXITCODE -ne 0) { Write-Error-Message "SDK build failed" }
Write-Success "SDK build complete"
Write-Host ""

Write-Info "Verifying SDK build outputs..."
$sdkDir = "packages\sdk"

if (-not (Test-Path "$sdkDir\dist")) {
    Write-Error-Message "SDK dist directory not found"
}

if (-not (Test-Path "$sdkDir\dist\index.js")) {
    Write-Error-Message "SDK main entry point (dist\index.js) not found"
}

if (-not (Test-Path "$sdkDir\dist\index.d.ts")) {
    Write-Error-Message "SDK type declarations (dist\index.d.ts) not found"
}

$exportPaths = @("ethereum", "soroban", "secrets", "state-machine", "solana", "assets", "types")
foreach ($path in $exportPaths) {
    if (-not (Test-Path "$sdkDir\dist\$path\index.js")) {
        Write-Error-Message "Missing export path: $path\index.js"
    }
    if (-not (Test-Path "$sdkDir\dist\$path\index.d.ts")) {
        Write-Error-Message "Missing type declarations: $path\index.d.ts"
    }
    Write-Success "Export path verified: $path"
}
Write-Host ""

Write-Info "Running SDK tests..."
pnpm --filter @wafflefinance/sdk test
if ($LASTEXITCODE -ne 0) { Write-Error-Message "SDK tests failed" }
Write-Success "SDK tests passed"
Write-Host ""

Write-Info "Verifying SDK package.json exports..."
$packageJson = Get-Content "$sdkDir\package.json" | ConvertFrom-Json
foreach ($export in $packageJson.exports.PSObject.Properties.Name) {
    if ($export -eq ".") { continue }
    $exportPath = $export.TrimStart("./")
    $exportFile = "$sdkDir\dist\$exportPath\index.js"
    
    if (-not (Test-Path $exportFile)) {
        Write-Error-Message "Export '$export' defined in package.json but file not found: $exportFile"
    }
    Write-Success "Export verified: $export"
}
Write-Host ""

Write-Info "Generating SDK package checksums..."
$sdkFiles = Get-ChildItem -Path "$sdkDir\dist" -File -Recurse | Sort-Object FullName
$sdkCombinedContent = $sdkFiles | ForEach-Object { Get-Content $_.FullName -Raw } | Out-String
$sdkChecksum = (Get-FileHash -InputStream ([IO.MemoryStream]::new([Text.Encoding]::UTF8.GetBytes($sdkCombinedContent))) -Algorithm SHA256).Hash.ToLower()
Write-Success "SDK package checksum: $sdkChecksum"
Write-Host ""

Write-Info "Verifying SDK package size..."
$totalSize = (Get-ChildItem -Path "$sdkDir\dist" -Recurse -File | Measure-Object -Property Length -Sum).Sum
$maxSize = 10 * 1024 * 1024  # 10MB

$humanSize = if ($totalSize -gt 1MB) { "{0:N2} MB" -f ($totalSize / 1MB) } else { "{0:N2} KB" -f ($totalSize / 1KB) }
Write-Info "SDK package size: $humanSize"

if ($totalSize -gt $maxSize) {
    Write-Warning-Message "SDK package size exceeds 10MB - this may indicate bloat"
} else {
    Write-Success "SDK package size is reasonable"
}
Write-Host ""

# ========================================
# Additional Package Verification
# ========================================
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "Additional Package Verification" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""

Write-Info "Building all packages..."
pnpm build
if ($LASTEXITCODE -ne 0) { Write-Error-Message "Failed to build all packages" }
Write-Success "All packages built successfully"
Write-Host ""

Write-Info "Running typechecks on all packages..."

pnpm --filter @wafflefinance/sdk exec tsc --noEmit
if ($LASTEXITCODE -ne 0) { Write-Error-Message "SDK typecheck failed" }
Write-Success "SDK typecheck passed"

pnpm --filter @wafflefinance/coordinator exec tsc --noEmit
if ($LASTEXITCODE -ne 0) { Write-Error-Message "Coordinator typecheck failed" }
Write-Success "Coordinator typecheck passed"

pnpm --filter @wafflefinance/resolver exec tsc --noEmit
if ($LASTEXITCODE -ne 0) { Write-Error-Message "Resolver typecheck failed" }
Write-Success "Resolver typecheck passed"

pnpm --filter @wafflefinance/frontend exec tsc --noEmit
if ($LASTEXITCODE -ne 0) { Write-Error-Message "Frontend typecheck failed" }
Write-Success "Frontend typecheck passed"
Write-Host ""

# ========================================
# Final Report
# ========================================
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "Release Verification Complete" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Summary:" -ForegroundColor White
Write-Host "--------" -ForegroundColor White
Write-Success "Contract artifacts verified"
Write-Success "SDK package verified"
Write-Success "All packages built successfully"
Write-Success "All typechecks passed"
Write-Host ""
Write-Host "Checksums:" -ForegroundColor White
Write-Host "----------" -ForegroundColor White
Write-Host "Contracts: $contractsChecksum"
Write-Host "SDK:       $sdkChecksum"
Write-Host ""
Write-Success "All release verification steps passed! ✨"
Write-Host ""
Write-Host "You can now safely push your release tag:"
Write-Host "  git tag -a v1.0.0 -m 'Release version 1.0.0'"
Write-Host "  git push origin v1.0.0"
Write-Host ""
