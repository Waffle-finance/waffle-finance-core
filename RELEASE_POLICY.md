# Release Policy and Versioning

## Overview

This document defines the release process, versioning policy, and package conventions for the WaffleFinance monorepo.

**Companion documents — read these alongside this policy:**

| Document | What it covers |
|---|---|
| [docs/RELEASE_CONTRACT.md](docs/RELEASE_CONTRACT.md) | Per-package build target, artifact, environment assumptions, and known verification gaps |
| [docs/RELEASE_CHECKLIST_MULTI_PACKAGE.md](docs/RELEASE_CHECKLIST_MULTI_PACKAGE.md) | Cross-package impact matrix, per-package verification steps, risk scoring — the operational gate before tagging |
| [.github/RELEASE_CHECKLIST.md](.github/RELEASE_CHECKLIST.md) | Step-by-step operational checklist (CI, local verification, tagging, post-release) |
| [docs/COMMANDS.md](docs/COMMANDS.md) | Canonical command map — which `pnpm` command belongs to which package |

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

**Exception**: Private packages (coordinator) and the Soroban Rust workspace (`soroban/Cargo.toml`) may have independent versions.

For the definitive per-package publish-target breakdown (npm vs Vercel vs Docker vs private), and the version sync table that must be satisfied before tagging, see
[docs/RELEASE_CHECKLIST_MULTI_PACKAGE.md — Part 3](docs/RELEASE_CHECKLIST_MULTI_PACKAGE.md#part-3--shared-release-gates-all-packages).

## Release Process

### Pre-Release Checklist

Before tagging a release, work through
[docs/RELEASE_CHECKLIST_MULTI_PACKAGE.md](docs/RELEASE_CHECKLIST_MULTI_PACKAGE.md),
which covers the cross-package impact matrix and per-package verification steps.
The short form is listed here for reference:

1. **Assess cross-package impact** — see the impact matrix in
   `docs/RELEASE_CHECKLIST_MULTI_PACKAGE.md` and verify every affected package.

2. **Update all package versions**
   ```bash
   # Update all packages to X.Y.Z
   pnpm version X.Y.Z -ws
   ```

3. **Run full test suite**
   ```bash
   pnpm test
   ```

4. **Build all packages**
   ```bash
   pnpm build
   ```

5. **Verify release locally** (Linux/macOS)
   ```bash
   ./scripts/verify-release-locally.sh
   ```
   Or on Windows:
   ```powershell
   .\scripts\verify-release-locally.ps1
   ```

6. **Update CHANGELOG.md** with release notes

7. **Commit version changes**
   ```bash
   git add package.json packages/*/package.json
   git commit -m "chore: release v1.0.1"
   ```

8. **Tag release**
   ```bash
   git tag -a v1.0.1 -m "Release v1.0.1"
   git push origin v1.0.1
   ```

### Publishing Packages

**npm-published packages** (consumed by external code):
- `@wafflefinance/sdk`
- `@wafflefinance/contracts`

**Deployed but not npm-published**:
- `@wafflefinance/frontend` — deployed to Vercel as a static site (see
  `vercel.json`); not published to the npm registry
- `@wafflefinance/relayer` — Docker image pushed to GHCR; not published to npm
- `@wafflefinance/resolver` — Docker image pushed to GHCR; not published to npm

**Private packages** (not published, not deployed via npm):
- `@wafflefinance/coordinator` — compiled JS artifact deployed directly;
  marked `"private": true`

**Publish Command** (npm-published packages only):
```bash
# Publish SDK and contracts
pnpm --filter @wafflefinance/sdk publish --access public
pnpm --filter @wafflefinance/contracts publish --access public
```

Running `pnpm -r publish --access public` will attempt to publish every
non-private package including `frontend`, `relayer`, and `resolver`, which
is usually not what you want. Use per-package `--filter` flags instead.

### Post-Release

1. **Verify npm-published packages**
   ```bash
   npm view @wafflefinance/sdk
   npm view @wafflefinance/contracts
   ```

2. **Verify Vercel deployment** — confirm the frontend build succeeded in the
   Vercel dashboard after the tag is pushed.

3. **Update deployment configurations** if needed

4. **Announce release** to stakeholders

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

### Workflows that actually exist

There is **no automated release workflow** (`release.yml`) in this repository.
Publishing is a manual step performed after local verification passes. The four
workflows that do run automatically are:

| Workflow file | Triggers | What it checks |
|---|---|---|
| `command-contract.yml` | push to `main`, all PRs | `scripts/validate-commands.mjs` — enforces `docs/COMMANDS.md` |
| `dep-review.yml` | PRs touching `pnpm-lock.yaml` or any `package.json` | CVE/licence scan, dep-version alignment, critical-deps labelling |
| `frontend.yml` | push/PR touching `frontend/`, `packages/sdk/`, `packages/config/` | Vitest (testnet + mainnet matrix), TypeScript typecheck, ESLint |
| `soroban-contracts.yml` | push/PR touching `soroban/` | `cargo test` — unit, state-machine harness, property fuzz |

None of these workflows publish packages. Publication is gated on all four
passing (for any changed package area) **plus** a green run of
`scripts/verify-release-locally.sh` (or `.ps1` on Windows) locally before
the release tag is pushed.

### Publish step (manual)

```bash
# After verify-release-locally.sh passes and all CI is green on main:
pnpm -r publish --access public
```

Supply `NODE_AUTH_TOKEN` in your shell environment (or `.npmrc`) before
running this command. Do not publish from a dirty working tree.

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
