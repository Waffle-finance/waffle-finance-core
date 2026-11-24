# Multi-chain RPC degradation test matrix

The most dangerous failure mode in this repository is not a crash — it's a
chain RPC endpoint that goes slow, drops connections, or returns malformed
data while the coordinator, relayer, or resolver keep running and keep
*saying* they're healthy. This document specifies the test matrix that
guards against that: deterministic fixtures for the three RPC failure
shapes that actually happen in production, applied against each service's
operator-visible health signal, proving each one degrades honestly instead
of lying about chain connectivity.

This is a contract in the same spirit as
[`SMOKE_TEST_CONTRACT.md`](./SMOKE_TEST_CONTRACT.md) and
[`QUALITY_GATE.md`](./QUALITY_GATE.md): it documents what must be true,
what already exists, and what's still a gap.

---

## Table of contents

- [The three fixture shapes](#the-three-fixture-shapes)
- [Why one matrix doesn't fit all three services](#why-one-matrix-doesnt-fit-all-three-services)
- [Coordinator — implemented](#coordinator--implemented)
- [Relayer — target coverage](#relayer--target-coverage)
- [Resolver — target coverage](#resolver--target-coverage)
- [What "honest" means, precisely](#what-honest-means-precisely)
- [Running the matrix](#running-the-matrix)
- [Provider failover stub rehearsal](#provider-failover-stub-rehearsal)

---

## The three fixture shapes

Every scenario in this matrix is built from one of three deterministic RPC
failure fixtures, because these are the failure modes a real Ethereum,
Stellar, or Solana RPC endpoint actually produces under load or partial
outage — not synthetic error codes invented for the test suite:

| Fixture | Models | Caller-visible symptom |
| --- | --- | --- |
| **Delayed** | An endpoint that's up but overloaded or behind | The response arrives after the caller's own timeout has already fired |
| **Reset** | A dropped TCP connection / load balancer killing an idle socket | The request rejects immediately with a connection error, no HTTP response at all |
| **Partial receipt** | A node that's reachable but not synced/healthy | HTTP 200 OK, but the body is a JSON-RPC error envelope instead of a usable result |

A fourth, implicit scenario — **simultaneous multi-chain degradation** — is
just applying more than one of the above at once. This matters because a
service that correctly isolates one bad chain from another under a single
failure can still fail to do so when two chains go bad simultaneously (a
shared timer, a shared error-counter, or a shared "any check failed" gate
implemented incorrectly could conflate them).

---

## Why one matrix doesn't fit all three services

The naive assumption — "run the same three fixtures against each service's
`/readyz`" — doesn't work here, because the three services don't implement
readiness the same way. This asymmetry is itself something the matrix has
to prove is correctly handled, not paper over:

| Service | Readiness model | What actually degrades under bad RPC |
| --- | --- | --- |
| **coordinator** | `/readyz` live-probes every chain RPC on each request (`coordinator/src/readiness.ts`) | The specific chain's check flips to `ok: false` immediately |
| **relayer** | `/readyz` live-probes Ethereum + Stellar + (informational) Soroban/Solana RPC on each request (`relayer/src/routes/health.ts`) | Same shape as coordinator, different endpoint set |
| **resolver** | `/readyz` is **config-presence only** — no live RPC call, by design (`resolver/src/health.ts`) | Nothing on `/readyz`. The real signal is the separate `/telemetry` endpoint (`resolver/src/telemetry.ts`), which classifies each chain as `connected \| degraded \| stale \| inactive` based on how recently its listener made progress, not on a live probe |

See [`ARCHITECTURE.md`](./ARCHITECTURE.md#health-and-readiness-model) for
why this split exists. The practical consequence for this matrix: the
coordinator and relayer sections below test the same failure fixtures
against a request-time RPC probe; the resolver section tests them against
a retry/backoff layer and a staleness clock instead, because that's the
mechanism that's actually there.

---

## Coordinator — implemented

**Status: done.** `coordinator/test/rpc-degradation.test.ts`, built on
shared fixtures in `coordinator/test/fixtures/rpc-degradation.ts`
(`buildDegradedFetcher`), exercises `createReadinessChecks` and the
`/readyz` route directly (`healthRoutes`) end-to-end via `supertest`.

Coverage:

- **Delayed** — `ethereum_rpc` (or any one chain) times out while the
  others stay healthy; asserts isolation, not just that the slow chain
  fails.
- **Reset** — a dropped connection is reported `ok: false` without leaking
  the RPC URL into the failure detail (readiness payloads must never expose
  infrastructure endpoints).
- **Partial receipt** — an HTTP 200 carrying a JSON-RPC `error` field is
  treated as a failure, not a success — this is the fixture most likely to
  produce a false-healthy report if a probe only checks HTTP status.
- **Simultaneous multi-chain degradation** — all three chains degraded at
  once via three different fixtures simultaneously; asserts every affected
  chain is individually reported, and that the aggregate `/readyz` route
  returns HTTP 503 / `status: "degraded"`.
- **Recovery** — a chain that fails one check and succeeds the next is
  reported healthy immediately; readiness state is never latched/sticky
  across calls.

Run it with:

```bash
pnpm --filter @wafflefinance/coordinator exec vitest run test/rpc-degradation.test.ts
```

---

## Relayer — target coverage

**Status: not yet implemented.** The relayer's `/readyz`
(`relayer/src/routes/health.ts`) is structurally close enough to the
coordinator's that the same three fixtures and the same assertions apply,
with two relayer-specific differences to account for:

1. The relayer reads RPC URLs from `process.env` at request time
   (`getRelayerRpcConfig()`), not from an injected config object — tests
   need to set/restore env vars per case (see the existing
   `relayer/test/health.test.ts` for the save/restore pattern already used
   there) and stub `global.fetch` rather than injecting a fetcher.
2. **`relayer/src/routes/health.ts`'s `probeJsonRpc` currently only checks
   HTTP status (`response.ok`), not the JSON-RPC response body.** Unlike
   the coordinator's equivalent probe, it never calls `response.json()` —
   so a "partial receipt" (HTTP 200 with a JSON-RPC error envelope) would
   currently be reported as healthy. This is exactly the false-healthy
   scenario this matrix exists to catch, and should be fixed (bring
   `probeJsonRpc` in line with the coordinator's body-parsing check) as
   part of adding this coverage, not worked around in the test.

Target file: `relayer/test/rpc-degradation.test.ts`, using `global.fetch`
stubs shaped like `coordinator/test/fixtures/rpc-degradation.ts`'s three
scenarios. The delayed-response case needs `vi.useFakeTimers()` around the
request (the relayer's RPC probe timeout, `RPC_PROBE_TIMEOUT_MS`, is a
fixed 5s constant, not configurable per-call like the coordinator's), so
the test can assert timeout behavior without an actual 5-second wait.

---

## Resolver — target coverage

**Status: partially covered; gap is at the retry/telemetry seam.**
`resolver/test/telemetry.test.ts` already thoroughly unit-tests
`computeResolverTelemetry` — the pure function that turns per-chain
staleness and failure counts into `connected \| degraded \| stale \|
inactive` — including multi-chain scenarios and precedence rules
(`inactive > stale > degraded > connected`). That coverage is solid and
doesn't need duplicating here.

What's missing is the layer *underneath* it: proof that the three RPC
failure fixtures, applied to `resolver/src/retry.ts`'s `withRetry` /
`retryRpcCall` / `withTimeout`, actually produce the failure counts and
staleness that `computeResolverTelemetry` then classifies correctly. Target
file: `resolver/test/rpc-degradation.test.ts`, with a small fixture module
mirroring the coordinator's but built around plain async functions instead
of `fetch` (the resolver's retry layer is transport-agnostic):

- **Reset** — an operation that always rejects (`ECONNRESET`-shaped error)
  exhausts `retryRpcCall`'s attempts and throws; the attempt count feeds
  `recentFailureCount`.
- **Delayed** — an operation that never resolves on its own exercises
  `withTimeout`, proving it rejects rather than hanging indefinitely.
- **Recovering** (fails N times, then succeeds) — proves `withRetry`
  succeeds once the underlying RPC recovers, and that the retry count
  feeds `recentRetryCount` without permanently marking the chain degraded.
- **Tie-in assertion** — feed the resulting failure/retry counts into
  `computeResolverTelemetry` directly and assert the snapshot's `state`
  matches what an operator would need to see (`degraded` while retrying
  through the reset fixture, `stale` if the chain's last-event clock never
  advances despite retries, `connected` once recovered). This is the
  "operator-visible health model" assertion the matrix requires — resolver
  has no live `/readyz` RPC check, so `/telemetry` is the only place this
  can be proven.

---

## What "honest" means, precisely

Across all three services, a passing matrix must demonstrate all of the
following — these are the actual acceptance bar, not just "the test
passes":

1. **No false-healthy report.** A degraded chain is never reported `ok:
   true` / `connected`, regardless of which of the three fixtures caused
   the degradation.
2. **Isolation.** Degrading one chain does not flip another chain's status
   or the wrong entry in a multi-chain payload.
3. **No latching.** A chain that recovers is reported healthy on the very
   next check — degradation is not sticky beyond the underlying condition.
4. **No leakage.** RPC URLs, private keys, and other configuration never
   appear in a failure detail or error message returned to a caller.
5. **The aggregate signal matches the per-chain signals.** If any
   individual chain check is unhealthy, the service's overall readiness /
   telemetry state must reflect that — no "some checks failed but overall
   status is still healthy" gap.

---

## Running the matrix

```bash
# Coordinator (implemented)
pnpm --filter @wafflefinance/coordinator exec vitest run test/rpc-degradation.test.ts

# Relayer (once added)
pnpm --filter @wafflefinance/relayer exec vitest run test/rpc-degradation.test.ts

# Resolver (once added)
pnpm --filter @wafflefinance/resolver exec vitest run test/rpc-degradation.test.ts
```

Each file is self-contained and hermetic — no real network access, no live
chain nodes, no coordinator/relayer/resolver process needs to be running.
That's a hard requirement, not an implementation convenience: a
degradation test that itself depends on network conditions can't be a
deterministic regression guardrail.

---

## Provider failover stub rehearsal

The operator procedure in
[`RPC_PROVIDER_FAILOVER_RUNBOOK.md`](RPC_PROVIDER_FAILOVER_RUNBOOK.md) must be
rehearsed against local provider stubs before a real provider switch. Use the
existing degradation fixtures as the stubs: `buildDegradedFetcher` for the
coordinator and `global.fetch` stubs for the relayer (see the sections above).
Add two extra stub responses per chain to the rehearsal:

- **Wrong network:** a well-formed JSON-RPC response whose `eth_chainId`,
  `getNetwork` passphrase, or `getGenesisHash` does not match the configured
  chain. Expected result: abort before any config change; no service reports
  healthy against it.
- **Right network, degraded:** delayed, reset, and HTTP-200-error envelope
  responses from the replacement endpoint. Expected result: `/readyz` flaps
  or degrades for the affected chain, other chains stay isolated, and no
  cursor reset is recorded.

For each rehearsal record: pre-switch cursor values from `/metrics`, the
identity-check output, post-switch `/readyz` / `/health` / `/telemetry`
status, and whether progress resumed without resetting durable cursors. File
the result with the change ticket. These stubs are local and hermetic; no
public RPC endpoint is contacted.
