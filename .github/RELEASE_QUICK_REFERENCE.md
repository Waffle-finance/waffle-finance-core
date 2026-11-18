> **ARCHIVAL NOTICE — design reference only, not current operating procedure**
>
> This document is a quick-reference guide for a `.github/workflows/release.yml`
> that **does not exist** in this repository. The CI steps, job monitoring
> instructions, and artifact download commands here will not work because the
> workflow was never committed.
>
> **Current release gate:** run `scripts/verify-release-locally.sh` (or
> `.ps1` on Windows) manually before tagging. The four workflows that
> actually run automatically are listed in
> [docs/DOC_MAP.md](../docs/DOC_MAP.md). Use
> [.github/RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) as your operational
> checklist.
>
> This file is preserved as a design reference.

# Release Workflow - Quick Reference

A condensed guide for quick reference during releases.

## Before Release

### 1. Pre-Release Checklist
- [ ] All changes merged to main branch
- [ ] CHANGELOG.md updated (if applicable)
- [ ] Version numbers bumped where needed
- [ ] All CI checks passing on main

### 2. Run Local Verification

**Linux/macOS:**
```bash
./scripts/verify-release-locally.sh
```

**Windows:**
```powershell
.\scripts\verify-release-locally.ps1
```

**Expected time:** 5-10 minutes

### 3. Create and Push Tag

```bash
# Create annotated tag
git tag -a v1.0.0 -m "Release version 1.0.0"

# Verify tag
git tag -l v1.0.0 -n

# Push tag to trigger release
git push origin v1.0.0
```

## During Release

### Monitor CI

> **Note:** There is no automated `release.yml` workflow. After pushing the
> tag, verify manually:

1. Confirm the four existing workflows are green on `main` before tagging:
   - [Actions tab](../../actions) → `Command Contract` (last push)
   - `Dependency Review` (last relevant PR)
   - `Frontend` (last push touching frontend/sdk/config)
   - `Soroban Contracts` (last push touching soroban/)
2. Confirm `scripts/verify-release-locally.sh` (or `.ps1`) passed locally
   before you ran `git push origin <tag>`.
3. If you have a Docker build configured outside this repo, verify the
   resolver image is published after the tag is pushed.

## If Something Fails

### Quick Diagnosis

**Compilation Errors:**
```bash
pnpm --filter @wafflefinance/contracts compile
```

**Test Failures:**
```bash
pnpm --filter @wafflefinance/contracts test
pnpm --filter @wafflefinance/sdk test
```

**Type Errors:**
```bash
pnpm --filter @wafflefinance/sdk exec tsc --noEmit
```

**Missing Artifacts:**
```bash
ls contracts/artifacts/contracts/
ls packages/sdk/dist/
```

### Recovery Steps

1. **Fix the issue** in code
2. **Verify locally:**
   ```bash
   ./scripts/verify-release-locally.sh
   ```
3. **Delete failed tag:**
   ```bash
   git tag -d v1.0.0
   git push origin :refs/tags/v1.0.0
   ```
4. **Commit fix and re-tag:**
   ```bash
   git commit -am "Fix release issue"
   git push origin main
   git tag -a v1.0.0 -m "Release version 1.0.0"
   git push origin v1.0.0
   ```

## After Release

### 1. Verify npm-published packages
```bash
npm view @wafflefinance/sdk
npm view @wafflefinance/contracts
```

### 2. Verify Vercel deployment
Check the Vercel dashboard to confirm the frontend build completed for the
tagged commit.

### 3. Create GitHub Release (Optional)
1. Go to [Releases](../../releases)
2. Click "Draft a new release"
3. Select the tag
4. Attach the verification report
5. Add release notes
6. Publish

## Verification Details

### Contract Artifacts Checksum
- **What:** SHA-256 hash of all compiled contract JSON files
- **Where:** Workflow logs → `verify-artifacts` → `Generate contract artifact checksums`
- **Use:** Verify integrity of published contracts

### SDK Package Checksum  
- **What:** SHA-256 hash of all built SDK files
- **Where:** Workflow logs → `verify-artifacts` → `Generate SDK package checksums`
- **Use:** Verify integrity of published SDK package

