# Architecture Decision Records

This directory contains Architecture Decision Records (ADRs) for decisions that
affect WaffleFinance's protocol rules, service boundaries, or cross-package
contracts.

ADRs are **lightweight and additive** — one file per decision, written once,
amended only to record supersession.  They are not a substitute for
[`ARCHITECTURE.md`](../ARCHITECTURE.md) (which describes the system as it is
today) or the technical debt register (`TECHNICAL_DEBT.md`).  An ADR explains
*why* a boundary or rule exists; `ARCHITECTURE.md` explains *what* it is.

---

## Index

| ID | Title | Status | Date |
|----|-------|--------|------|
| [ADR-001](./ADR-001-dual-state-machine.md) | Dual state-machine implementation (SDK + coordinator) | Active | 2026-10-01 |
| [ADR-002](./ADR-002-sha256-primary-hashlock.md) | sha256 as the primary cross-chain hashlock | Active | 2026-10-01 |
| [ADR-003](./ADR-003-coordinator-db-as-cache.md) | Coordinator database as a rebuildable cache | Active | 2026-10-01 |

> **Active** — decision is in force.  
> **Superseded** — a later ADR replaces this one; the file notes which.  
> **Deprecated** — the concern no longer applies (e.g. the feature was removed).

---

## When to write an ADR

Write an ADR when a decision:

- establishes or changes a **protocol rule** (hashlock scheme, timelock
  asymmetry, settlement sequence), or
- defines a **service boundary** that multiple packages depend on (who owns
  order state, what the coordinator is and is not authoritative for), or
- makes a **cross-package contract** explicit (how the SDK is consumed, why the
  state machine is duplicated).

You do **not** need an ADR for:

- implementation choices internal to one package (algorithm selection, library
  version)
- operational decisions (deployment topology, monitoring thresholds)
- anything already captured accurately in `ARCHITECTURE.md` with no risk of
  future readers misunderstanding the rationale

If you are unsure, write a short ADR — it costs little and pays off when the
next person reads the code and wonders "why is this like this?"

---

## How to propose an ADR

1. Copy [`ADR-000-template.md`](./ADR-000-template.md) to a new file named
   `ADR-NNN-short-title.md` where NNN is the next available three-digit number.
2. Fill in every field.  The *Context* and *Decision* sections must be
   self-contained — a reader should not need to find the original PR to
   understand the record.
3. Add a row to the index table above.
4. Open a PR.  The PR description should link back to the ADR file.
5. Merge once at least one other engineer has reviewed the record for accuracy.

---

## How to supersede an ADR

1. Create a new ADR with the replacement decision.
2. In the new ADR's *Supersedes* field, list the ADR(s) it replaces.
3. In each superseded ADR, change `Status: Active` to
   `Status: Superseded by ADR-NNN` and add a one-line note at the top.
4. Update the index table for both records.
5. Do **not** delete superseded ADRs — they are permanent history.
