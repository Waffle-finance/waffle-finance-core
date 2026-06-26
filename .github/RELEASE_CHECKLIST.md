# Release Checklist

Use this checklist when preparing a release.

## Pre-Release

### Code Quality
- [ ] All changes merged to main branch
- [ ] All CI checks passing on main
- [ ] No known critical bugs
- [ ] Breaking changes documented

### Documentation
- [ ] CHANGELOG.md updated (if applicable)
- [ ] README.md updated if features changed
- [ ] API documentation updated
- [ ] Migration guide created (for breaking changes)

### Version Updates
- [ ] Package versions bumped appropriately
- [ ] Version follows semantic versioning (semver)
- [ ] Contract versions updated if changed
- [ ] All interdependent package versions synchronized

## Local Verification

### Run Verification Script
**Linux/macOS:**
```bash
./scripts/verify-release-locally.sh
```

**Windows:**
```powershell
.\scripts\verify-release-locally.ps1
```

### Script Should Pass:
- [ ] Contract compilation (Hardhat)
- [ ] Contract compilation (Foundry)
- [ ] All Hardhat tests
- [ ] All Foundry tests
- [ ] SDK build
- [ ] SDK export validation
- [ ] SDK import testing
- [ ] All workspace packages build
- [ ] All TypeScript checks
- [ ] Artifact checksums generated

## Create Release

### Tag Creation
```bash
# Format: v{major}.{minor}.{patch}
git tag -a v1.0.0 -m "Release version 1.0.0: Brief description"
```

- [ ] Tag follows format: `v{major}.{minor}.{patch}`
- [ ] Tag message is descriptive
- [ ] Tag is annotated (not lightweight)

### Push Tag
```bash
git push origin v1.0.0
```

- [ ] Tag pushed to origin
- [ ] Release workflow triggered

## Monitor CI

### GitHub Actions
- [ ] Navigate to Actions tab
- [ ] Find release workflow run
- [ ] Monitor `verify-artifacts` job (~20-30 min)
- [ ] Check all 30 verification steps pass
- [ ] Monitor `resolver-docker` job
- [ ] Verify Docker image published

### If Failure Occurs
- [ ] Review workflow logs
- [ ] Identify failing step
- [ ] Fix issue locally
- [ ] Re-run local verification
- [ ] Delete failed tag (local + remote)
- [ ] Re-create and push tag

## Post-Release

### Verify Artifacts
- [ ] Download `contract-artifacts` from workflow
- [ ] Download `sdk-build-artifacts` from workflow
- [ ] Download `release-verification-report` from workflow
- [ ] Verify checksums in report
- [ ] Spot-check key artifacts

### Docker Image
- [ ] Image published to GHCR
- [ ] Image tagged with version
- [ ] Image tagged with semver patterns
- [ ] Test image runs correctly

### GitHub Release (Optional)
- [ ] Create GitHub Release from tag
- [ ] Attach verification report
- [ ] Add release notes
- [ ] Mention breaking changes
- [ ] Link to documentation
- [ ] Publish release

### Communication
- [ ] Announce release (if needed)
- [ ] Update deployment docs
- [ ] Notify stakeholders
- [ ] Update project status

## Verification Checksums

Record checksums for audit trail:

**Release Version:** _____________

**Commit SHA:** _____________

**Contract Artifacts Checksum:**
```
_____________________________________________________________
```

**SDK Package Checksum:**
```
_____________________________________________________________
```

**Workflow Run URL:**
```
_____________________________________________________________
```

**Docker Image Tags:**
```
_____________________________________________________________
```

## Rollback Plan (If Needed)

### If Issues Discovered After Release
1. [ ] Assess severity and impact
2. [ ] Create hotfix branch from tag
3. [ ] Apply minimal fix
4. [ ] Follow full release process for hotfix
5. [ ] Communicate issue and fix to users

### If Need to Unpublish
- [ ] Retract GitHub Release
- [ ] Delete/deprecate Docker image tags
- [ ] Communicate status to users
- [ ] Document root cause

## Sign-Off

**Prepared by:** _____________

**Date:** _____________

**Approved by:** _____________

**Date:** _____________

---

**Note:** All checkboxes should be checked before considering release complete.

For detailed information, see [RELEASE_PROCESS.md](RELEASE_PROCESS.md)