### Release Report
- **What:** Comprehensive verification summary
- **Where:** Workflow artifacts → `release-verification-report`
- **Retention:** 365 days
- **Use:** Audit trail and release documentation

## Common Issues

| Issue | Cause | Fix |
|-------|-------|-----|
| Hardhat compilation fails | Syntax error in Solidity | Fix contract code |
| Foundry compilation fails | Missing dependencies | Run `pnpm install` |
| Tests fail | Code regression | Fix failing tests |
| Missing SDK exports | Build configuration issue | Check `tsconfig.json` |
| Import errors | Circular dependencies | Refactor imports |
| Type errors | TypeScript issues | Fix type errors |
| Large package warning | Bundled dependencies | Check `dependencies` vs `devDependencies` |

## Emergency Contacts

- **CI Issues:** Check the `workflows/` directory alongside this file for the four real workflows
- **Documentation:** See [RELEASE_PROCESS.md](RELEASE_PROCESS.md)
- **Scripts:** See [scripts/README.md](../scripts/README.md)
- **Support:** Open GitHub issue with `release` label

## Workflow File Locations

> **Note:** The workflow files listed in the original design below (`release.yml`,
> `ci.yml`, `contracts.yml`) do not exist. The actual workflows are listed in
> [docs/DOC_MAP.md](../docs/DOC_MAP.md).

```
.github/
├── workflows/
│   ├── command-contract.yml   ← REAL: validates docs/COMMANDS.md on every push/PR
│   ├── dep-review.yml         ← REAL: CVE/licence scan on dependency changes
│   ├── frontend.yml           ← REAL: Vitest + typecheck + lint for frontend
│   └── soroban-contracts.yml  ← REAL: cargo test for Soroban contracts
│
│   (the following do NOT exist — design reference only)
│   ├── release.yml            ← NOT COMMITTED
│   ├── ci.yml                 ← NOT COMMITTED
│   └── contracts.yml          ← NOT COMMITTED
│
├── RELEASE_PROCESS.md         ← Archival: describes release.yml design
├── RELEASE_QUICK_REFERENCE.md ← Archival: this file
├── RELEASE_ENHANCEMENTS.md    ← Archival: describes release.yml design
└── RELEASE_CHECKLIST.md       ← CURRENT: use this for actual releases

scripts/
├── verify-release-locally.sh  ← CURRENT: bash verification script
├── verify-release-locally.ps1 ← CURRENT: PowerShell verification script
└── README.md                  ← Scripts documentation
```

## Release Workflow Diagram

```
┌─────────────────┐
│  Push Tag v1.0.0│
└────────┬────────┘
         │
         ▼
┌─────────────────────────────┐
│    verify-artifacts         │
│  ┌─────────────────────┐   │
│  │ Contract Verification│   │
│  │ • Hardhat compile    │   │
│  │ • Foundry compile    │   │
│  │ • Run tests          │   │
│  │ • Generate checksums │   │
│  └─────────────────────┘   │
│  ┌─────────────────────┐   │
│  │   SDK Verification   │   │
│  │ • Build package      │   │
│  │ • Verify exports     │   │
│  │ • Run tests          │   │
│  │ • Generate checksums │   │
│  └─────────────────────┘   │
│  ┌─────────────────────┐   │
│  │ Workspace Verification│  │
│  │ • Build all packages │   │
│  │ • Type check all     │   │
│  └─────────────────────┘   │
└────────┬────────────────────┘
         │ ✓ All checks pass
         ▼
┌─────────────────────────────┐
│     resolver-docker         │
│  • Build Docker image       │
│  • Push to GHCR             │
└─────────────────────────────┘
```

## Tips

✅ **DO:**
- Run local verification before pushing tags
- Review workflow logs if issues occur
- Keep verification reports for audit trail
- Monitor package size over time
- Document any manual steps taken

❌ **DON'T:**
- Skip local verification
- Force-push over failed release tags
- Ignore warnings (size, tests, etc.)
- Rush releases without reviewing changes
- Release without updating CHANGELOG

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-06-26 | Initial release with comprehensive verification |

---

**Need more details?** See [RELEASE_PROCESS.md](RELEASE_PROCESS.md)
