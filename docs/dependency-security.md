# Dependency Security Automation

This repository now includes automated security checks for dependency updates.

## What is checked?
- **Vulnerability scan**: `pnpm audit` runs on every pull request and generates an `audit-report.json` artifact.
- **Lockfile validation**: The CI job verifies that `pnpm-lock.yaml` is up‑to‑date with the changes introduced by a PR.

## How to interpret CI results
- The **Dependency Security Scan** job will **fail** if the lockfile is out of sync or if high/critical findings are reported.
- The generated `dependency-audit-report` artifact can be downloaded from the GitHub Actions UI. It contains the full JSON output from `pnpm audit`.

## Approving or rejecting updates
1. Review the audit report artifact.
2. If the report contains only low/moderate findings and the lockfile is consistent, you may merge the PR.
3. If high/critical vulnerabilities are present, update the dependency version to a safe one or apply a mitigation before merging.

## FAQ
**Q:** Can I skip the scan for a trusted dependency?
**A:** Use the `skip-ci` label on the PR and add a comment explaining why the scan is not required. The job will still run but can be overridden manually by a maintainer.

---
*This document is part of the security guardrails introduced to reduce supply‑chain risk.*
