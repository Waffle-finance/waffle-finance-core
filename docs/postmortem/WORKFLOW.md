# Postmortem Workflow

This document describes the end-to-end process for writing and reviewing incident postmortems at WaffleFinance. The goal is to produce a clear account of what happened, why it happened, and what the team will do to prevent it from happening again.

Postmortems are **blameless**. The objective is to understand systemic failures, not to assign fault to individuals.

---

## Table of contents

- [When a postmortem is required](#when-a-postmortem-is-required)
- [Roles](#roles)
- [Phase 1 — Trigger](#phase-1--trigger)
- [Phase 2 — Draft](#phase-2--draft)
- [Phase 3 — Review](#phase-3--review)
- [Phase 4 — Merge and track](#phase-4--merge-and-track)
- [Phase 5 — Follow-up](#phase-5--follow-up)
- [Postmortem quality bar](#postmortem-quality-bar)
- [Timeline of deadlines](#timeline-of-deadlines)
- [Relationship to bug triage](#relationship-to-bug-triage)
- [File naming and location](#file-naming-and-location)

---

## When a postmortem is required

A postmortem **must** be written for every:

- **SEV-1** incident (funds at risk, all refund layers down, active data loss)
- **SEV-2** incident (core swap path down, coordinator or relayer offline, one refund layer non-functional)

A postmortem **should** be written for:

- Any **SEV-3** incident that persisted longer than 4 hours
- Any significant regression that required a hotfix deploy
- Any incident that prompted user complaints about fund safety

When unsure, write the postmortem. A short postmortem for a minor incident causes no harm; a missing postmortem for a major incident leaves the team without a record.

See [Bug Triage — Severity levels](../BUG_TRIAGE.md#severity-levels) for severity definitions.

---

## Roles

| Role | Responsibilities |
|---|---|
| **Incident commander** | Coordinates the live response; opens the postmortem issue; assigns the author |
| **Author** | Writes the postmortem draft; owns it through merge |
| **Reviewers** | At least two — one from the responding team, one from outside |
| **Action item owners** | Individuals assigned to specific follow-up issues; not the author unless they volunteer |

The incident commander is typically the on-call engineer who managed the incident. The author is often the incident commander, but can be any team member with sufficient context.

---

## Phase 1 — Trigger

**Within 24 hours of incident resolution:**

1. The incident commander opens a GitHub issue titled `postmortem: <YYYY-MM-DD> <short description>` and applies the labels `postmortem-required` and the incident's severity label.

2. The incident commander assigns an author.

3. The author creates a branch:
   ```bash
   git checkout -b postmortem/YYYY-MM-DD-<short-slug>
   ```

4. The author copies the template:
   ```bash
   cp docs/postmortem/TEMPLATE.md \
      docs/postmortem/YYYY-MM-DD-<short-slug>.md
   ```

5. The author fills in what is already known: timeline events logged during the incident, the initial impact assessment, and names of responders.

---

## Phase 2 — Draft

**Within five business days of incident resolution:**

The author completes the postmortem document. Use the [template](TEMPLATE.md) as a checklist — every section must be present and substantive.

### Gathering data

Pull the raw material from these sources:

- **Coordinator and relayer logs** — timestamps, error messages, stack traces
  ```bash
  # Filter coordinator logs for the incident window
  jq 'select(.time >= "2026-06-30T06:00:00Z" and .time <= "2026-06-30T10:00:00Z")' \
    coordinator.log

  # Find RPC errors
  jq 'select(.level=="warn" and (.msg | contains("RPC")))' coordinator.log

  # Find stuck orders
  jq 'select(.status=="src_locked")' orders-export.json
  ```

- **On-chain state** — block explorers for transaction hashes and HTLC events
  ```bash
  # Check Ethereum HTLC events for a specific hashlock
  curl "$ETH_HTLC_ESCROW_TESTNET/events?hashlock=<hashlock>"

  # Check Stellar HTLC events
  curl "$STELLAR_HORIZON_URL/contracts/$SOROBAN_HTLC/events"
  ```

- **Health dashboard** — [HEALTH_DASHBOARD.md](../HEALTH_DASHBOARD.md) and Prometheus metrics at `/metrics`
- **Monitoring alerts** — alert history from the monitoring system
- **Communication logs** — Slack threads, GitHub comments from the incident window
- **Git history** — recent commits and deploys that preceded the incident

### Writing the root cause

A good root cause statement answers three questions:

1. What specific component or code path failed?
2. Why was that component in a state where it could fail?
3. Why did the monitoring or process not catch it sooner?

Avoid root causes that blame a person. "The engineer deployed a bad config" is not a root cause. "The deployment process did not validate `ETHEREUM_RPC_URL` before applying" is.

### Writing action items

Every action item must:

- Be specific and achievable (not "improve monitoring")
- Have a single named owner
- Have a due date
- Be tracked as a GitHub issue linked from the postmortem

Action items fall into three categories:

| Category | Examples |
|---|---|
| **Prevent** | Fix the bug; add input validation; add a circuit breaker |
| **Detect sooner** | Add an alert; improve log verbosity; add a health check |
| **Respond faster** | Add a runbook entry in [OPERATIONS.md](../OPERATIONS.md); automate a manual step |

---

## Phase 3 — Review

**Once the draft is complete:**

1. The author opens a pull request targeting `main`:
   - Title: `postmortem: YYYY-MM-DD <short description>`
   - Body: link to the postmortem tracking issue; summary of the incident
   - Assign at least two reviewers — one from the responding team, one peer reviewer

2. Reviewers check the [postmortem quality bar](#postmortem-quality-bar) below.

3. The author addresses all review comments. The PR should not sit open longer than three business days after reviewers are assigned.

4. When both reviewers approve, the incident commander (or any maintainer) merges.

---

## Phase 4 — Merge and track

Once the postmortem PR is merged:

1. Close the postmortem tracking issue.
2. Verify that every action item has a corresponding open GitHub issue.
3. Add the action items to the relevant milestone or project board.
4. If any action item touches a known failure mode covered by the incident response runbooks in [OPERATIONS.md](../OPERATIONS.md), update the runbook immediately — do not wait for the action item issue to be resolved.

---

## Phase 5 — Follow-up

**30 days after the postmortem is merged:**

The incident commander or team lead reviews the open action items:

- Are any overdue?
- Have any been closed without the fix being deployed?
- Are there action items that have become stale because circumstances changed?

Escalate overdue SEV-1 or SEV-2 action items to the team lead. Stale or de-scoped items should be explicitly closed with a comment explaining why.

---

## Postmortem quality bar

A postmortem is ready to merge when all of the following are true:

- [ ] All template sections are present and non-empty
- [ ] Timeline uses UTC timestamps and covers the full incident window
- [ ] Root cause is specific — it identifies the component, code path, or config that failed
- [ ] Impact is quantified where possible (orders affected, duration, chains affected)
- [ ] Each action item has an owner, a due date, and a linked GitHub issue
- [ ] No secrets, private keys, or PII appear in the document
- [ ] Instructional callouts (`>` lines) from the template have been removed
- [ ] At least two reviewers have approved the PR

---

## Timeline of deadlines

| Milestone | Deadline |
|---|---|
| Postmortem issue opened; author assigned | Within 24 h of incident resolution |
| Draft completed by author | Within 5 business days of incident resolution |
| PR reviewed and merged | Within 8 business days of incident resolution |
| Action items tracked in project board | Same day as merge |
| First follow-up review of action items | 30 days after merge |

---

## Relationship to bug triage

Postmortems and bug triage are complementary:

- **Bug triage** ([BUG_TRIAGE.md](../BUG_TRIAGE.md)) governs how incoming reports are classified and routed during an active incident.
- **Postmortem workflow** (this document) governs what happens after the incident is resolved.

The triage process triggers the postmortem: when a SEV-1 or SEV-2 issue is closed, the `postmortem-required` label should be present and the incident commander should have opened the postmortem tracking issue before closing the incident issue.

If a bug report escalates to SEV-1 during triage, consult the incident response runbooks in [OPERATIONS.md](../OPERATIONS.md#incident-response) first to contain the incident, then return here to initiate the postmortem.

---

## File naming and location

All postmortem documents live under `docs/postmortem/`:

```
docs/postmortem/
  TEMPLATE.md                            ← the blank template
  WORKFLOW.md                            ← this document
  examples/
    2026-06-30-example-htlc-incident.md  ← worked example
  YYYY-MM-DD-<short-slug>.md             ← real postmortems go here
```

**Naming convention:** `YYYY-MM-DD-<short-slug>.md`

- Use the date the incident was detected (not the resolution date).
- Keep the slug under 40 characters: lowercase, hyphen-separated, no spaces.
- Examples: `2026-06-30-stellar-htlc-refund-broken.md`, `2026-07-15-coordinator-db-migration-failure.md`
