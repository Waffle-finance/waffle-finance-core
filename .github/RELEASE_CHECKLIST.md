# Release Checklist

> **Owner:** Engineering team  
> **Status:** Current — use this for all releases.  
> **Related docs:**
> - [RELEASE_POLICY.md](../RELEASE_POLICY.md) — versioning policy and publish mechanics
> - [docs/RELEASE_CONTRACT.md](../docs/RELEASE_CONTRACT.md) — per-package build contract and verification gaps
> - [docs/RELEASE_CHECKLIST_MULTI_PACKAGE.md](../docs/RELEASE_CHECKLIST_MULTI_PACKAGE.md) — cross-package impact matrix

There is **no automated release workflow** in this repository. Publishing is a
manual step. This checklist is your gate; work through every section before
pushing a release tag.

---

## 1. Cross-package impact assessment

Before touching any other step, identify which packages are affected by this
release and run the appropriate per-package checks from
[docs/RELEASE_CHECKLIST_MULTI_PACKAGE.md](../docs/RELEASE_CHECKLIST_MULTI_PACKAGE.md).

- [ ] Completed the cross-package impact matrix in
  `docs/RELEASE_CHECKLIST_MULTI_PACKAGE.md` and identified all affected packages.
- [ ] For SDK changes: confirmed coordinator, relayer, resolver, and frontend all
  build and test cleanly against the new SDK.
- [ ] For contract changes: confirmed `deployments.testnet.json` and `env.example`
  are consistent; checksums recorded.
- [ ] For Soroban changes: confirmed TypeScript bindings regenerated (see TD-020).

---

## 2. Code quality

- [ ] All changes merged to `main`.
- [ ] No known critical bugs (check open `severity:critical` issues).
- [ ] Breaking changes documented and migration guide written (for major releases).

---

## 3. CI — all four workflows green on `main`

The four workflows that actually run automatically are:

| Workflow | What it validates | Where to check |
|---|---|---|
| `command-contract.yml` | `docs/COMMANDS.md` script contract | Actions → **Command Contract** |
| `dep-review.yml` | CVE/licence scan, dep-version alignment | Actions → **Dependency Review** |
| `frontend.yml` | Frontend Vitest (testnet + mainnet matrix), typecheck, ESLint | Actions → **Frontend** |
| `soroban-contracts.yml` | Soroban `cargo test` (unit + harness + property fuzz) | Actions → **Soroban Contracts** |

- [ ] **Command Contract** — last run on `main` is green.
- [ ] **Dependency Review** — last run on the most recent dependency-touching PR is green.
- [ ] **Frontend** — both `testnet-only` and `mainnet-enabled` matrix legs are green.
- [ ] **Soroban Contracts** — last run on `main` is green (if `soroban/` was touched).

> **Note:** There is no `release.yml`, `ci.yml`, or `contracts.yml`. The EVM
> contract tests and service builds are not run automatically on every push —
> they are covered by `scripts/verify-release-locally.sh` (step 4 below).

---

## 4. Local verification

Run the full pre-release verification script and confirm every step passes:

**Linux / macOS:**
```bash
./scripts/verify-release-locally.sh
```

**Windows:**
```powershell
.\scripts\verify-release-locally.ps1
```

The script covers (see `scripts/README.md` for the full step list):
- [ ] Hardhat contract compilation + artifact existence
- [ ] Foundry compilation + bytecode consistency with Hardhat
- [ ] Hardhat test suite
- [ ] Foundry fuzz / invariant tests
- [ ] SDK build + export path validation + import smoke test
- [ ] SDK test suite
- [ ] Full workspace build (`pnpm build`)
- [ ] TypeScript typecheck — SDK, coordinator, resolver, frontend
- [ ] Checksums generated for contract artifacts and SDK build

