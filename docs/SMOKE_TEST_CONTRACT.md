# Repo-Wide Contract Smoke Test

Defines the deterministic, CI-safe smoke test that validates the primary
entry points across this repo actually wire together — not just that each
package's own unit tests pass in isolation.

## Why a package's own tests aren't enough

`pnpm test` runs every package's suite independently. That catches logic bugs
within a package but not **contract drift between packages** — e.g. the SDK's
`Order` type shape diverging from what the coordinator actually returns from
`/orders/announce`, or the frontend's expected API response shape silently
changing underneath it. Two things already exist in this repo that partially
address this, and this document's job is to name the remaining gap precisely
rather than re-describe what's already covered.

### What already exists

| Existing coverage | File | What it proves | What it doesn't touch |
|---|---|---|---|
| Cross-service order lifecycle | [`coordinator/test/handoff-smoke.test.ts`](../coordinator/test/handoff-smoke.test.ts), documented in [`coordinator/HANDOFF_SMOKE_TEST.md`](../coordinator/HANDOFF_SMOKE_TEST.md) | The coordinator's own HTTP surface (`/orders/announce`, src-lock, dst-lock, reveal) is internally consistent across all three swap directions, with operator auth and idempotency enforced | Runs entirely inside one in-memory coordinator app — never imports `@wafflefinance/sdk` as a real consumer, never touches the relayer, resolver, or frontend processes, never asserts on `/readyz` |
| SDK chain-client differential test | [`e2e/cross-chain.test.ts`](../e2e/cross-chain.test.ts) | The EVM and Soroban HTLC clients agree on hashlock/preimage (sha256) semantics via shared SDK secret helpers | Doesn't start the coordinator, doesn't exercise the SDK's coordinator-facing client, doesn't touch the frontend |

Neither covers: the coordinator's **readiness route** as a contract surface in
its own right, the **SDK initializing against a live coordinator instance**
(as opposed to testing chain clients directly), or **anything in the
frontend**. Those three, plus the order-announcement path already proven by
`handoff-smoke.test.ts`, are the four surfaces this issue asks for.

## Target entry points and their pass criteria

