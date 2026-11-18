---
name: Technical task
about: A bounded, implementable technical change — feature, improvement, operational task, or tech-debt item.
title: "<Component>: <one-line actionable description>"
labels: []
assignees: ""
---

<!--
Before submitting: read docs/BACKLOG_HYGIENE.md for the issue quality
standards this repository enforces.  Issues that do not meet the standards
below will be returned to the author for revision at triage.

Do not include private keys, seed phrases, wallet secrets, or RPC API keys
anywhere in this issue.  Redact all sensitive values.
-->

## Component

<!-- Identify the affected service or layer.
     Choose one or more: coordinator / relayer / resolver / frontend /
     contracts / soroban / sdk / config / e2e / tooling / docs -->

## Description

<!-- One to three paragraphs: what is the current state, why it is a problem,
     and what change is needed.  Link to the relevant source file or doc if
     it helps scope the work. -->

## Work to be done

<!-- Describe the concrete deliverables: which files change, which scripts or
     docs are added or updated.  Keep the scope to one service or tightly
     coupled components.  If the change touches more than three files across
     more than two services, consider splitting the issue. -->

## Implementation procedure

<!-- Ordered steps a contributor can follow to complete the work.  Each step
     should be a single, verifiable action.  Include the commands to run
     where they are not obvious. -->

1.
2.
3.

## Acceptance criteria

<!-- State what "done" means in testable, observable terms.  Write each
     criterion as a plain declarative sentence — not a checkbox.

     Bad:  "Improve reliability"
     Good: "pnpm validate:deployments exits 0 after a redeploy updates the manifest"

     Do not use "- [ ]" checkbox syntax here. -->

-
-
-

## Related

<!-- Optional.  Remove any line that does not apply. -->

- Technical debt entry: <!-- e.g. TD-041 in docs/TECHNICAL_DEBT.md -->
- Quality gate check: <!-- e.g. Check 3 in docs/QUALITY_GATE.md -->
- Related issues: <!-- #N -->
- Relevant doc: <!-- e.g. docs/OPERATIONS.md -->
