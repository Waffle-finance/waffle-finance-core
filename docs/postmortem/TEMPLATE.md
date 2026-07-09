# Incident Postmortem Template

> **How to use this template:**
> Copy the entire file to `docs/postmortem/YYYY-MM-DD-<short-slug>.md`, fill in every section, and open a PR within five business days of incident resolution. Delete instructional callouts (lines beginning with `>`) before merging.

---

## Incident overview

| Field | Value |
|---|---|
| **Title** | _One-line summary — what broke and on which system_ |
| **Date** | YYYY-MM-DD |
| **Detection time** | HH:MM UTC |
| **Resolution time** | HH:MM UTC |
| **Duration** | _e.g. 2 h 14 min_ |
| **Severity** | SEV-1 / SEV-2 / SEV-3 / SEV-4 (see [Severity definitions](#severity-definitions)) |
| **Affected systems** | _e.g. Coordinator, Relayer, HTLCEscrow (Sepolia), Stellar HTLC_ |
| **Affected chains** | _e.g. Ethereum, Stellar, Solana — or "none" if infra-only_ |
| **Incident commander** | GitHub handle |
| **Authors** | GitHub handles of everyone who contributed to this document |
| **Status** | Draft / In review / Final |

---

## Summary

> Two to four sentences. What happened, what was the user impact, and what stopped it. Write for someone who was not on-call and has no prior context.

---

## Impact

> Be specific and quantitative wherever possible.

- **Users affected:** _number or percentage of users, or "none" if impact was operational only_
- **Orders affected:** _number of orders that were stuck, failed, or at risk_
- **Funds at risk:** _amount and asset — "none" if the HTLC safety model prevented exposure_
- **Chains affected:** _list each chain and describe how it was affected_
- **Downtime:** _duration each user-facing service was degraded or unavailable_
- **Data loss:** _describe any data loss or "none"_

---

## Timeline

> List events in chronological order. Use UTC timestamps. Include the moment the incident started, when detection occurred, each significant diagnostic or remediation step, and when the incident was declared resolved.
>
> Format: `HH:MM UTC — Description of event`

| Time (UTC) | Event |
|---|---|
| HH:MM | _Earliest indicator / first anomaly detected_ |
| HH:MM | _Alert fired / incident declared_ |
| HH:MM | _First responder paged or on-call notified_ |
| HH:MM | _Hypothesis formed_ |
| HH:MM | _Mitigation step applied_ |
| HH:MM | _Impact contained_ |
| HH:MM | _Root cause confirmed_ |
| HH:MM | _Full resolution — incident declared closed_ |

---

## Root cause

> Describe the technical root cause. Be precise: what code path, configuration, or external factor caused the failure? Include any relevant contract addresses, transaction hashes, error messages, or log excerpts.

### Immediate cause

_The specific failure that triggered the incident._

### Contributing factors

_Conditions that made the failure possible or harder to detect._

1. _Factor one_
2. _Factor two_

---

## Detection

> How was the incident detected? Who or what found it first — a user report, a monitor alert, a health check, log analysis? How long after onset was it detected?

- **First signal:** _alert name, user report, log line, etc._
- **Detection lag:** _time between incident onset and detection_
- **Detector:** _person / automated system that detected it_

---

## Response

> Describe the response steps taken, in order. Include both actions that helped and actions that turned out to be wrong turns. Capture what was tried and why.

1. _Step one_
2. _Step two_
3. _..._

---

## Resolution

> What change brought the incident to an end? Include the exact command, config change, contract call, or deploy that restored service.

```
# Paste the exact remediation command(s), if applicable
```

---

## What went well

> Honest credit. What detection, tooling, communication, or process worked as intended?

- _Item_
- _Item_

---

## What went wrong

> Honest critique. What detection, tooling, communication, or process failed or slowed resolution?

- _Item_
- _Item_

---

## Action items

> Each action item must have an owner, a due date, and a linked GitHub issue. "No owner" means it will not get done. Aim for fewer than ten action items; prioritise the highest-leverage fixes.

| # | Action | Owner | Due | Issue |
|---|---|---|---|---|
| 1 | _Description of the fix or improvement_ | @handle | YYYY-MM-DD | #000 |
| 2 | | | | |
| 3 | | | | |

---

## Lessons learned

> Two to five sentences summarising what the team learned. This is the section future readers are most likely to read; make it standalone and actionable.

---

## Appendix

### Relevant logs

> Paste representative log lines. Remove secrets and private keys before committing. Use code blocks.

```
# Paste log excerpts here
```

### Relevant transactions / contract calls

> Transaction hashes and links to block explorers for any on-chain events related to the incident.

| Chain | Transaction | Notes |
|---|---|---|
| | | |

### References

- _Link to related GitHub issue or PR_
- _Link to relevant runbook in [docs/OPERATIONS.md](../OPERATIONS.md)_
- _Link to monitoring dashboard_

---

## Severity definitions

| Severity | Criteria | Examples |
|---|---|---|
| **SEV-1** | Funds at risk or user funds inaccessible; active data loss; all refund layers non-functional | HTLC claim broken with locked funds; all refund paths down |
| **SEV-2** | Significant user-facing degradation; one refund layer non-functional; core swap path down | Coordinator offline; relayer not relaying secrets; frontend unreachable |
| **SEV-3** | Partial degradation; one chain affected; resolver issues with on-chain safety nets intact | Single-chain RPC failure; resolver not filling orders but HTLC refund works |
| **SEV-4** | Minor degradation; no user impact; internal tooling, monitoring, or CI issues | Failed health check alert; metrics pipeline down; non-critical build failure |