> **Packages not covered by `verify-release-locally.sh` today (known gaps from
> `docs/RELEASE_CONTRACT.md`):**
> - `relayer` — no build or test step in the script; run
>   `pnpm --filter @wafflefinance/relayer build` and
>   `pnpm --filter @wafflefinance/relayer test` manually.
> - `soroban` — the script checks the SDK's soroban *TypeScript* subpath but
>   does not run `stellar contract build` or `cargo test`; run those manually
>   from `soroban/` if Soroban contracts changed.
> - `coordinator`, `resolver`, `frontend` — typechecked only; also run their
>   full build and test suite manually:
>   `pnpm --filter @wafflefinance/coordinator build && pnpm --filter @wafflefinance/coordinator test`
>   (repeat for `relayer`, `resolver`, `frontend`).

- [ ] `verify-release-locally.sh` / `.ps1` passed with no errors.
- [ ] Relayer build + tests verified manually (if relayer was changed).
- [ ] Soroban contracts built + tested manually (if `soroban/` was changed).
- [ ] Full build + tests run for all other affected services.

---

## 5. Documentation

- [ ] `CHANGELOG.md` updated with release notes (if applicable).
- [ ] `README.md` updated if user-facing behaviour changed.
- [ ] API documentation updated for any changed public interfaces.
- [ ] Migration guide written for any breaking changes.
- [ ] `docs/TECHNICAL_DEBT.md` updated — mark resolved items ✅, add any new debt discovered.
- [ ] `docs/DOC_MAP.md` updated if new documentation files were added.

---

## 6. Version and manifest

- [ ] All package versions bumped consistently (`pnpm version X.Y.Z -ws`).
- [ ] Version follows semantic versioning per `RELEASE_POLICY.md`.
- [ ] `pnpm validate:manifests` passes (names, versions, export paths in sync).
- [ ] `pnpm validate:commands` passes (script contract still enforced).
- [ ] `soroban/Cargo.toml` workspace version updated if Soroban contracts changed.

---

## 7. Create and push the tag

```bash
# Annotated tag — include a brief summary of what changed
git tag -a v1.0.1 -m "Release v1.0.1: brief description of changes"

# Verify before pushing
git tag -l v1.0.1 -n

# Push
git push origin v1.0.1
```

- [ ] Tag follows format `v{major}.{minor}.{patch}`.
- [ ] Tag message is descriptive.
- [ ] Tag pushed to origin.

---

## 8. Post-release verification

### npm-published packages
```bash
npm view @wafflefinance/sdk
npm view @wafflefinance/contracts
```
- [ ] `@wafflefinance/sdk` shows the new version on npm.
- [ ] `@wafflefinance/contracts` shows the new version on npm.

### Vercel (frontend)
- [ ] Vercel dashboard shows a successful deployment for the tagged commit.

### Docker images (relayer / resolver)
- [ ] Resolver Docker image published (if built externally).
- [ ] Image runs correctly (`docker run <image> --version` or equivalent health check).

### GitHub Release (optional but recommended)
- [ ] Draft a GitHub Release from the tag.
- [ ] Add release notes (copy from `CHANGELOG.md`).
- [ ] Note any breaking changes and link to the migration guide.
- [ ] Publish the release.

---

## 9. Communication

- [ ] Announce the release to stakeholders (if applicable).
- [ ] Update any deployment or integration documentation that references a
  specific version.

---

## Rollback plan

If a critical issue is found after the tag is pushed:

1. Create a hotfix branch from the release tag:
   ```bash
   git checkout -b hotfix/v1.0.2 v1.0.1
   ```
2. Apply the minimal fix and run through this checklist again.
3. Tag the hotfix release (`v1.0.2`).
4. If the npm packages were already published and are broken, unpublish within
   72 hours (npm allows this) and republish the corrected version:
   ```bash
   npm unpublish @wafflefinance/sdk@1.0.1
   ```
5. Document the root cause and add a post-mortem entry under `docs/postmortem/`.

---

## Sign-off

**Prepared by:** _________________________________  
**Date:** _________________________________  
**Approved by:** _________________________________  
**Date:** _________________________________

Release tag pushed: _______________  
SDK version on npm confirmed: ☐  
Frontend Vercel deploy confirmed: ☐
