# Coordinator–Relayer–Resolver Handoff Smoke Test

`test/handoff-smoke.test.ts` is a deterministic, self-contained smoke test that
validates the full cross-service order lifecycle through a single in-memory
coordinator app. It runs in CI with no external services.

## What it covers

| Flow | Description |
|------|-------------|
| `eth_to_xlm` full lifecycle | announce → src-lock → dst-lock → reveal → secret readable |
| `sol_to_eth` full lifecycle | same five steps on the Solana route |
| `eth_to_sol` full lifecycle | same five steps on the ETH→SOL route |
| Resolver idempotency | duplicate `src-locked` and `dst-locked` calls are safe no-ops |
| State machine integrity | out-of-order handoffs (dst-lock before src-lock, reveal before lock) return 400 |
| Operator auth enforcement | missing / wrong bearer token on protected endpoints returns 401/403 |
| Multi-order isolation | two concurrent orders on different directions do not bleed state |

## How to run

```bash
# Run just this file
pnpm --filter @wafflefinance/coordinator exec vitest run test/handoff-smoke.test.ts

# Run the full coordinator test suite (includes handoff smoke)
pnpm --filter @wafflefinance/coordinator test

# Watch mode during development
pnpm --filter @wafflefinance/coordinator exec vitest test/handoff-smoke.test.ts
```

## Environment assumptions

- **No live RPC or external network access required.** The test stubs `globalThis.fetch`
  to prevent any outbound calls (e.g. accidental CoinGecko hits from `QuoteService`).
- **Operator key.** The test sets `COORDINATOR_OPERATOR_KEYS=handoff-smoke-operator-key`
  in `beforeEach` and restores the original value in `afterEach`, so it is safe to run
  alongside other tests that use a different operator key.
- **Isolated SQLite databases.** Each `freshApp()` call creates a new temp directory with
  a fresh SQLite file. Tests never share state.

## What a failure means

A test failure in this file indicates that a **service boundary contract has drifted**.
Specifically:

| Failing flow | What changed |
|---|---|
| Lifecycle test | An HTTP endpoint signature, request/response shape, or state-machine transition was modified incompatibly |
| Idempotency test | Duplicate event handling was broken — the coordinator will produce duplicate state |
| State machine test | A formerly-rejected transition is now being accepted (or vice versa) |
| Auth test | The operator middleware is missing or bypassed on a protected endpoint |
| Isolation test | State is being shared across orders (database query bug, wrong `WHERE` clause, etc.) |

When this test fails in CI, **do not merge** until the contract drift is resolved or the
test is intentionally updated to reflect an agreed contract change.

## Adding new handoff flows

1. Add a `describe("handoff smoke: <direction> <scenario>", ...)` block.
2. Use `freshApp()` for a clean database.
3. Use `makeSecret(seed)` for a deterministic hashlock/preimage pair.
4. Follow the step-comment pattern (`// ── Step N (role): description`) so the
   failure output identifies which handoff point broke.
5. Assert on the intermediate coordinator state after *each* step — not only at
   the end. This makes failures self-explaining.