| Entry point | What "wired correctly" means here | How to exercise it deterministically |
|---|---|---|
| Coordinator readiness route | `GET /readyz` returns the check shape `{name, ok, detail?, latencyMs?}[]` documented in [`coordinator/src/readiness.ts`](../coordinator/src/readiness.ts), and `deriveStartupPhase()` produces `ready` once the database check passes and reconciliation has run at least once — matching the phase table in [docs/DEPLOYMENT_ROLLBACK_RUNBOOK.md](DEPLOYMENT_ROLLBACK_RUNBOOK.md#startup-lifecycle-what-restarted-successfully-means) | Call `createReadinessChecks()` directly against the same in-memory `freshApp()` SQLite instance `handoff-smoke.test.ts` already builds, with `fetcher` stubbed to resolve immediately — no live RPC, matching the existing file's `globalThis.fetch` stub pattern |
| Backend order announcement path | `POST /orders/announce` accepts a well-formed order and returns the shape the SDK's `Order` type expects | Already proven by `handoff-smoke.test.ts`'s lifecycle tests — the repo-wide smoke test should **reference/reuse** that coverage rather than duplicate it, and instead add the missing link: decode the response with `@wafflefinance/sdk`'s actual `Order` type import, not a hand-rolled shape assertion |
| SDK initialization path | Importing `@wafflefinance/sdk`'s public entry (`packages/sdk/src/index.ts`) and using it against a running coordinator — e.g. `generateSecret()` / `hashSecret()` to build a real announce payload, then `canTransition()` from the state-machine export to validate the lifecycle the coordinator reports — succeeds without type or runtime mismatch | Run inside the same test process as the coordinator app (no network hop needed — call the Express app handler directly via `supertest`-style in-process request, the same mechanism `handoff-smoke.test.ts` already uses), but construct the request/response using SDK exports instead of hand-written literals |
| Frontend entry/export path | This app has **no client-side routing** — `frontend/src/App.tsx` is rendered directly under `BrowserRouter` in `main.tsx` with no `<Route>` elements defined anywhere in `frontend/src`. "A representative frontend route" therefore means: (a) `pnpm --filter @wafflefinance/frontend build` produces `frontend/dist/index.html` referencing built JS/CSS, and (b) the root `App` export can be imported and rendered in `jsdom` (already configured — see `frontend/vite.config.ts` `test.environment: 'jsdom'`) without throwing | A new `frontend/src/App.smoke.test.tsx` using `@testing-library/react`'s `render()` (already a frontend devDependency, `^16.3.2`) against `<App />`, asserting it mounts without an unhandled exception. This does not require a live coordinator — mock `VITE_API_BASE_URL`-driven fetches at the boundary, matching how the rest of the frontend's own tests already work in `frontend/src/test/setup.ts` |

## Determinism and bounded footprint

The smoke test must satisfy the same constraints `handoff-smoke.test.ts`
already documents for itself, extended to the new surfaces:

- **No live RPC or external network access.** Stub `globalThis.fetch` for the
  coordinator readiness probes exactly as `handoff-smoke.test.ts` does for
  `QuoteService`, so a real Ethereum/Soroban/Solana RPC is never dialed.
- **Isolated storage per run.** A fresh temp-directory SQLite file per test
  run (via the existing `freshApp()` helper), never a shared database.
- **No frontend browser required.** The frontend check runs under `jsdom` via
  Vitest, not a real browser — keeping the whole smoke test runnable in CI
  without a Playwright/Chromium dependency.
- **Single process.** The coordinator readiness, order-announcement, and SDK
  checks all run in-process against the same Express app instance (as
  `handoff-smoke.test.ts` already does) rather than spawning `node
  dist/index.js` and polling a real port — this keeps the test fast and
  removes flakiness from port binding / startup races.

## Proposed location and command

Given the existing `e2e` workspace package already exists for cross-package
concerns (see its `package.json` description: "Cross-chain differential test
harness"), and given the coordinator-internal piece already lives in
`coordinator/test/handoff-smoke.test.ts`, the natural home for the *new*
cross-package pieces (readiness + SDK-against-live-coordinator) is a new file
alongside the existing one — e.g. `coordinator/test/repo-contract-smoke.test.ts`
— rather than a new top-level package, since it needs the same in-process
Express app the coordinator's own test suite already builds. The frontend
piece (`App.smoke.test.tsx`) belongs in `frontend/src/test/` next to the
existing `setup.ts`.

A root-level `pnpm smoke` script tying both together (target shape, not yet
added):

```jsonc
// package.json (target shape once implemented)
"scripts": {
  "smoke": "pnpm --filter @wafflefinance/coordinator exec vitest run test/repo-contract-smoke.test.ts && pnpm --filter @wafflefinance/frontend exec vitest run src/test/App.smoke.test.tsx"
}
```

This mirrors the pattern `coordinator/HANDOFF_SMOKE_TEST.md` already
documents for running just its file (`pnpm --filter @wafflefinance/coordinator
exec vitest run test/handoff-smoke.test.ts`) rather than the whole suite.

## Maintenance contract

A failure in this smoke test means the same thing
`coordinator/HANDOFF_SMOKE_TEST.md` already states for its own scope, extended
to the new surfaces:

| Failing check | What changed |
|---|---|
| Readiness shape | `coordinator/src/readiness.ts`'s check shape or `deriveStartupPhase()` logic changed incompatibly with what operators/dashboards expect (see [docs/HEALTH_DASHBOARD.md](HEALTH_DASHBOARD.md)) |
| SDK-vs-coordinator mismatch | The SDK's `Order`/state-machine types and the coordinator's actual HTTP responses have drifted apart — a real integration break for every SDK consumer |
| Frontend mount failure | A component wiring change (missing provider, broken import, config read that throws at mount) broke the app shell itself, not just a feature |

As with the other three documents in this set, config assumptions here
(no live RPC, jsdom instead of a browser, in-process Express rather than a
bound port) must stay accurate — see [docs/QUALITY_GATE.md](QUALITY_GATE.md)
for the contract that keeps documentation like this honest as the code moves.

## Deployment health smoke check (implemented)

`pnpm smoke:deployment` probes `/health` and `/readyz` on all three services
after a rollout. Service URLs come from `SMOKE_CONFIG` (a JSON file with a
`services` map) or `COORDINATOR_URL`, `RELAYER_URL`, and `RESOLVER_URL`;
defaults are localhost ports 3001/3002/3003. `SMOKE_TIMEOUT_MS` bounds each
probe and `SMOKE_REQUIRED_CHAINS` selects the chains that must be healthy.

The checker validates each payload's `status`, `uptime`, and `checks` fields,
summarises chain dependencies by check name, and exits nonzero with
per-service diagnostics when any required dependency is unhealthy. Output only
includes URL origins (no userinfo, paths, query strings, keys, or full URLs),
so a failure cannot leak API keys. The hermetic test
`pnpm test:smoke:deployment` runs the checker against local stubs for the
all-healthy and failing-chain cases.

## Status

This document specifies the four target entry points, their pass criteria,
and where the new test code should live. The actual test files
(`coordinator/test/repo-contract-smoke.test.ts`,
`frontend/src/test/App.smoke.test.tsx`) and the `pnpm smoke` script are **not
yet implemented** — this pass was scoped to documentation only, matching the
other three documents in this set.
