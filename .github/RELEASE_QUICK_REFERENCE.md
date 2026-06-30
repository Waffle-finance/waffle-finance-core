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

### Monitor Workflow
1. Go to [Actions](../../actions) tab
2. Find your release workflow run
3. Watch the `verify-artifacts` job (takes ~20-30 minutes)

### Expected Steps
```
verify-artifacts (30 steps)
├── Setup environment (4 steps)
├── Contract verification (6 steps)
├── SDK verification (6 steps)
├── Workspace verification (2 steps)
└── Report generation (2 steps)

resolver-docker (7 steps)
└── Build and push Docker image
```

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

### 1. Verify Release Artifacts
```bash
# Go to Actions → Select workflow run → Artifacts section
# Download and inspect:
# - contract-artifacts
# - sdk-build-artifacts  
# - release-verification-report
```

### 2. Verify Docker Image
```bash
# Check image was published
docker pull ghcr.io/OWNER/wafflefinance-resolver:v1.0.0

# Verify image works
docker run ghcr.io/OWNER/wafflefinance-resolver:v1.0.0 --version
```

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

- **CI Issues:** Check [workflow file](.github/workflows/release.yml)
- **Documentation:** See [RELEASE_PROCESS.md](RELEASE_PROCESS.md)
- **Scripts:** See [scripts/README.md](../scripts/README.md)
- **Support:** Open GitHub issue with `release` label

## Workflow File Locations

```
.github/
├── workflows/
│   ├── release.yml          ← Main release workflow
│   ├── ci.yml               ← Continuous integration
│   └── contracts.yml        ← Contract-specific checks
├── RELEASE_PROCESS.md       ← Detailed documentation
├── RELEASE_QUICK_REFERENCE.md ← This file
└── RELEASE_ENHANCEMENTS.md  ← Implementation details

scripts/
├── verify-release-locally.sh  ← Bash verification script
├── verify-release-locally.ps1 ← PowerShell verification script
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
