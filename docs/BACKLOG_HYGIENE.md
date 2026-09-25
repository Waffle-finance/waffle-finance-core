# Backlog Hygiene Process

> **Last updated:** 2026-09-23
> **Maintainer:** Engineering team lead
> **Related docs:** [docs/TECHNICAL_DEBT.md](TECHNICAL_DEBT.md), [docs/MAINTENANCE_CALENDAR.md](MAINTENANCE_CALENDAR.md), [docs/BUG_TRIAGE.md](BUG_TRIAGE.md), [.github/PULL_REQUEST_TEMPLATE.md](../.github/PULL_REQUEST_TEMPLATE.md)

WaffleFinance is multi-chain, multi-service, and pre-mainnet. Its issue backlog
carries protocol-level risks (settlement bugs, key management gaps), operational
gaps (missing runbooks, config drift), and feature work across five active
services. Without a hygiene process, issues become stale, vaguely scoped,
unowned, or invisible to the engineers who need them.

This document defines issue quality standards, templates, ownership, prioritisation,
stale-issue handling, and the review cadence that keeps the backlog actionable.

---

## Table of Contents

- [Issue quality standards](#issue-quality-standards)
- [Issue types and templates](#issue-types-and-templates)
  - [Bug report](#bug-report)
  - [Operational task](#operational-task)
  - [Feature / improvement](#feature--improvement)
  - [Technical debt](#technical-debt)
  - [Security advisory](#security-advisory)
- [Ownership policy](#ownership-policy)
- [Prioritisation framework](#prioritisation-framework)
- [Triage process](#triage-process)
- [Stale-issue handling](#stale-issue-handling)
- [Backlog review cadence](#backlog-review-cadence)
- [Labelling taxonomy](#labelling-taxonomy)
- [Linking to architecture and runtime context](#linking-to-architecture-and-runtime-context)

---

## Issue quality standards

Every issue in the backlog must meet these minimum standards before it can be
assigned or moved to a sprint.

### Required for all issues

1. **Title is actionable.** The title states what must happen, not what is
   broken in the abstract.
   - Bad: `Relayer issues`
   - Good: `Relayer safety deposit calc uses hardcoded ETH/USD = $3500 instead of live price`

2. **Scope is bounded.** One issue addresses one problem or one deliverable.
   If an issue requires changes in > 3 files across > 2 services, it should
   be split unless the changes are tightly coupled by design.

3. **Acceptance criteria are explicit.** The issue must state what "done"
   means in testable terms. "Improve reliability" is not an acceptance
   criterion. "The coordinator starts in ≤ 5 seconds on a cold SQLite
   database with no existing migrations" is.

4. **Service and component are identified.** Each issue must identify the
   affected service(s) (coordinator, relayer, resolver, frontend, contracts,
   soroban, sdk) either in the title, a label, or the first paragraph.

5. **Severity is labelled.** Every issue must carry a severity label
   (`severity:critical`, `severity:high`, `severity:medium`, `severity:low`)
   using the definitions in [docs/BUG_TRIAGE.md](BUG_TRIAGE.md). If the issue
   is not a bug (e.g. a feature or operational task), the `type:` label
   replaces the severity label.

6. **Owner is assigned within 5 business days of opening.** Unassigned
   issues older than 5 days are escalated in the weekly triage meeting.

### Not required but strongly recommended

- A link to the relevant source file or line in the repository
- A reference to the related technical debt entry in `docs/TECHNICAL_DEBT.md`
  (for debt items) or operational runbook (for ops tasks)
- A "related issues" section listing blockers or dependents

---

## Issue types and templates

Use the appropriate template when opening a new issue. Templates are reproduced
below for reference; they are also available in GitHub's issue creation flow.

---

### Bug report

Use for: unexpected behavior, contract invariant violations, security issues,
data integrity problems, or service crashes.

```markdown
## Bug Report

**Service / component:** <!-- coordinator / relayer / resolver / frontend / contracts / soroban / sdk -->
**Severity:** <!-- critical / high / medium / low — see docs/BUG_TRIAGE.md -->
**Discovered:** <!-- date -->
**Reporter:** <!-- GitHub handle -->

### Summary

<!-- One-paragraph description of the unexpected behavior. -->

### Steps to reproduce

1. ...
2. ...
3. ...

### Expected behavior

<!-- What should happen. -->

### Actual behavior

<!-- What does happen. Include log excerpts, error messages, or tx hashes. -->

### Impact

<!-- Who is affected and how. Does it put user funds at risk?
     Refer to docs/BUG_TRIAGE.md for severity definitions. -->

### Environment

- Network: <!-- testnet / devnet / local -->
- Service version / git SHA: <!-- e.g. v1.0.0 / abc1234 -->
- Relevant env vars (values REDACTED): <!-- e.g. NETWORK_MODE=testnet, SECRET_STORAGE_KEY=set -->

### Proposed fix (optional)

<!-- If you already know what should change, describe it here.
     Link to the relevant source file or function. -->

### Acceptance criteria

- [ ] ...
- [ ] ...

### Related

- Technical debt entry: <!-- e.g. TD-041 -->
- Related issues: <!-- #N -->
- Relevant doc: <!-- e.g. docs/OPERATIONS.md -->
```

---

### Operational task

Use for: runbook gaps, missing health checks, docs drift, config gaps,
maintenance calendar items, or environment parity issues.

```markdown
## Operational Task

**Service / component:** <!-- affected service(s) or "platform-wide" -->
**Category:** <!-- runbook / health-check / config / docs / environment-parity / other -->
**Discovered:** <!-- date or maintenance review reference (e.g. M-01 2026-10-05) -->
**Owner:** <!-- GitHub handle — must be assigned within 5 business days -->

### Problem

<!-- What operational gap exists? Be specific. Refer to the drift type from
     docs/DRIFT_DETECTION_RUNBOOK.md if applicable. -->

### Work to be done

<!-- Describe the concrete changes required: which docs to update, which scripts
     to create, which env vars to add, etc. -->

### Acceptance criteria

- [ ] ...
- [ ] ...

### Expected output / verification

<!-- How will we confirm this task is complete?
     e.g. "Running the doc-link check returns zero broken links" or
     "Prometheus alert ListenerLagHigh fires when lag > 100 blocks" -->

### Related

- Maintenance calendar task: <!-- e.g. BW-02 -->
- Quality gate check: <!-- e.g. QUALITY_GATE.md check #3 -->
- Related issues: <!-- #N -->
```

---

### Feature / improvement

Use for: new capabilities, protocol improvements, UX enhancements, or SDK
additions.

```markdown
## Feature / Improvement

**Service / component:** <!-- affected service(s) -->
**Type:** <!-- feature / improvement / refactor -->
**Priority:** <!-- P0 / P1 / P2 / P3 — see Prioritisation framework -->

### User story

As a **[role]**, I want **[capability]** so that **[outcome]**.

### Background

<!-- Why is this needed? What problem does it solve?
     Reference architecture doc or technical debt entry if relevant. -->

### Proposed solution

<!-- High-level design. If the implementation is uncertain, describe
     the options and which one is preferred. -->

### Out of scope

<!-- Explicitly state what this issue does NOT cover. -->

### Acceptance criteria

- [ ] ...
- [ ] ...

### Implementation notes

<!-- Any constraints: backward compatibility, security considerations,
     performance requirements. -->

### Related

- Architecture section: <!-- docs/ARCHITECTURE.md #section -->
- Technical debt: <!-- TD-XXX -->
- Blocking issues: <!-- #N -->
- Blocked by: <!-- #N -->
```

---

### Technical debt

Use for: issues added to or tracked from `docs/TECHNICAL_DEBT.md`. Technical
debt issues should mirror the register entry.

```markdown
## Technical Debt: [TD-XXX] [Title]

**Register entry:** [docs/TECHNICAL_DEBT.md#TD-XXX](../docs/TECHNICAL_DEBT.md)
**Service:** <!-- service -->
**Severity:** <!-- 🔴 HIGH / 🟡 MED / 🟢 LOW -->
**Discovered:** <!-- date -->
**Owner:** <!-- GitHub handle or "unowned" -->

### Context

<!-- Copy the "Context" paragraph from the register entry. -->

### Impact

<!-- Copy the "Impact" paragraph from the register entry. -->

### Next steps (from register)

<!-- Copy the "Next steps" from the register entry. -->

### Acceptance criteria

- [ ] ...

### Notes

<!-- Any additional context not in the register entry. -->
```

---

### Security advisory

Use for: CVE responses, key compromise, contract vulnerability disclosures, or
supply chain issues. **Do not open publicly if the issue is not yet disclosed.**
Use GitHub's "Report a vulnerability" flow for pre-disclosure items.

```markdown
## Security Advisory

**Severity:** <!-- critical / high / medium / low -->
**CVE / advisory ID:** <!-- if public -->
**Affected component:** <!-- package name, contract, service -->
**Affected versions:** <!-- version range -->
**Disclosure status:** <!-- pre-disclosure / disclosed / patched -->

### Summary

<!-- Non-exploitative description of the issue. -->

### Impact

<!-- Who is at risk? Are user funds at risk? -->

### Mitigation

<!-- Immediate mitigations available before a full fix. -->

### Fix plan

<!-- How will this be resolved? Target version? -->

### Acceptance criteria

- [ ] Patch released
- [ ] `pnpm audit` returns clean for this advisory
- [ ] Changelog and release notes document the fix

### References

<!-- CVE link, vendor advisory, or internal postmortem -->
```

---

## Ownership policy

Every issue must have exactly one owner (assignee). The owner is responsible for:

1. **Making progress** — moving the issue through triage, in-progress, review, and close
2. **Communicating blockers** — if the issue is stuck for > 5 business days, the owner
   must comment with the blocker and tag the platform lead
3. **Keeping the issue current** — updating the description and checklist as understanding evolves
4. **Linking related work** — referencing PRs that address the issue and closing it when done

### Ownership assignment rules

| Scenario | Assignment |
|---|---|
| New issue, service is clear | Lead engineer for that service |
| New issue, service is unclear | Triage meeting assigns within 5 business days |
| Owner goes on leave | Owner reassigns before leaving; if not, platform lead reassigns |
| Issue is blocked by external dependency | Owner retains assignment and adds a `blocked` label |
| Issue is unowned for > 5 business days | Escalated to engineering lead at the next triage meeting |

---

## Prioritisation framework

### Priority levels

| Level | Label | Definition | SLA for triage |
|---|---|---|---|
| P0 | `priority:p0` | Active incident or imminent fund safety risk; blocks mainnet or production | Immediate |
| P1 | `priority:p1` | Blocks a release, exposes a security gap, or degrades testnet/staging severely | Within 1 business day |
| P2 | `priority:p2` | Meaningful operational or user-facing impact; can wait for the next sprint | Within the sprint |
| P3 | `priority:p3` | Nice-to-have; developer experience; low-urgency refactor | Best-effort; reviewed monthly |

### How to assign priority

1. **Is user fund safety at risk?** → P0 regardless of environment
2. **Does this block a release?** → P1
3. **Is this a security gap (key exposure, unencrypted secrets, missing auth)?** → P1
4. **Is this operational drift that could cause a missed incident?** → P2
5. **Everything else** → P2 (if it should be addressed this sprint) or P3 (if deferrable)

### Relationship between bug severity and issue priority

Bug severity (from [docs/BUG_TRIAGE.md](BUG_TRIAGE.md)) describes the *impact
of the bug*. Issue priority describes *when to address it*. A SEV-1 bug is always
P0. A SEV-3 bug is usually P2. A SEV-4 bug may be P3. Operational tasks and
feature issues are prioritised independently of bug severity.

---

## Triage process

### Weekly triage (15 minutes, Monday)

Owned by: engineering lead or designated triage rotation.

Agenda:
1. Review all issues opened since the last triage — assign priority and owner
2. Review all issues unassigned for > 5 business days — escalate or close
3. Review all P0/P1 issues — confirm progress and unblock if needed
4. Review issues labelled `blocked` — check whether blocker is resolved

Output: all issues have an owner and priority. Any issue without an owner after
the triage meeting is escalated to the platform lead.

### Sprint planning (bi-weekly)

During sprint planning, the team:
1. Reviews all P0 and P1 issues — these are automatically considered for the sprint
2. Selects P2 issues from the backlog proportional to sprint capacity
3. Reviews one P3 item per sprint to prevent indefinite deferral

### Monthly backlog review (M-02 in the maintenance calendar)

During the monthly maintenance review:
1. Review all P3 issues — close any that are no longer relevant
2. Review all open technical debt issues — confirm register entries are current
3. Identify any issue that should be promoted (P3 → P2) or demoted (P2 → P3)
4. Archive any issue closed in the past month by marking it in `TECHNICAL_DEBT.md`
   if it was a registered debt item

---

## Stale-issue handling

An issue is **stale** if it meets any of these criteria:

| Condition | Grace period before action |
|---|---|
| No activity (comment, label change, or PR link) | 60 days |
| Open with `blocked` label and no comment from owner | 30 days |
| Open with no assignee | 5 business days |
| In-progress (assignee set) but no PR opened | 30 days |
| P3 open with no activity | 90 days |

### Stale handling actions

1. **Label `stale`:** Add the `stale` label and leave a comment requesting an
   update within 14 days. Example:

   ```
   This issue has had no activity in 60 days. If it is still relevant,
   please provide a status update or assign a new owner within 14 days.
   Otherwise it will be closed.
   ```

2. **Close:** If no response within 14 days, close the issue with label `closed:stale`
   and a comment explaining the reason.

3. **Re-open allowed:** Any issue closed as stale may be reopened if work resumes.
   The new owner must update the description and remove the `stale` label.

### Exceptions

- Issues labelled `security` are never auto-closed as stale — they must be
  explicitly resolved or accepted as a known risk.
- Issues linked to a `priority:p0` or `priority:p1` label are never auto-closed.
- Technical debt entries in `docs/TECHNICAL_DEBT.md` with `severity: HIGH` are
  never auto-closed — they may be downgraded or resolved, but must not silently
  disappear from the backlog.

---

## Backlog review cadence

| Review | Frequency | Owner | Agenda |
|---|---|---|---|
| Triage meeting | Weekly | Engineering lead | New issues, unowned issues, P0/P1 progress |
| Sprint planning | Bi-weekly | Engineering team | P0/P1 all-in, P2 selection, one P3 |
| Technical debt review | Monthly | Engineering lead | Debt register updates, HIGH item owners |
| Full backlog review | Quarterly | Engineering lead + platform lead | P3 purge, stale close, priority reassignment |

---

## Labelling taxonomy

Use these labels consistently. New labels require approval from the engineering
lead.

### Type labels

| Label | Meaning |
|---|---|
| `type:bug` | Unexpected behavior or contract invariant violation |
| `type:feature` | New capability or user-facing improvement |
| `type:operational` | Runbook, health check, docs, config, or maintenance task |
| `type:debt` | Technical debt registered in `docs/TECHNICAL_DEBT.md` |
| `type:security` | Security advisory, key management, or access control |
| `type:refactor` | Code quality improvement with no user-facing change |
| `type:release` | Release process, versioning, or artifact management |

### Severity labels (bugs only)

| Label | Meaning | Reference |
|---|---|---|
| `severity:critical` | Puts user funds at risk; active incident | BUG_TRIAGE.md SEV-1 |
| `severity:high` | Significant operational impact; blocks testnet | BUG_TRIAGE.md SEV-2 |
| `severity:medium` | Reliability or observability gap; no immediate fund risk | BUG_TRIAGE.md SEV-3 |
| `severity:low` | Minor; developer experience; non-blocking | BUG_TRIAGE.md SEV-4 |

### Priority labels

| Label | Meaning |
|---|---|
| `priority:p0` | Immediate action; fund safety or active incident |
| `priority:p1` | This sprint; release blocker or security gap |
| `priority:p2` | Upcoming sprint; meaningful impact |
| `priority:p3` | Best effort; deferrable |

### State labels

| Label | Meaning |
|---|---|
| `blocked` | Work cannot proceed; comment must describe the blocker |
| `stale` | No activity for the defined grace period |
| `needs-repro` | Bug cannot be confirmed without reproduction steps |
| `critical-deps` | PR touches audit-critical packages (set by dep-review workflow) |
| `good-first-issue` | Suitable for new contributors; scope is well-defined |

### Service labels

Use one or more: `service:coordinator`, `service:relayer`, `service:resolver`,
`service:frontend`, `service:contracts`, `service:soroban`, `service:sdk`,
`service:platform`.

---

## Linking to architecture and runtime context

Issues should link to the relevant project context so any engineer can pick up
the work without deep background knowledge.

### Linking to architecture

For issues affecting service boundaries or cross-service data flow, link to the
relevant section of [docs/ARCHITECTURE.md](ARCHITECTURE.md):

```markdown
See [Order lifecycle and event flow](../docs/ARCHITECTURE.md#order-lifecycle-and-event-flow)
for the context where this issue originates.
```

### Linking to runtime config

For issues involving environment variables or config drift, link to `env.example`
and the relevant package config:

```markdown
The affected env var is `SECRET_STORAGE_KEY`, documented in `env.example` and
validated in `packages/config/src/schema.ts` (`coordinatorConfigSchema.secretStorageKey`).
```

### Linking to operational runbooks

For issues that modify or require updates to operational procedures, link to the
relevant runbook:

```markdown
This change requires updating the `ListenerLagHigh` procedure in
[coordinator/ops/RUNBOOK.md](../coordinator/ops/RUNBOOK.md) and the alert
threshold in `coordinator/ops/coordinator-alerts.yml`.
```

### Linking to on-chain context

For contract-level issues, include the network, contract address, and relevant
transaction or block:

```markdown
- Network: Sepolia (chainId 11155111)
- Contract: HTLCEscrow @ `0xb352339BEb146f2699d28D736700B953988bB178`
- Relevant transaction: `0x...`
```

For Stellar issues, include the ledger and contract ID:

```markdown
- Network: Stellar testnet
- Contract: `CDIKSJKVMXKGBRD3BBEBMF7Q4GQJ52ECU6R6G5HEKXKXVGGWK2CTA6JK`
- Relevant transaction: `f7583c2c...`
```

### Converting operational tasks to sprint issues

When a maintenance calendar check (from [docs/MAINTENANCE_CALENDAR.md](MAINTENANCE_CALENDAR.md))
surfaces a gap, convert it to a GitHub issue using the **Operational task**
template above. Reference the maintenance task ID (e.g. `M-01 2026-10-05`) in
the issue body so the calendar record and the issue history stay linked.
