# Technical Debt Register

> **How to use this document**
> Each item below tracks a known architectural gap, code-quality issue, or planned
> improvement. When an item is resolved, move it to the [Resolved](#resolved) section
> at the bottom with a closing date and a link to the PR or commit that fixed it.
> New items should be added with an `[ ]` status checkbox, a unique ID in the
> `#NNN` format (continue the sequence), and enough context for any contributor to
> understand the problem without reading the original code.

---

## Table of contents

- [Summary](#summary)
- [Relayer](#relayer)
- [Coordinator](#coordinator)
- [Solana / SDK](#solana--sdk)
- [Smart Contracts](#smart-contracts)
- [Frontend](#frontend)
- [SDK — Asset Mappings](#sdk--asset-mappings)
- [E2E Testing](#e2e-testing)
- [Observability](#observability)
- [Documentation & Architecture](#documentation--architecture)
- [Security / Audit](#security--audit)
- [Resolved](#resolved)

---

## Summary

| # | Service | Title | Severity | Status |
|---|---|---|---|---|
| [TD-001](#td-001) | Relayer | `index.ts` is a 134 KB monolith | High | Open |
| [TD-002](#td-002) | Relayer | Hardcoded `ETH_USD_PRICE = 3500` | High | Open |
| [TD-003](#td-003) | Relayer | `console.log` / `console.error` instead of structured logging | Medium | Open |
| [TD-004](#td-004) | Relayer | No cross-service correlation with coordinator `publicId` | Medium | Open |
| [TD-005](#td-005) | Coordinator | Regex-based SQLite→Postgres SQL translation | High | Open |
| [TD-006](#td-006) | Coordinator | Chain listeners start lazily, not at boot | Medium | Open |
| [TD-007](#td-007) | Solana / SDK | Anchor HTLC program not deployed; simulation mode only | High | Open |
| [TD-008](#td-008) | Solana / SDK | `SolanaHtlcSim` is a stub with no real-RPC path | Medium | Open |
| [TD-009](#td-009) | Smart Contracts | `resolverRegistry` is immutable after construction | Medium | Open |
| [TD-010](#td-010) | Smart Contracts | No upgradeability path for Soroban contracts | Medium | Open |
| [TD-011](#td-011) | Smart Contracts | Slash conditions and appeal process undocumented | Low | Open |
| [TD-012](#td-012) | Frontend | `App.tsx` is a 28 KB single-file monolith | Medium | Open |
| [TD-013](#td-013) | SDK | Mainnet asset mappings sparse (native assets only) | High | Open |
| [TD-014](#td-014) | E2E | No real-RPC end-to-end path for any chain leg | High | Open |
| [TD-015](#td-015) | Observability | No distributed tracing across services | Medium | Open |
| [TD-016](#td-016) | Observability | `HEALTH_DASHBOARD.md` and `ORDER_IDS.md` are stubs | Low | Open |
| [TD-017](#td-017) | Docs | No architecture diagram beyond ASCII art in README | Low | Open |
| [TD-018](#td-018) | Security | Independent audit not yet complete; mainnet gated | High | Open |

**Severity guide:** High = blocks production readiness or correctness; Medium = meaningful maintenance or operational burden; Low = cosmetic or convenience.

---

## Relayer

### TD-001

**Title:** `relayer/src/index.ts` is a 134 KB monolith  
**Severity:** High  
**Status:** `[ ]` Open  
**First seen:** 2026-06-30  

**Context:** When the coordinator was extracted from the original `relayer/src/index.ts` (which was 3,276 lines at the time), the coordinator logic was cleanly separated into its own service with a modular architecture. The relayer's own `src/index.ts` was not similarly split. It now sits at ~134 KB and contains startup logic, polling loops, payment detection, order state mutation, Stellar transaction construction, Ethereum event handling, safety-deposit calculation, and health routes all in one file.

**Impact:** Any change to relayer behaviour requires navigating a single large file. Bugs are harder to isolate. Unit testing individual responsibilities is effectively impossible without importing the entire entry point. Onboarding cost for new contributors is high.

**Next steps:**
1. Audit `index.ts` to identify logical modules (chain listeners, order state machines, payment handlers, health/metrics).
2. Extract each module to the corresponding sub-directory that already exists (`src/listeners/`, `src/services/`, `src/routes/`).
3. Reduce `src/index.ts` to a thin bootstrap (≤ 100 lines), mirroring the pattern used in `coordinator/src/index.ts`.
4. Add unit tests for each extracted module.

**Reference:** `relayer/src/index.ts` (134 KB), `coordinator/README.md` ("This replaces the 3276-line monolithic `relayer/src/index.ts` from v1.")

---

### TD-002

**Title:** `ETH_USD_PRICE` is hardcoded to `3500` in the relayer  
**Severity:** High  
**Status:** `[ ]` Open  
**First seen:** 2026-06-30  

**Context:** `relayer/src/index.ts` contains `const ETH_USD_PRICE = 3500;` which is used in the `calculateDynamicSafetyDeposit` helper. The safety deposit tiers are denominated in USD but converted using this fixed price. When the actual ETH price diverges from $3,500 the tiers drift — safety deposits become either too small (under-incentivising resolvers) or too large (degrading UX).

**Impact:** Incorrect safety deposit sizing. Under-sized deposits reduce resolver incentive to process swaps; over-sized deposits make swaps less competitive. The risk is proportional to ETH price volatility.

**Next steps:**
1. Feed a live price oracle into the relayer (the coordinator's `QuoteService` already queries CoinGecko — share or call that endpoint).
2. Alternatively, accept `ETH_USD_PRICE` as an environment variable so operators can keep it current without code changes.
3. Cache the oracle price with a TTL (e.g. 60 s) and fall back to a configurable default.
4. Add a test that asserts the safety deposit calculation uses a non-constant price.

**Reference:** `relayer/src/index.ts` (`calculateDynamicSafetyDeposit`), `coordinator/src/services/quote-service.ts`.

---

### TD-003

**Title:** Relayer uses `console.log` / `console.error` instead of structured logging  
**Severity:** Medium  
**Status:** `[ ]` Open  
**First seen:** 2026-06-30  

**Context:** The relayer README explicitly notes "A migration from `console.log`/`console.error` to structured JSON logging via Winston is planned but not yet implemented." The coordinator already uses `pino`; the relayer's unstructured output makes log aggregation, alerting, and cross-service correlation harder.

**Impact:** Relayer logs cannot be queried reliably in JSON-based log pipelines (Datadog, CloudWatch Logs Insights, Grafana Loki). Structured fields like `orderId`, `chain`, and `level` are unavailable for filtering and alerting.

**Next steps:**
1. Add `pino` (preferred, already used in the coordinator) or Winston to `relayer/package.json`.
2. Replace all `console.log` / `console.error` calls with the logger.
3. Ensure `orderId` and `orderHash` log fields follow the same key names as the coordinator.
4. Update `relayer/README.md` to remove the "planned" callout once done.

**Reference:** `relayer/README.md` ("Winston migration planned"), coordinator uses `pino` in `coordinator/src/logger.ts`.

---

### TD-004

**Title:** Relayer logs carry no cross-service correlation with coordinator `publicId`  
**Severity:** Medium  
**Status:** `[ ]` Open  
**First seen:** 2026-06-30  

**Context:** The relayer README states: "Full cross-service correlation with the coordinator's `publicId` is not currently implemented." Relayer logs use on-chain `orderId` (bigint) and `orderHash` (hashlock). The coordinator uses its own `publicId` UUID. Tracing a single swap across both services requires manual mapping.

**Impact:** Incident investigation requires manual cross-referencing between two log formats. Automated alerting across services cannot correlate the same swap.

**Next steps:**
1. When the relayer posts or queries an order to/from the coordinator, store and log the returned `publicId`.
2. Include `publicId` as a structured log field alongside `orderId` and `orderHash` in all relayer log lines that reference a specific order.
3. This naturally unblocks proper distributed tracing (see [TD-015](#td-015)).

**Reference:** `relayer/README.md` (Known Gaps section).

---

## Coordinator

### TD-005

**Title:** Regex-based SQLite→Postgres SQL translation is brittle  
**Severity:** High  
**Status:** `[ ]` Open  
**First seen:** 2026-06-30  

**Context:** The coordinator's `db.ts` `PostgresStatement` class converts SQLite syntax to Postgres using regex substitutions. The coordinator README documents six known edge cases, the most dangerous of which is: *"Named params inside string literals — `':named_param'` in SQL is still converted because the regex `:(\w+)` cannot distinguish SQL code from string contents."* This means a carefully crafted order field value could corrupt a generated Postgres query.

**Impact:** The current query set is safe because it uses parameterized values rather than inline literals. However, any future contributor adding a query with a string literal containing a colon-prefixed word will hit a silent, hard-to-debug data corruption. The translation layer is a maintenance liability.

**Next steps:**
1. Replace the regex translator with a proper SQL abstraction. Options in priority order:
   - Adopt `kysely` (zero-runtime-dep query builder with SQLite and Postgres dialects).
   - Or split the codebase into two dialect-specific query files and drop the translation layer entirely.
2. Until the translator is replaced, add an ESLint or CI rule that flags any raw SQL string containing `':'` outside a comment.
3. Expand the existing `db-postgres.test.ts` to cover the documented edge cases as regression tests.

**Reference:** `coordinator/README.md` (Known Edge Cases section), `coordinator/src/persistence/db.ts`.

---

### TD-006

**Title:** Chain listeners start lazily on first order, not at boot  
**Severity:** Medium  
**Status:** `[ ]` Open  
**First seen:** 2026-06-30  

**Context:** Ethereum and Soroban event listeners are initialised on the first incoming swap order rather than at coordinator startup. The `docs/DEVELOPMENT.md` troubleshooting section notes: *"Chain listeners start lazily on the first swap order, not at boot. Send a `POST /api/wake` or announce an order to trigger listener initialisation."* This means a freshly restarted coordinator is invisible to on-chain events until a swap is announced.

**Impact:** On-chain events emitted in the window between coordinator restart and first order announcement are missed and not replayed. In a production restart scenario (rolling deploy, crash recovery) this window can result in permanently missed events — specifically, `OrderClaimed` events that the coordinator needs to relay the secret to the other chain.

**Next steps:**
1. Move listener startup to the coordinator boot sequence, not the first order handler.
2. Remove the `POST /api/wake` workaround and document the change.
3. Confirm that the event reconciliation mechanism (`coordinator/EVENT_RECONCILIATION.md`) covers any gap that existed before this fix, and add a test for coordinator restart mid-swap.

**Reference:** `docs/DEVELOPMENT.md` (Troubleshooting), `coordinator/EVENT_RECONCILIATION.md`.

---

## Solana / SDK

### TD-007

**Title:** Anchor HTLC program not deployed; Solana leg runs in simulation mode  
**Severity:** High  
**Status:** `[ ]` Open  
**First seen:** 2026-06-30  

**Context:** The Solana HTLC Anchor program has been fully authored in the SDK but has not been deployed to Solana devnet. `SolanaHTLCClient` detects the absence of `SOLANA_HTLC_PROGRAM` and falls back to simulation mode. The README and `README` both clearly state this. All Solana swaps are therefore non-settling on-chain — they run through the simulator only.

**Impact:** Solana is listed as a supported route in the UI (with a "simulation mode" note), but funds are never actually locked or settled on the Solana chain. The ETH/SOL and SOL/ETH routes cannot be used in production.

**Next steps:**
1. Deploy the Anchor HTLC program to Solana devnet.
2. Set `SOLANA_HTLC_PROGRAM` in coordinator and relayer configuration.
3. Run the e2e harness against a real Solana devnet RPC (requires completing [TD-008](#td-008)).
4. Update README status table from "🟡 Simulation mode" to "✅ Live" on devnet.
5. Gate mainnet Solana activation on the independent security audit (see [TD-018](#td-018)).

**Reference:** `packages/sdk/src/solana/`, `README.md` (Solana integration section).

---

### TD-008

**Title:** `SolanaHtlcSim` is a stub with no real-RPC path in the e2e harness  
**Severity:** Medium  
**Status:** `[ ]` Open  
**First seen:** 2026-06-30  

**Context:** `e2e/sim.ts` contains `SolanaHtlcSim` which implements the `HtlcSim` interface with in-memory state. The differential harness in `e2e/cross-chain.test.ts` runs all three chain sims through the same scenarios, but the Solana case never exercises real RPC calls or actual Anchor program instructions.

**Impact:** The Solana e2e leg provides no signal about real-chain behaviour. Regressions in the Anchor program, Solana RPC interaction, or account model can go undetected until deployment.

**Next steps:**
1. After the Anchor program is deployed to devnet ([TD-007](#td-007)), add a real-RPC e2e path that uses a funded devnet keypair.
2. Make the real-RPC path conditional on `SOLANA_RPC_URL` and `SOLANA_HTLC_PROGRAM` being set, so the in-memory sim path continues to work in CI without devnet access.

**Reference:** `e2e/sim.ts` (`SolanaHtlcSim`), `e2e/cross-chain.test.ts`.

---

## Smart Contracts

### TD-009

**Title:** `resolverRegistry` is immutable after `HTLCEscrow` construction  
**Severity:** Medium  
**Status:** `[ ]` Open  
**First seen:** 2026-06-30  

**Context:** `HTLCEscrow.sol`'s `resolverRegistry` field is set in the constructor and cannot be changed. The contracts README states: *"The `resolverRegistry` field is immutable after construction. To change the registry, deploy a new `HTLCEscrow` and migrate."* This was a deliberate security decision (no admin escape hatch) but creates a rigid operational dependency.

**Impact:** If `ResolverRegistry` is found to have a bug, needs an upgrade, or the registry address changes (e.g. new deployment on a new version), a full `HTLCEscrow` redeployment is required. Any in-flight orders on the old escrow must be settled or refunded before migration is complete — a potentially multi-day window.

**Next steps:**
1. Assess whether the deployment overhead is acceptable pre-mainnet (currently low risk on testnet).
2. For v2 of the contracts (post-audit), evaluate a time-locked registry update mechanism that preserves the no-admin-key-for-funds guarantee.
3. Document the migration runbook (freeze new order creation on old escrow → wait for in-flight orders to settle → deploy new escrow → update coordinator and relayer config).

**Reference:** `contracts/contracts/HTLCEscrow.sol`, `contracts/README.md` (ResolverRegistry Integration section).

---

### TD-010

**Title:** No upgradeability path for deployed Soroban contracts  
**Severity:** Medium  
**Status:** `[ ]` Open  
**First seen:** 2026-06-30  

**Context:** The Soroban `wafflefinance-htlc` and `wafflefinance-resolver-registry` contracts are deployed as fixed WASM blobs. Soroban supports an `update_current_contract_wasm` admin function but neither contract exposes it. Any bug fix or feature addition requires a new deployment and a coordinated migration of active state.

**Impact:** On testnet this is an inconvenience. On mainnet (post-audit), a critical bug would require a new contract deployment, emergency user communication, and manual migration of any in-flight orders — a high-severity incident.

**Next steps:**
1. Decide before mainnet launch whether to add an admin-gated `upgrade()` entrypoint with a timelock (e.g. 48-hour delay).
2. If upgradeability is added, ensure the audit scope includes the upgrade path.
3. Document the upgrade procedure in `soroban/README.md`.

**Reference:** `soroban/contracts/htlc/`, `soroban/README.md`.

---

### TD-011

**Title:** Slash conditions and appeal process are undocumented  
**Severity:** Low  
**Status:** `[ ]` Open  
**First seen:** 2026-06-30  

**Context:** `ResolverRegistry` on both Ethereum and Stellar includes slashing logic. Resolver operators staking into the registry can be slashed, but the conditions triggering a slash and any appeal or dispute mechanism are not documented anywhere in the repository.

**Impact:** Resolver operators running or considering running nodes cannot assess their financial risk. This reduces resolver participation and undermines the permissionless resolver model.

**Next steps:**
1. Document slash conditions in `resolver/README.md` and/or a new `docs/RESOLVER_ECONOMICS.md`.
2. If an appeal process exists, document it; if it doesn't, document that slashes are final and on what governance it depends.
3. Add the slash conditions as comments in `ResolverRegistry.sol`.

**Reference:** `contracts/contracts/ResolverRegistry.sol`, `soroban/contracts/resolver-registry/`.

---

## Frontend

### TD-012

**Title:** `frontend/src/App.tsx` is a 28 KB single-file monolith  
**Severity:** Medium  
**Status:** `[ ]` Open  
**First seen:** 2026-06-30  

**Context:** `App.tsx` is 28 KB (~900+ lines) containing routing logic, wallet connection, swap state, transaction history, and UI rendering. `frontend/MAINTAINABILITY.md` documents ESLint size limits for `src/components/` (450 lines / 80 statements / 20 cyclomatic complexity) but `App.tsx` itself sits outside the components folder and is not subject to those limits. The `BridgeForm.tsx` split into `src/features/bridge` is described as ongoing.

**Impact:** Any change to wallet connection, routing, or swap flow touches the same 900-line file as UI-only changes, creating a high merge-conflict surface. New features (e.g. Solana wallet support expansion) are harder to add in isolation.

**Next steps:**
1. Move wallet connection logic to `src/features/wallet/` or `src/hooks/`.
2. Move transaction history to `src/features/history/`.
3. Move route definitions to a dedicated router file.
4. Reduce `App.tsx` to a layout shell (≤ 150 lines) wiring together the feature modules.
5. Extend the ESLint size rules to `App.tsx` explicitly to prevent regression.

**Reference:** `frontend/src/App.tsx` (28 KB), `frontend/MAINTAINABILITY.md`.

---

## SDK — Asset Mappings

### TD-013

**Title:** Mainnet asset mappings are sparse — native assets only  
**Severity:** High  
**Status:** `[ ]` Open  
**First seen:** 2026-06-30  

**Context:** `packages/sdk/ASSET_MAPPING_CONTRACT.md` documents that the mainnet mappings cover only native ETH, native XLM, and native SOL. Testnet supports additional assets (USDC on Sepolia, devnet USDC on Solana). No ERC-20 or stablecoin routes are available on mainnet. With mainnet launch gated until Q1 2027, this is a pre-launch blocker.

**Impact:** A mainnet launch with only native-to-native routes would exclude stablecoin bridges — a significant portion of expected user demand. Adding mappings late requires a coordinated SDK release, contract verification, and frontend update.

**Next steps:**
1. Define the target mainnet asset set (USDC, WBTC, etc.) as a tracked issue before the audit.
2. For each new asset pair, add the mapping to `packages/sdk/src/assets/index.ts`, add round-trip tests, and update `ASSET_MAPPING_CONTRACT.md`.
3. Verify that the coordinator's `QuoteService` can price the new pairs.
4. Confirm that the on-chain contracts support ERC-20 assets (the `HTLCEscrow` already handles ERC-20 via `token` address in `createOrder`).

**Reference:** `packages/sdk/ASSET_MAPPING_CONTRACT.md` (Mainnet Mappings section), `packages/sdk/src/assets/`.

---

## E2E Testing

### TD-014

**Title:** No real-RPC end-to-end path for any chain leg in CI  
**Severity:** High  
**Status:** `[ ]` Open  
**First seen:** 2026-06-30  

**Context:** The `e2e/` harness is a differential test suite that runs three in-memory simulators (`EvmHtlcSim`, `SorobanHtlcSim`, `SolanaHtlcSim`) against the same scenarios. It validates SDK hash primitives and state-machine consistency but does not exercise real RPC calls, wallet signing, or on-chain transactions. All three sims bypass the network entirely.

**Impact:** Regressions in ABI encoding, RPC edge cases, gas estimation, transaction serialization, or Soroban contract invocation are not caught by the e2e suite. The suite passing gives false confidence that real-chain behaviour is tested.

**Next steps:**
1. Add an optional real-RPC e2e mode gated on environment variables (`SEPOLIA_RPC_URL`, `SOROBAN_RPC_URL`, `SOLANA_RPC_URL`).
2. Fund a set of dedicated test wallets and add them as GitHub Actions secrets (never commit private keys).
3. Run the real-RPC suite on a nightly schedule or on PRs that touch chain client code.
4. At minimum, cover: ETH lock → Stellar claim, Stellar lock → ETH claim.

**Reference:** `e2e/sim.ts`, `e2e/cross-chain.test.ts`.

---

## Observability

### TD-015

**Title:** No distributed tracing across coordinator, relayer, and resolver  
**Severity:** Medium  
**Status:** `[ ]` Open  
**First seen:** 2026-06-30  

**Context:** Each service emits logs independently. There is no trace context (e.g. OpenTelemetry `traceId`) propagated across service boundaries. Combined with the unresolved cross-service `publicId` correlation ([TD-004](#td-004)), end-to-end tracing of a swap requires manually joining log lines across three services.

**Impact:** Diagnosing latency or failure in cross-service flows (e.g. why a specific swap took 45 seconds) requires manual log archaeology. On-call engineers face a high mean-time-to-diagnosis.

**Next steps:**
1. Resolve [TD-004](#td-004) first to establish `publicId` correlation.
2. Add OpenTelemetry SDK to coordinator, relayer, and resolver.
3. Propagate `traceId` via HTTP headers on inter-service requests.
4. Export traces to a collector (Jaeger, Tempo, or AWS X-Ray).

**Reference:** Coordinator uses `pino`; relayer uses `console.*`; resolver uses `pino` (`resolver/src/logger.ts`).

---

### TD-016

**Title:** `HEALTH_DASHBOARD.md` and `ORDER_IDS.md` are minimal stubs  
**Severity:** Low  
**Status:** `[ ]` Open  
**First seen:** 2026-06-30  

**Context:** `docs/HEALTH_DASHBOARD.md` (1.4 KB) and `docs/ORDER_IDS.md` (1.4 KB) exist but contain minimal content. The dashboard doc has no Grafana screenshot or sample dashboard JSON. The ORDER_IDS doc does not cross-reference the relayer's on-chain `orderId` vs coordinator `publicId` distinction noted in the relayer README.

**Impact:** Operators setting up monitoring have no reference Grafana dashboard. Developers integrating with the API may confuse the relayer's `orderId` with the coordinator's `publicId`.

**Next steps:**
1. Export the reference Grafana dashboard from `coordinator/ops/grafana/` as JSON and link it from `HEALTH_DASHBOARD.md`.
2. Expand `ORDER_IDS.md` with a table mapping the four ID types (on-chain EVM orderId, on-chain Stellar orderId, coordinator `publicId`, relayer `orderHash`/hashlock) and their relationship.

**Reference:** `docs/HEALTH_DASHBOARD.md`, `docs/ORDER_IDS.md`, `coordinator/ops/grafana/`.

---

## Documentation & Architecture

### TD-017

**Title:** No formal architecture diagram beyond ASCII art in the README  
**Severity:** Low  
**Status:** `[ ]` Open  
**First seen:** 2026-06-30  

**Context:** The README contains an ASCII dependency diagram in the OPERATIONS.md. There is no formal architecture diagram showing the data flow between the six services (coordinator, relayer, resolver, frontend, and the three on-chain contracts) in a format that can be maintained alongside code.

**Impact:** Onboarding new contributors takes longer. External auditors (relevant for [TD-018](#td-018)) have no single diagram to orient them.

**Next steps:**
1. Create an architecture diagram in `docs/` using a text-as-diagram format (Mermaid or C4 PlantUML) so it can be reviewed and updated in PRs.
2. Link it from the README and from `docs/DEVELOPMENT.md`.
3. The diagram should cover: user → frontend → coordinator → relayer → chains, and the resolver path.

---

## Security / Audit

### TD-018

**Title:** Independent smart contract audit not yet complete; mainnet blocked  
**Severity:** High  
**Status:** `[ ]` Open  
**First seen:** 2026-06-30  
**Target:** Q1 2027  

**Context:** The README explicitly gates mainnet activation on an independent security audit: *"Mainnet gated until independent audit (Q1 2027)."* The `VITE_MAINNET_ENABLED` environment variable is the toggle. Several other items in this register (TD-007, TD-009, TD-010, TD-013) have mainnet implications that should be resolved before the audit scope is finalised.

**Impact:** Users cannot use the protocol on mainnet with real assets until the audit is complete and its findings addressed. Any critical finding post-audit that requires a contract redeployment will delay launch further.

**Next steps:**
1. Before engaging auditors: resolve or document TD-007, TD-009, TD-010, TD-013 as in-scope items.
2. Provide auditors with: contract source, deployment scripts, the trust model section from the README, and `soroban/docs/HTLC_IDL.md`.
3. Track audit findings as new items in this register once the report is received.
4. Set `VITE_MAINNET_ENABLED=true` and the mainnet RPC/contract addresses only after all critical and high findings are resolved.

**Reference:** `README.md` (Status note), `env.example` (`VITE_MAINNET_ENABLED`).

---

## Resolved

> Items moved here are complete. Include the resolution date and a PR or commit
> reference so the history is traceable.

| # | Title | Resolved | Reference |
|---|---|---|---|
| — | *(no resolved items yet)* | — | — |
