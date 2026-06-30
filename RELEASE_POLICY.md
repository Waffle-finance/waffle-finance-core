# Release Policy and Versioning

## Overview

This document defines the release process, versioning policy, and package conventions for the WaffleFinance monorepo.

## Versioning Policy

### Semantic Versioning (SemVer)

All packages follow [Semantic Versioning 2.0.0](https://semver.org/):

- **MAJOR**: Incompatible API changes
- **MINOR**: Backwards-compatible functionality additions
- **PATCH**: Backwards-compatible bug fixes

### Current Versions

All packages currently at `1.0.0`:

- `@wafflefinance/sdk`: 1.0.0
- `@wafflefinance/frontend`: 1.0.0
- `@wafflefinance/coordinator`: 1.0.0 (private)
- `@wafflefinance/contracts`: (version in contracts/package.json)
- `@wafflefinance/relayer`: (version in relayer/package.json)
- `@wafflefinance/resolver`: (version in resolver/package.json)

### Version Synchronization

**Policy**: All published packages should be released together with the same version number.

**Rationale**: The SDK, frontend, and coordinator are tightly coupled. Version drift can create surprising integration issues.

**Exception**: Private packages (coordinator) may have independent versions.

## Release Process

### Pre-Release Checklist

1. **Update all package versions**
   ```bash
   # Update all packages to X.Y.Z
   pnpm version X.Y.Z -ws
   ```

2. **Run full test suite**
   ```bash
   pnpm test
   ```

3. **Build all packages**
   ```bash
   pnpm build
   ```

4. **Verify release locally**
   ```bash
   ./scripts/verify-release-locally.sh
   ```

5. **Update CHANGELOG.md** with release notes

6. **Commit version changes**
   ```bash
   git add package.json packages/*/package.json
   git commit -m "chore: release v1.0.1"
   ```

7. **Tag release**
   ```bash
   git tag -a v1.0.1 -m "Release v1.0.1"
   git push origin v1.0.1
   ```

### Publishing Packages

**Published Packages**:
- `@wafflefinance/sdk`
- `@wafflefinance/frontend`
- `@wafflefinance/contracts`
- `@wafflefinance/relayer`
- `@wafflefinance/resolver`

**Private Packages** (not published):
- `@wafflefinance/coordinator`

**Publish Command**:
```bash
# Publish all packages in workspace
pnpm -r publish --access public
```

**Individual Package Publish**:
```bash
cd packages/sdk
pnpm publish --access public
```

### Post-Release

1. **Verify packages on npm**
   ```bash
   npm view @wafflefinance/sdk
   npm view @wafflefinance/frontend
   ```

2. **Update deployment configurations** if needed

3. **Announce release** to stakeholders

## Package Metadata

### Required Fields

All `package.json` files must include:

```json
{
  "name": "@wafflefinance/package-name",
  "version": "1.0.0",
  "description": "Clear description of package purpose",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "files": ["dist"],
  "repository": {
    "type": "git",
    "url": "https://github.com/waffle-finance/waffle-finance-core.git"
  },
  "keywords": ["wafflefinance", "cross-chain", "bridge"],
  "license": "MIT"
}
```

### Package-Specific Exports

**SDK** (`@wafflefinance/sdk`):
- Main entry point
- Subpath exports: `./ethereum`, `./soroban`, `./solana`, `./assets`, `./secrets`, `./state-machine`, `./types`

**Frontend** (`@wafflefinance/frontend`):
- Single entry point (React app)
- No subpath exports

**Contracts** (`@wafflefinance/contracts`):
- ABI exports
- Type exports

## Release Validation

### Automated Validation

The `validate-workspace.mjs` script checks:
- All package versions are synchronized
- No circular dependencies
- All dependencies are available in registry

### Manual Validation

1. **Install fresh from registry**
   ```bash
   cd /tmp/test-release
   npm init -y
   npm install @wafflefinance/sdk@latest
   ```

2. **Test imports**
   ```typescript
   import { resolveStellarAsset } from '@wafflefinance/sdk';
   ```

3. **Test frontend build**
   ```bash
   npm install @wafflefinance/frontend@latest
   npm run build
   ```

## Release Types

### Patch Release (1.0.X)

**Trigger**: Bug fixes, documentation updates, non-breaking changes

**Process**:
1. Fix bug
2. Update version: `pnpm version patch -ws`
3. Run tests
4. Publish

**Example**: `1.0.0` → `1.0.1`

### Minor Release (1.X.0)

**Trigger**: New features, backwards-compatible API additions

**Process**:
1. Implement feature
2. Update version: `pnpm version minor -ws`
3. Update CHANGELOG with new features
4. Run tests
5. Publish

**Example**: `1.0.0` → `1.1.0`

### Major Release (X.0.0)

**Trigger**: Breaking changes, API redesign

**Process**:
1. Plan breaking changes
2. Implement with migration guide
3. Update version: `pnpm version major -ws`
4. Update CHANGELOG with migration notes
5. Run comprehensive tests
6. Publish
7. Announce breaking changes

**Example**: `1.0.0` → `2.0.0`

## Emergency Releases

**Process for critical fixes**:

1. Create hotfix branch from latest release tag
2. Apply fix
3. Update version (patch)
4. Publish immediately
5. Merge back to main branch

## Rollback Procedure

If a release causes critical issues:

1. **Unpublish from npm** (within 72 hours)
   ```bash
   npm unpublish @wafflefinance/sdk@1.0.1
   ```

2. **Publish previous version**
   ```bash
   pnpm publish --tag previous
   ```

3. **Investigate and fix issue**
4. **Release corrected version**

## CI/CD Integration

### GitHub Actions Workflow

```yaml
name: Release

on:
  push:
    tags:
      - 'v*'

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: pnpm/action-setup@v2
      - run: pnpm install
      - run: pnpm test
      - run: pnpm build
      - run: pnpm -r publish --access public
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

## Troubleshooting

### Version Mismatch

**Symptom**: Packages have different versions

**Fix**:
```bash
pnpm version X.Y.Z -ws
```

### Publish Failure

**Symptom**: `403 Forbidden` from npm

**Fix**:
1. Check npm token is valid
2. Ensure you have publish permissions
3. Verify package name is not taken

### Build Failure

**Symptom**: Build fails after version bump

**Fix**:
1. Check TypeScript compilation
2. Verify all dependencies are installed
3. Clean build artifacts: `pnpm clean`

## Documentation Updates

Each release should include:

1. **CHANGELOG.md**: Summary of changes
2. **README.md**: If API changed significantly
3. **Migration guide**: For major releases
4. **Release notes**: In GitHub release

## Contact

For release-related questions:
- Review this document
- Check existing GitHub issues
- Contact maintainers via GitHub discussions
