# Technical Debt Maintenance Strategy

> **Owner:** Engineering team  
> **Last updated:** 2026-09-25  
> **Companion doc:** [`docs/TECHNICAL_DEBT.md`](./TECHNICAL_DEBT.md) — the debt register this strategy operates on

The debt register in `TECHNICAL_DEBT.md` is only useful if engineering decisions
can be made from it without re-reading every item from scratch. This document
provides that model: a rubric for triaging new debt, a priority framework for
deciding what to fix next, category definitions so items are comparable across
services, and integration points with release planning and sprint cycles.

---

## Table of Contents

- [Principles](#principles)
- [Triage rubric](#triage-rubric)
- [Debt categories](#debt-categories)
- [Priority model](#priority-model)
- [Mapping existing debt](#mapping-existing-debt)
- [Planning integration](#planning-integration)
- [When to accept debt vs. fix it immediately](#when-to-accept-debt-vs-fix-it-immediately)
- [Closing a debt item](#closing-a-debt-item)
- [Process for adding new items](#process-for-adding-new-items)

---

## Principles

Three rules govern how debt is managed in this repo:

1. **A debt item without an owner and a severity is noise, not signal.** Every item in
   the register must have a severity tag (🔴 HIGH / 🟡 MED / 🟢 LOW) and a "Next steps"
   section that is actionable without reading the surrounding source code.

2. **Debt that blocks mainnet or creates a security risk gets fixed before the next
   release, not scheduled for later.** The audit gate (TD-001) does not make
   security debt acceptable — it makes it more visible. HIGH items should not
   sit unowned for more than 90 days.

3. **Debt reduction is a planned activity, not an accidental one.** The monthly
   technical debt review (M-02 in [`docs/MAINTENANCE_CALENDAR.md`](./MAINTENANCE_CALENDAR.md))
   is the venue for deciding what moves into the next sprint. Debt items do not get
   fixed by chance during unrelated work.

---

## Triage rubric

When a new debt item is discovered, answer these four questions in order. They
determine the severity tag and the urgency of scheduling.

### Q1 — Does this item block mainnet launch or create an active security risk?

| Yes | No |
|---|---|
| Assign 🔴 HIGH. Add to the pre-mainnet blockers checklist in `contracts/docs/mainnet-deployment-checklist.md`. Schedule for the current or immediately next sprint. | Proceed to Q2. |

**Examples that answer Yes:** plaintext secret storage (TD-041), unaudited mainnet
contract paths (TD-001), a signing key with no rotation runbook on mainnet
infrastructure.

### Q2 — Does this item degrade reliability, increase incident risk, or meaningfully
harm operator experience in production today?

| Yes | No |
|---|---|
| Assign 🟡 MED. Add to the next monthly debt review. Target resolution within two release cycles unless it depends on a 🔴 HIGH item being resolved first. | Proceed to Q3. |

**Examples that answer Yes:** unstructured relayer logs blocking cross-service
correlation (TD-051), lazy listener startup causing a missed-event window on fresh
deploy (TD-042), hardcoded price fallback causing mis-sized safety deposits (TD-052).

### Q3 — Does this item reduce code quality, developer experience, or long-term
maintainability without a near-term production risk?

| Yes | No |
|---|---|
| Assign 🟢 LOW. Add to the backlog. Pick up opportunistically when touching the affected area, or batch with related LOW items in a quarterly cleanup sprint. | The item may not be real debt — reconsider whether it belongs in the register at all. |

**Examples that answer Yes:** duplicate state machine implementations (no shared
module between coordinator and SDK), dead code in the Ethereum listener (TD-054),
missing Foundry invariant tests for edge cases (TD-013).

### Q4 — Does this item depend on another debt item being resolved first?

If yes, record the dependency explicitly in the item's "Next steps" section using
the format `Depends on TD-XXX`. Do not assign a sprint slot to a blocked item until
its dependency is resolved. Blocked items are still reviewed monthly to catch
dependency chains that have been unblocked.

---

## Debt categories

Use these categories consistently when adding items to the register. Categories
make it easy to batch related items and assign them to the right team member.

| Category | What belongs here | Examples |
|---|---|---|
| **Security** | Items that, if exploited, could result in loss of user funds, unauthorized key access, or unauthorized order manipulation | TD-041 (plaintext secrets), TD-011 (registry owner not enforced), TD-021 (admin key rotation) |
| **Reliability** | Items that increase the probability of a service outage, missed event, or incorrect order state under normal operating conditions | TD-042 (lazy listener startup), TD-051 (unstructured logging), TD-052 (hardcoded price fallback) |
| **Correctness** | Items that may produce wrong results in specific scenarios, even if those scenarios are not currently reachable in production | TD-040 (hand-rolled SQL dialect translation), TD-053 (untested mainnet ABI path) |
| **Observability** | Items that make it harder to understand what the system is doing during an incident | TD-051 (no structured relayer logs), TD-044 (no WebSocket push — polling obscures order timing) |
| **Maintainability** | Items that increase the cost of future changes, not the risk of present ones | TD-050 (3,500-line relayer monolith), duplicate retry logic (three implementations), duplicate state machines (two implementations) |
| **Test coverage** | Missing tests for existing production code paths | TD-060 (no Solana resolver tests), TD-013 (no Foundry invariant tests), TD-071 (mainnet flows untested) |
| **Operational** | Missing runbooks, undocumented procedures, or tooling gaps that increase incident response time | TD-010 (no registry upgrade runbook), TD-021 (no admin key rotation runbook), TD-061 (supervisor max restarts not configurable) |

One item can have multiple categories. If it does, the primary category determines
which team member picks it up; secondary categories appear in the "Next steps" section.

---

## Priority model

Severity (from the register) and category together determine scheduling priority.
Use this table to make the call at the monthly debt review.

| Severity | Category | Target sprint slot |
|---|---|---|
| 🔴 HIGH | Any | Current sprint or immediately next sprint. Requires an owner assigned before the review closes. |
| 🟡 MED | Security | Next sprint. Do not batch with other MED items — security MED is higher than reliability MED. |
| 🟡 MED | Reliability / Correctness | Within two release cycles. One per sprint is a healthy pace. |
| 🟡 MED | Observability / Operational | Within three release cycles. Can batch 2–3 small items per sprint. |
| 🟢 LOW | Any | Opportunistic — pick up when already touching the affected file or area, or batch in a quarterly cleanup sprint. |
| Any | Blocked (depends on unresolved item) | Do not schedule until dependency is resolved. Re-evaluate at the next monthly review after the dependency closes. |

**Budget guideline:** At any given sprint, no more than 20% of engineering capacity
should be allocated to debt reduction unless a 🔴 HIGH item requires more. Debt
reduction competes with feature work; this cap keeps both moving. The 20% is a
floor too — if a sprint has no feature work, use the extra capacity to advance MED
items, not to leave the debt queue growing.

### Expected payoff by category

| Category | Payoff when fixed | When payoff is realized |
|---|---|---|
| Security | Reduces blast radius of a key or credential compromise; enables mainnet launch | Immediately on fix |
| Reliability | Reduces incident frequency; improves automatic recovery | Next incident that would have triggered the item |
| Correctness | Prevents a class of bug from reaching production silently | When the affected code path is exercised under the fixed condition |
| Observability | Reduces mean time to diagnose (MTTD) during incidents | Next incident requiring cross-service correlation |
| Maintainability | Reduces time to safely make changes in the affected area | Next time that area is touched |
| Test coverage | Catches regressions automatically; enables refactoring with confidence | Next change to the uncovered code path |
| Operational | Reduces mean time to recover (MTTR); removes dependency on tribal knowledge | Next incident or deployment in the affected area |

---

## Mapping existing debt

The table below maps every open item in [`TECHNICAL_DEBT.md`](./TECHNICAL_DEBT.md)
to this framework. Use it at the monthly review to decide what to pull into the sprint.

| ID | Title | Severity | Category | Priority | Blocked by | Sprint target |
|---|---|---|---|---|---|---|
| TD-001 | Mainnet gated until audit | 🔴 HIGH | Security | Immediate — external dependency | — (external: audit Q1 2027) | Post-audit sprint |
| TD-041 | SECRET_STORAGE_KEY optional — plaintext secrets | 🔴 HIGH | Security | Current or next sprint | — | Assign now |
| TD-030 | SolanaHTLCClient simulation mode | 🔴 HIGH | Correctness | After TD-000 resolved | TD-000 ✅ resolved | Next sprint |
| TD-080 | SolanaHtlcSim is a stub | 🔴 HIGH | Test coverage | After TD-000 resolved | TD-000 ✅ resolved | Next sprint |
| TD-010 | HTLCEscrow registry upgrade path undocumented | 🟡 MED | Operational | Within 2 release cycles | — | Planning |
| TD-011 | ResolverRegistry owner not enforced as multisig | 🟡 MED | Security | Before mainnet | TD-001 | Post-audit sprint |
| TD-020 | Soroban TS bindings require manual regen | 🟡 MED | Operational | Within 2 release cycles | — | Next sprint (batch with SDK work) |
| TD-021 | No Soroban admin key rotation runbook | 🟡 MED | Operational / Security | Before mainnet | TD-001 | Post-audit sprint |
| TD-031 | Devnet USDC mint hardcoded | 🟡 MED | Correctness | Within 2 release cycles | — | Planning |
| TD-040 | Hand-rolled SQL dialect translation | 🟡 MED | Correctness | Within 3 release cycles | — | Quarterly cleanup |
| TD-042 | Lazy listener startup | 🟡 MED | Reliability | Within 2 release cycles | — | Next sprint |
| TD-050 | 134 KB relayer monolith | 🟡 MED | Maintainability | Within 3 release cycles | — | Quarterly cleanup |
| TD-051 | Relayer console.log — no structured logging | 🟡 MED | Observability | After TD-050 partial | TD-050 | After TD-050 starts |
| TD-052 | Hardcoded ETH/USD fallback in safety deposit | 🟡 MED | Correctness / Reliability | Within 2 release cycles | — | Next sprint |
| TD-053 | Untested mainnet EscrowFactory ABI | 🟡 MED | Test coverage | Before mainnet | TD-001 | Post-audit sprint |
| TD-060 | No Solana resolver tests | 🟡 MED | Test coverage | After TD-000 resolved | TD-000 ✅ resolved | Next sprint |
| TD-070 | wagmi v1 deprecated | 🟡 MED | Maintainability | Within 3 release cycles | — | Quarterly cleanup |
| TD-071 | Mainnet frontend flows untested | 🟡 MED | Test coverage | ✅ Resolved (frontend.yml matrix) | — | Closed |
| TD-012 | ERC20-only — no multi-token routing | 🟢 LOW | Correctness | Post-mainnet | TD-001 | Backlog |
| TD-013 | No Foundry invariant/fuzz tests | 🟢 LOW | Test coverage | Opportunistic | — | When touching contracts |
| TD-032 | Dual-hash scheme not documented | 🟢 LOW | Operational | Opportunistic | — | When touching SDK docs |
| TD-044 | No WebSocket/SSE push | 🟢 LOW | Observability | Post-mainnet | — | Backlog |
| TD-054 | Dead v1 Stellar placeholder code | 🟢 LOW | Maintainability | Opportunistic | — | When touching relayer listener |
| TD-061 | Supervisor maxRestarts not configurable | 🟢 LOW | Operational | Opportunistic | — | When touching resolver config |
| TD-062 | Single key only — no hot rotation | 🟢 LOW | Operational / Security | Pre-mainnet desirable | TD-001 | Post-audit planning |
| TD-072 | No E2E test against real devnet | 🟢 LOW | Test coverage | Post-TD-000 | TD-000 ✅ resolved | Backlog |

---

## Planning integration

### Monthly debt review (M-02)

The monthly technical debt review (see [`MAINTENANCE_CALENDAR.md`](./MAINTENANCE_CALENDAR.md)
§ M-02) is the primary venue for debt decisions. The agenda is:

1. **Mark resolved items.** Any item completed since last review gets ✅ in the register
   and in the mapping table above.
2. **Scan for newly unblocked items.** If a dependency was resolved, unblock its
   dependents and assign a sprint slot.
3. **Audit HIGH items older than 60 days.** Any 🔴 HIGH item without an owner and a
   planned sprint date must be assigned before the meeting ends.
4. **Pull one MED item per team member** into the next sprint if capacity allows. Prefer
   the oldest unblocked MED item in the highest-payoff category.
5. **Note new debt.** Add any items discovered since the last review, triage them using
   the rubric above, and add them to both the register and the mapping table.

The output of the monthly review is a concrete list of items assigned to the next
sprint, not just a freshness check on the register.

### Release planning integration

Before any release, the release engineer checks the debt register for two things:

1. **Any 🔴 HIGH item without a resolution or a documented acceptable risk statement
   blocks the release.** To proceed, either resolve the item or add an explicit
   risk-acceptance comment to the item's entry in the register, signed by the engineering
   lead. Risk acceptance is not a permanent deferral — the item remains HIGH and continues
   to appear in monthly reviews.

2. **Any MED item added since the last release** should have a sprint slot assigned before
   or immediately after the release. A release that adds new MED debt without assigning
   owners is a pattern to avoid.

The release checklist cross-reference is in
[`docs/RELEASE_CHECKLIST_MULTI_PACKAGE.md`](./RELEASE_CHECKLIST_MULTI_PACKAGE.md)
§ Part 3, which includes a debt register check as a shared release gate.

### Sprint hygiene

- Debt items should be tracked as GitHub issues with the label `tech-debt` and a
  secondary label matching the category (`security`, `reliability`, `observability`, etc.).
- Link each GitHub issue back to its TD-NNN identifier in the register by including
  the ID in the issue title or body.
- When the issue is closed, update the register entry with the resolution PR link.
- Do not close a debt issue without also updating the register. The register and the
  issue tracker must stay in sync.

---

## When to accept debt vs. fix it immediately

Not all debt should be on a sprint — some items have acceptable risk profiles at
the current project stage (pre-mainnet, testnet-only traffic). Use this framework:

| Condition | Decision |
|---|---|
| Item is 🔴 HIGH and affects user funds or key material | Fix immediately. No exceptions. |
| Item is 🔴 HIGH but only affects mainnet paths (which are gated) | Document risk explicitly. Assign to post-audit sprint. Do not let it age past the audit milestone. |
| Item is 🟡 MED and directly in the path of the next planned feature | Fix first, as part of the feature sprint. It's cheaper to fix debt before building on top of it. |
| Item is 🟡 MED and in a stable area with no planned changes | Schedule in the next 2-cycle window. Don't rush it, but don't let it drift to LOW. |
| Item is 🟢 LOW and isolated to a file you're already changing | Fix it inline (no separate issue needed if the fix is < 20 lines). Note it as resolved in the register. |
| Item is 🟢 LOW and requires a significant refactor | Add to the quarterly cleanup sprint backlog. Don't gold-plate in unrelated PRs. |
| Item is blocked on an external dependency (audit, third-party deploy) | Document the blocker and the expected unblock date explicitly. Review quarterly to confirm the date is still current. |

**Anti-pattern to avoid:** "I'll fix this while I'm in here." Small inline cleanups
during unrelated PRs are fine (see 🟢 LOW isolated case above). Large refactors or
new test suites discovered during unrelated work should be opened as new debt issues
and scheduled properly, not squeezed into a PR that has a different scope.

---

## Closing a debt item

A debt item is closed when **all** of the following are true:

1. The specific gap described in the item's "Context" section no longer exists in the
   codebase (verified by reading the affected file, running the affected test, or checking
   the affected configuration).
2. The "Next steps" actions are either completed or explicitly superseded by a different
   approach (with a note explaining why).
3. Any dependent items that were blocked on this one have been reviewed and either
   unblocked or reassigned a new dependency.
4. The register entry is updated: severity tag changed to ✅, resolution PR linked,
   resolution date noted.
5. The mapping table in this document is updated to reflect the closure (change "Sprint
   target" to "Closed" and add the resolution date).

A debt item is **not** closed by:
- Merging a PR that partially addresses the gap without completing the "Next steps."
- Adding a test for the fixed path without verifying the original gap is gone.
- Deferring the remaining work to a new item without linking the two explicitly.

---

## Process for adding new items

When a contributor discovers new technical debt:

1. **Open a GitHub issue** with label `tech-debt` and a secondary category label.
2. **Add an entry to [`TECHNICAL_DEBT.md`](./TECHNICAL_DEBT.md)** under the relevant
   service section. Follow the existing format:
   - `### TD-NNN · <Short title> <severity-tag>`
   - "Discovered" date
   - "Location" with file path
   - "Context" — what the problem is and why it matters
   - "Impact" — what goes wrong in production or during development
   - "Next steps" — concrete, actionable steps numbered 1–N
3. **Triage immediately** using the rubric in this document. Assign the severity tag
   before the issue is closed.
4. **Update the mapping table** in this document with the new item.
5. **If it's 🔴 HIGH:** bring it to the next engineering sync (don't wait for the
   monthly review) and assign an owner on the spot.

The next available TD number is one above the current highest in the register. As of
the last register update, the next available ID is **TD-081**.
