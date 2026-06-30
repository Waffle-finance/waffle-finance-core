# Release Process Documentation

## Overview

The WaffleFinance release workflow ensures that all contract artifacts and package builds are thoroughly verified before publishing. This document describes the verification steps and how to interpret results.

## Release Workflow Components

### 1. Contract Artifact Verification

The release workflow verifies contract compilation and artifact integrity through multiple stages:

#### Hardhat Compilation
- Compiles all Solidity contracts using Hardhat
- Verifies that critical contract artifacts exist:
  - `HTLCEscrow.sol`
  - `ResolverRegistry.sol`
- Confirms artifact JSON files are properly generated

#### Foundry Compilation
- Compiles contracts using Foundry/Forge for additional verification
- Ensures compilation is reproducible across different toolchains
- Verifies Foundry output artifacts exist

#### Bytecode Consistency Check
- Extracts bytecode from both Hardhat and Foundry artifacts
- Compares bytecode prefixes to ensure deterministic compilation
- Helps detect non-deterministic compilation issues

#### Contract Testing
- Runs full Hardhat test suite
- Executes Foundry fuzz and invariant tests
- Ensures all contracts function correctly before release

#### Artifact Checksums
- Generates SHA-256 checksums of all contract artifacts
- Creates a manifest of all artifact files
- Enables verification of artifact integrity post-release

### 2. SDK Package Build Verification

The SDK package undergoes comprehensive build validation:

#### Build Output Verification
- Confirms `dist/` directory is created
- Verifies main entry point (`dist/index.js`, `dist/index.d.ts`) exists
- Checks all export paths defined in `package.json`:
  - `ethereum`
  - `soroban`
  - `secrets`
  - `state-machine`
  - `solana`
  - `assets`
  - `types`

#### Package.json Export Validation
- Parses `package.json` exports configuration
- Verifies every export path has corresponding build artifacts
- Ensures both `.js` and `.d.ts` files exist for each export

#### Import Testing
- Dynamically imports all package exports
- Catches runtime import errors before release
- Validates that the package structure is consumable

#### SDK Testing
- Runs complete SDK test suite
- Ensures all functionality works as expected

#### Package Size Monitoring
- Measures total package size
- Warns if package exceeds 10MB (potential bloat indicator)
- Helps detect unintended bundled dependencies

#### SDK Checksums
- Generates SHA-256 checksums of all built files
- Creates a build manifest listing all files
- Enables post-release verification

### 3. Additional Package Verification

#### Full Monorepo Build
- Builds all packages in the workspace:
  - `@wafflefinance/sdk`
  - `@wafflefinance/coordinator`
  - `@wafflefinance/resolver`
  - `@wafflefinance/frontend`

#### TypeScript Type Checking
- Runs `tsc --noEmit` on all packages
- Ensures no type errors exist
- Validates type declarations are correct

### 4. Release Verification Report

The workflow generates a comprehensive report including:
- Release tag and commit SHA
- Build timestamp
- Verification results for contracts and SDK
- Artifact checksums for traceability
- Status of all verification steps

This report is uploaded as a GitHub Actions artifact and retained for 365 days.

### 5. Docker Image Build (Gated)

The Docker image build for the resolver is gated behind the verification job:
- Only runs after all verification steps pass
- Receives artifact checksums as build arguments
- Can embed verification metadata in the image

## Triggering a Release

Releases are triggered by pushing a version tag:

```bash
# Tag the release
git tag -a v1.2.3 -m "Release version 1.2.3"

# Push the tag to trigger the release workflow
git push origin v1.2.3
```

## Verification Failures

If any verification step fails, the entire release is halted:

### Contract Artifact Issues
- **Missing artifacts**: Check that all contracts compile successfully
- **Bytecode mismatch**: May indicate non-deterministic compilation settings
- **Test failures**: Fix failing tests before releasing

### SDK Build Issues
- **Missing build outputs**: Ensure `pnpm build` completes successfully
- **Export mismatches**: Verify `package.json` exports match source structure
- **Import errors**: Check for circular dependencies or missing dependencies
- **Package size warnings**: Investigate for bundled dependencies or bloat

### TypeCheck Failures
- Review TypeScript errors in the failing package
- Fix type errors before proceeding with release

## Interpreting Checksums

Checksums provide a cryptographic signature of build artifacts:

### Contract Artifacts Checksum
- SHA-256 hash of all contract JSON artifacts
- Changes if:
  - Contract source code is modified
  - Compiler version changes
  - Compiler settings change
  - Dependencies change

### SDK Package Checksum
- SHA-256 hash of all built SDK files
- Changes if:
  - Source code is modified
  - Build configuration changes
  - Dependencies change

**Important**: Identical source code + configuration should produce identical checksums.

## Viewing Release Artifacts

After a release completes, artifacts are available in the GitHub Actions run:

1. Navigate to the Actions tab
2. Select the release workflow run
3. Download artifacts:
   - `contract-artifacts`: All contract compilation outputs
   - `sdk-build-artifacts`: Complete SDK build
   - `release-verification-report`: Human-readable verification summary

Artifacts are retained for 90 days (report: 365 days).

## Security Considerations

### Supply Chain Protection
- Deterministic builds reduce risk of injected code
- Checksums enable verification of published artifacts
- Gated publishing prevents releases with failed tests

### Artifact Validation
- Multiple compilation toolchains (Hardhat + Foundry) provide redundancy
- Comprehensive test execution catches regressions
- Import testing catches packaging errors

## Troubleshooting

### Workflow Fails on Contract Compilation
```bash
# Locally verify contracts compile
cd contracts
pnpm compile
forge build
```

### Workflow Fails on SDK Build
```bash
# Locally verify SDK builds
cd packages/sdk
pnpm build
# Check all exports exist
ls -la dist/
```

### Workflow Fails on Tests
```bash
# Run tests locally
pnpm test
# Or specific package
pnpm --filter @wafflefinance/contracts test
pnpm --filter @wafflefinance/sdk test
```

### Workflow Fails on TypeCheck
```bash
# Run typechecks locally
pnpm --filter @wafflefinance/sdk exec tsc --noEmit
pnpm --filter @wafflefinance/coordinator exec tsc --noEmit
pnpm --filter @wafflefinance/resolver exec tsc --noEmit
pnpm --filter @wafflefinance/frontend exec tsc --noEmit
```

## Future Enhancements

Potential improvements to the release workflow:

1. **Artifact Signing**: Cryptographically sign artifacts with GPG
2. **SBOM Generation**: Generate Software Bill of Materials for supply chain transparency
3. **Size Regression Tests**: Fail if package size increases significantly
4. **Gas Report**: Include gas usage reports for contract deployments
5. **Changelog Validation**: Ensure CHANGELOG.md is updated for each release
6. **Semantic Version Validation**: Check that version bumps follow semver
7. **NPM Publish**: Automated publishing to npm registry after verification
8. **Release Notes**: Automated generation from commit messages

## Contact

For questions about the release process, contact the WaffleFinance team or open an issue on GitHub.
