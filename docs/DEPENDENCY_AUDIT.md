# Dependency Audit

## Overview

`scripts/audit-deps.mjs` runs `pnpm audit --json` across the entire pnpm
workspace, filters the JSON report to a configurable severity threshold,
separates production dependencies from dev-only tooling, and outputs a
machine-readable triage record.

## Running Locally

```bash
# Threshold = high (default) — production deps only
node scripts/audit-deps.mjs

# Lower threshold
node scripts/audit-deps.mjs --level moderate

# Write JSON report to a file
node scripts/audit-deps.mjs --output audit-report.json

# Include dev-only advisories in the fail gate
node scripts/audit-deps.mjs --dev-only
```

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | No unresolved advisories at or above the threshold in production deps |
| `1` | One or more unresolved high-severity production advisories found |
| `2` | Audit tool failure (pnpm not installed, network error, parse error) |

## Output Format

The JSON output (via `--output`) contains two top-level keys:

```json
{
  "_meta": {
    "generatedAt": "2026-11-22T10:00:00Z",
    "threshold": "high",
    "totalAdvisories": 2,
    "unsuppressed": 1,
    "productionUnsuppressed": 1,
    "devOnlyUnsuppressed": 0
  },
  "advisories": [
    {
      "ghsa": "GHSA-xxxx-xxxx-xxxx",
      "id": 1234,
      "title": "Prototype pollution in foo",
      "severity": "high",
      "url": "https://github.com/advisories/GHSA-xxxx-xxxx-xxxx",
      "affectedPackages": ["foo"],
      "installedVersions": ["1.2.3"],
      "paths": ["coordinator > foo@1.2.3"],
      "isDevOnly": false,
      "suppressed": false,
      "suppressionEntry": null
    }
  ]
}
```

Each advisory record includes:

| Field | Description |
|-------|-------------|
| `ghsa` | GitHub Security Advisory ID (used as the suppression key) |
| `severity` | `info` / `low` / `moderate` / `high` / `critical` |
| `affectedPackages` | Package names with the vulnerability |
| `installedVersions` | Installed versions at risk |
| `paths` | Dependency paths (capped at 10 per advisory) |
| `isDevOnly` | `true` when every path leads through a devDependency root |
| `suppressed` | `true` when a valid suppression entry exists |

## Suppression File

`.audit-suppressions.json` at the repository root holds accepted or
false-positive findings. The file must be a JSON array.

### Required Fields

```json
[
  {
    "ghsa": "GHSA-xxxx-xxxx-xxxx",
    "owner": "@reviewer-handle",
    "rationale": "Why this finding is accepted or is a false-positive.",
    "expires": "2026-12-31"
  }
]
```

| Field | Rules |
|-------|-------|
| `ghsa` | Must match a real GHSA ID; this is the lookup key |
| `owner` | GitHub handle of the engineer who reviewed and accepted the risk |
| `rationale` | At least one sentence explaining why the risk is accepted |
| `expires` | ISO-8601 date (`YYYY-MM-DD`) **or** `"permanent"` for structural false-positives. An expired suppression is treated as absent — the finding reappears in the gate. |

### Adding a Suppression

1. Reproduce the finding locally: `node scripts/audit-deps.mjs`.
2. Determine whether it is a true-positive or false-positive.
3. For **false-positives** (e.g. the vulnerable code path is not reachable):
   - Use `"expires": "permanent"`.
4. For **accepted risks** (true-positive but mitigated or low-impact):
   - Set a concrete expiry date no more than 90 days out.
   - Include a mitigation note in `rationale`.
5. Open a PR that modifies **only** `.audit-suppressions.json`.
6. The PR requires at least one additional reviewer.

### Suppression Expiry

The script reads the `expires` field at runtime. When an entry has expired,
the advisory reappears as unsuppressed and fails the gate. This forces
periodic re-review of accepted risks rather than allowing them to accumulate
silently.

## CI Integration

The audit script runs as a step in the dependency review workflow
(`.github/workflows/dep-review.yml`) on every PR that changes the lockfile.
The step exits non-zero for unresolved high-severity production advisories,
blocking the PR until the advisory is resolved or a reviewed suppression is
added.

The JSON report is uploaded as a build artifact on every run so reviewers can
inspect the full advisory list without re-running the audit locally.

## Escalation Process

When the gate blocks a PR:

1. **Check if it is a false-positive** — run `pnpm audit` manually and inspect
   the vulnerable code path. If the vulnerable function is not called by any
   production code path, add a `"permanent"` suppression with a rationale note.

2. **Check if an upgrade is feasible** — run `pnpm update <package>` in a
   branch and confirm tests pass. Prefer patch/minor upgrades.

3. **If an upgrade is not immediately available** — add a time-boxed
   suppression (`expires` ≤ 90 days). Create a tracking issue to revisit
   before the expiry date.

4. **Critical-severity advisories in direct dependencies** — escalate to the
   security channel immediately; do not suppress without sign-off from two
   engineers.
