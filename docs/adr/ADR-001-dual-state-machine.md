# ADR-001: Dual state-machine implementation (SDK + coordinator)

| Field | Value |
|-------|-------|
| **Status** | Active |
| **Date** | 2026-10-01 |
| **Authors** | Engineering team |
| **Supersedes** | — |
| **Superseded by** | — |

---

## Context

The WaffleFinance coordinator and the SDK both need to reason about an order's
lifecycle.  The coordinator needs it at write time — before recording any
transition it checks whether the transition is allowed.  The SDK needs it at
read time — the frontend and E2E suite use it to validate what state an order
can move to next and to drive UI state.

A single shared runtime module would be the natural solution, but the
coordinator is a Node server package (imports `@wafflefinance/sdk` as a built
dependency) and the SDK is a client-side package that must not import anything
from coordinator.  Sharing the implementation in one direction would create a
circular dependency; sharing it in a third `@wafflefinance/state-machine`
package would add a build and publish step to what is currently a zero-overhead
constant.

## Decision

We maintain two independent implementations of the same order-status transition
table:

- `packages/sdk/src/state-machine/index.ts` — the SDK's client-side view,
  exported as `@wafflefinance/sdk/state-machine`.
- `coordinator/src/state-machine/order-machine.ts` — the coordinator's
  server-side authority.

Both implementations encode the same `ORDER_STATUS_TRANSITIONS` table as a
plain `Record<OrderStatus, readonly OrderStatus[]>`.  A conformance test
(`coordinator/test/status-conformance.test.ts`) pins the two tables to each
other at test time — a transition added to one without the other fails the test
suite before any PR can merge.

## Consequences

+ No circular dependency between the SDK and the coordinator.
+ No new package to build and publish.
+ The conformance test makes divergence visible immediately at CI time.
- Two copies of the same table must be updated together on every lifecycle
  change (tracked as an open architectural gap in `ARCHITECTURE.md` and
  acknowledged in `TECHNICAL_DEBT.md`).
- A developer editing one file may not notice they need to update the other
  without reading this record or the conformance test.

## Alternatives considered

**Shared `@wafflefinance/state-machine` package.**  This would eliminate the
duplication but requires a third publishable package, an additional build step
in the monorepo, and careful versioning to prevent a stale SDK build from
diverging from a newer coordinator build.  The conformance test achieves the
same safety guarantee at lower cost for the current scale of the project.

**SDK imports coordinator state machine at build time.**  This inverts the
dependency arrow (SDK depends on coordinator) which is architecturally wrong —
the SDK is a client library that must remain independent of server internals.
