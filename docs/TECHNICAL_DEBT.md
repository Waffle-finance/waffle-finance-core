# Technical Debt Register

> **Last updated:** 2026-06-30
> **Maintainer:** Engineering team
> **How to update:** When an item is resolved, mark it ✅ and note the PR/commit. When new debt is identified, add it under the relevant service with the date discovered.

This register tracks architectural debt, known gaps, and planned improvements across all WaffleFinance services. Items are grouped by service and tagged by severity.

**Severity key**

| Tag | Meaning |
|-----|---------|
| 🔴 HIGH | Blocks mainnet, creates security risk, or causes data loss |
| 🟡 MED | Degrades reliability, observability, or operator experience |
| 🟢 LOW | Code quality, developer experience, or future-proofing |

---

## Table of Contents

- [Platform-wide](#platform-wide)
- [contracts/ — Solidity (Ethereum)](#contracts--solidity-ethereum)
- [soroban/ — Rust (Stellar)](#soroban--rust-stellar)
- [packages/sdk](#packagessdk)
- [coordinator/](#coordinator)
- [relayer/](#relayer)
- [resolver/](#resolver)
- [frontend/](#frontend)
- [e2e/](#e2e)
- [Roadmap summary](#roadmap-summary)

---

## Platform-wide

### TD-000 · Solana activation pending Anchor program deployment 🔴

**Discovered:** project inception  
**Location:** `packages/sdk/src/solana/`, `coordinator/src/listeners/solana-listener.ts`, `relayer/src/utils/solana-config.ts`, `resolver/src/listeners/`

**Context:**  
The entire Solana leg — SDK client, coordinator listener, relayer integration, resolver settle path, and E2E simulator — is wired end-to-end but deliberately held in simulation mode until the Anchor HTLC program is deployed on devnet. The SDK enters simulation mode whenever `programId` equals `"PLACEHOLDER"` or is empty. The relayer's `logSolanaStatus` detects this and sets the `solana_placeholder_mode` Prometheus gauge.

**Impact:**  
SOL swaps are not settled on-chain. The UI exposes the route and records orders, but no actual Solana funds move.

**Next steps:**
1. Deploy the Anchor HTLC program to Solana devnet.
2. Set `SOLANA_HTLC_PROGRAM` in coordinator and relayer env.
3. Run the E2E harness against devnet to validate the full path.
4. Remove `SolanaHtlcSim` stub and replace with a live-network fixture.

---

### TD-001 · Mainnet gated until independent security audit 🔴

**Discovered:** project inception  
**Location:** `frontend/src/config/networks.ts` (`isMainnetEnabled`), `VITE_MAINNET_ENABLED` env flag, `README.md`

**Context:**  
All mainnet flows are blocked behind `VITE_MAINNET_ENABLED=true`. The relayer also carries separate mainnet contract addresses (1inch `EscrowFactory`) and ABIs that differ from the testnet contract. The audit is targeted for Q1 2027.

**Impact:**  
No mainnet traffic. Mainnet code paths are largely untested in CI.

**Next steps:**
1. Commission independent smart-contract audit (target: Q1 2027).
2. Add CI job that builds and type-checks the mainnet config path.
3. Write integration tests for the 1inch `EscrowFactory` ABI path.
4. Set `VITE_MAINNET_ENABLED=true` and `NETWORK_MODE=mainnet` only after audit sign-off.

---

## contracts/ — Solidity (Ethereum)

### TD-010 · HTLCEscrow resolver registry is immutable after deploy 🟡

**Discovered:** 2026-06-30  
**Location:** `contracts/contracts/HTLCEscrow.sol` — `resolverRegistry` field declared `immutable`

**Context:**  
`resolverRegistry` is set once in the constructor and cannot be changed. To point to a new registry (e.g. after a registry upgrade or migration) a new `HTLCEscrow` must be deployed and all inflight orders migrated or expired. This is by design for the trust model, but there is no documented upgrade path or migration script.

**Impact:**  
Registry upgrades require a new contract deployment and a coordinated migration. Without a runbook, operator error during migration could cause a window where new orders cannot be created.

**Next steps:**
1. Write and merge a `docs/UPGRADE_PATH.md` covering the HTLCEscrow → new-registry migration procedure.
2. Add a `scripts/migrate-escrow.ts` helper that pauses order intake, drains inflight orders, and switches coordinator config to the new address.

---

### TD-011 · No on-chain enforcement that ResolverRegistry owner is a multisig 🟡

**Discovered:** 2026-06-30  
**Location:** `contracts/contracts/ResolverRegistry.sol` — constructor `_owner` parameter

**Context:**  
The contract uses `Ownable2Step`, which is secure, but the constructor accepts any address as `_owner`. The README and NatSpec say "intended to be a multisig or DAO," but nothing in the deployment script enforces this. On testnet the owner is a single EOA.

**Impact:**  
If the owner key is compromised on mainnet, an attacker can slash all resolvers, deactivating the network. Funds in the HTLC are not at risk (registry and escrow are separate), but order creation would be blocked.

**Next steps:**
1. Add a `require(Address.isContract(_owner), "owner must be a contract")` guard in the constructor, or add a deployment-time check in `scripts/deploy.ts`.
2. Transfer ownership to a Safe multisig before any mainnet deployment; document the address in `deployments.mainnet.json`.

---

### TD-012 · ERC20-only token support; no multi-token routing 🟢

**Discovered:** 2026-06-30  
**Location:** `contracts/contracts/HTLCEscrow.sol` — `createOrder` `token` parameter

**Context:**  
The escrow supports native ETH (token = `address(0)`) and any single ERC20 per order. There is no batching, multi-hop routing, or DEX integration. Extending to WBTC, USDC, or other tokens requires only a new deployment with the correct `stakeAsset`/resolver config, but the SDK asset mappings and coordinator quote logic would also need updating.

**Impact:**  
Limited to ETH ↔ XLM/SOL swaps. No stablecoin or other ERC20 routes.

**Next steps:**
1. Identify first additional token pair (e.g. USDC ↔ USDC).
2. Update `packages/sdk/src/assets/index.ts` asset mappings.
3. Update quote-service fee tiers for non-ETH routes.

---

### TD-013 · No invariant or fuzz tests for HTLCEscrow edge cases 🟢

**Discovered:** 2026-06-30  
**Location:** `contracts/test/foundry/`

**Context:**  
There are Hardhat + Chai unit tests and a Foundry configuration (`foundry.toml`) but no Foundry invariant (`invariant_*`) or stateful fuzz tests that exercise the pull-payment accounting, reentrancy guards, and concurrent claim/refund races at scale.

**Impact:**  
Edge cases in the pull-payment fallback (`_pendingWithdrawals`) and the safety-deposit accounting may only surface under adversarial conditions.

**Next steps:**
1. Add a Foundry `InvariantHTLCEscrow.t.sol` that asserts `sum(_pendingWithdrawals) + sum(locked order amounts) == contract ETH balance` at all times.
2. Add a fuzz test over `createOrder` / `claimOrder` / `refundOrder` with random timelocks, amounts, and token addresses.

---

## soroban/ — Rust (Stellar)

### TD-020 · TypeScript bindings require manual regeneration after each deploy 🟡

**Discovered:** 2026-06-30  
**Location:** `soroban/README.md` — "After deploy, regenerate the TypeScript bindings"

**Context:**  
After every Soroban contract deployment the SDK's TypeScript bindings (`packages/sdk/src/soroban/htlc-bindings/`) must be regenerated manually with `stellar contract bindings typescript`. There is no CI step, Makefile target, or script that automates this. If bindings drift from the deployed contract, the coordinator and frontend silently use stale types.

**Impact:**  
A developer can forget to regenerate bindings after a redeploy, causing type mismatches that only surface at runtime.

**Next steps:**
1. Add a `soroban/scripts/regen-bindings.sh` that reads `SOROBAN_HTLC_TESTNET` from `.env` and runs the `stellar contract bindings typescript` command.
2. Gate the SDK build on a `pnpm --filter @wafflefinance/sdk check-bindings` script that compares the IDL hash against the committed bindings.

---

### TD-021 · No documented procedure for Soroban admin key rotation 🟡

**Discovered:** 2026-06-30  
**Location:** `soroban/contracts/htlc/`, `soroban/README.md`

**Context:**  
The Soroban HTLC has an `admin` role that can update `min_safety_deposit` and set the resolver registry address. There is no documented runbook for rotating the admin key (e.g. after a key compromise or multisig transition). The deploy script sets admin to a single `deployer` identity.

**Impact:**  
On mainnet, a compromised admin key would allow an attacker to lower the minimum safety deposit to zero or point the registry at a malicious contract. User funds in existing orders are not at risk, but future orders could be.

**Next steps:**
1. Write a `soroban/docs/ADMIN_KEY_ROTATION.md` runbook.
2. Transfer admin to a Stellar multisig account before mainnet launch.
3. Add a pre-mainnet checklist item in `docs/OPERATIONS.md`.

---

## packages/sdk

### TD-030 · SolanaHTLCClient simulation mode — no real on-chain calls 🔴

**Discovered:** project inception  
**Location:** `packages/sdk/src/solana/index.ts` lines 389–395

**Context:**  
When `programId` is `"PLACEHOLDER"` or empty, `createOrder`, `claimOrder`, and `refundOrder` return mock signatures without sending any transactions. This is the expected behaviour until TD-000 is resolved, but the simulation path has no test coverage of failure modes (e.g. account-not-found, insufficient SOL balance).

**Impact:**  
Solana error handling is untested. When the real program is deployed and simulation mode is disabled, edge-case failures may surface unexpectedly.

**Next steps:**
1. Add unit tests for the error paths (bad programId format, RPC timeout, account-not-found).
2. Resolve TD-000 (Anchor deploy) to enable the live code path.

---

### TD-031 · Devnet USDC address is hardcoded in asset mappings 🟡

**Discovered:** 2026-06-30  
**Location:** `packages/sdk/src/assets/index.ts` — `resolveSolanaAsset`

**Context:**  
The Solana asset mappings hard-code a devnet USDC mint address. Mainnet uses native SOL. If the devnet USDC mint changes (e.g. Circle rotates it) or additional tokens are added, the file must be manually updated and the SDK rebuilt.

**Impact:**  
Wrong USDC mint on devnet would cause `createOrder` to reference a non-existent token, failing silently in simulation mode and loudly on a real devnet deployment.

**Next steps:**
1. Move the devnet USDC mint to an env variable (`SOLANA_DEVNET_USDC_MINT`) and read it from `@wafflefinance/config`.
2. Add a validation step in `packages/sdk/scripts/` that pings the RPC to confirm the mint account exists before the SDK build completes.

---

### TD-032 · Dual-hash (sha256 + keccak256) mechanism not documented outside code 🟢

**Discovered:** 2026-06-30  
**Location:** `contracts/contracts/HTLCEscrow.sol` NatSpec, `packages/sdk/src/secrets/index.ts`

**Context:**  
`HTLCEscrow.claimOrder` accepts a preimage if either `sha256(preimage) == hashlock` OR `keccak256(preimage) == hashlock`. This cross-chain compatibility design is explained only in NatSpec comments; it is not in any user-facing or operator-facing documentation. Third-party resolver implementers may not be aware of it.

**Impact:**  
External resolver implementations might use the wrong hash function and fail to claim orders, leading to unnecessary refunds.

**Next steps:**
1. Add a "Hashlock scheme" section to `docs/DEVELOPMENT.md` explaining the dual-hash design.
2. Add a cross-reference from `packages/sdk/README.md`.

---

## coordinator/

### TD-040 · Hand-rolled SQLite → PostgreSQL SQL translation layer 🟡

**Discovered:** 2026-06-30  
**Location:** `coordinator/src/persistence/db.ts` — `PostgresStatement.convertSqliteToPostgres`

**Context:**  
The coordinator must run on both SQLite (dev/single-node) and PostgreSQL (production). Rather than using an ORM or query builder, the persistence layer manually translates named parameters (`:name`) to positional parameters (`$N`) and rewrites `strftime` expressions at runtime. This translation is fragile: complex queries with subqueries, CTEs, or dialect-specific functions may fail silently or produce incorrect results.

**Impact:**  
A query that works in SQLite may break in Postgres in a way that only manifests in production. The current test suite exercises the PostgreSQL path via Docker (`TEST_WITH_POSTGRES=true`) but coverage is not exhaustive.

**Next steps:**
1. Evaluate migrating to [Kysely](https://kysely.dev/) or [Drizzle ORM](https://orm.drizzle.team/) with dialect adapters, which handle parameter translation and dialect differences natively.
2. In the interim, add a linting rule that flags any raw SQL containing `:named` parameters without an accompanying Postgres-equivalent test.
3. Expand the `db-postgres.test.ts` suite to cover all queries in `orders-repo.ts`.

---

### TD-041 · SECRET_STORAGE_KEY is optional — secrets stored in plaintext if unset 🔴

**Discovered:** 2026-06-30  
**Location:** `coordinator/src/services/secret-service.ts`, `packages/config/src/schema.ts` — `secretStorageKey` optional field

**Context:**  
If `SECRET_STORAGE_KEY` is not set in the environment, the coordinator stores HTLC preimages unencrypted in the database. The config schema (`coordinatorConfigSchema`) marks the field as optional with no default. A developer starting the coordinator for the first time without reading the operations guide will inadvertently run with plaintext secrets.

**Impact:**  
Any actor with read access to the SQLite file or Postgres database can extract all preimages, potentially allowing them to claim orders on other chains before the legitimate beneficiary.

**Next steps:**
1. Make `SECRET_STORAGE_KEY` required in `coordinatorConfigSchema` (remove `.optional()`).
2. Provide a `pnpm --filter @wafflefinance/coordinator generate-key` helper that prints a random 32-byte hex key to stdout for operators to paste into `.env`.
3. Add a startup warning (or hard failure) if the key length is below 32 bytes.

---

### TD-042 · Chain listeners start lazily — requires POST /api/wake to activate 🟡

**Discovered:** 2026-06-30  
**Location:** `coordinator/src/listeners/`, `docs/DEVELOPMENT.md` troubleshooting section

**Context:**  
Chain listeners (Ethereum, Soroban, Solana) are initialised on the first incoming swap order or an explicit `POST /api/wake`, not at process startup. This is a deliberate optimisation to avoid unnecessary RPC load during idle periods, but it means a freshly deployed coordinator will miss on-chain events until the first order arrives.

**Impact:**  
In a fresh deployment with no traffic, events that occur before the first `wake` call are not processed until the next reconciliation run. The 48-hour reconciliation lookback mitigates this, but there is a window of up to `COORDINATOR_POLL_INTERVAL_MS` (default 15 s) where events may be delayed.

**Next steps:**
1. Add a `COORDINATOR_EAGER_START=true` env flag that triggers listener startup at boot.
2. Alternatively, trigger `wake` automatically in the startup sequence after the health check passes.
3. Document the current behaviour explicitly in `docs/OPERATIONS.md`.

---

### TD-043 · Reconciler does not track last-processed ledger per order 🟢

**Discovered:** 2026-06-30  
**Location:** `coordinator/src/reconciliation/reconciler.ts` line ~117 — comment: "We don't track last processed ledger per order, so this is a simplified check"

**Context:**  
The reconciler re-scans a fixed lookback window (48 h) on every run and relies on idempotent event processing to skip already-handled events. It does not store a per-order high-water mark. For a high-volume deployment this means re-processing the same events on every reconciliation cycle, which is wasteful and can produce noisy logs.

**Impact:**  
Increased RPC call volume and log noise in high-throughput scenarios. No correctness issue because event processing is idempotent.

**Next steps:**
1. Add a `last_eth_block` / `last_soroban_ledger` / `last_solana_slot` column per order in the DB schema.
2. Update the reconciler to use those cursors as the lower bound instead of the fixed lookback window.

---

### TD-044 · No WebSocket push — clients must poll for order updates 🟢

**Discovered:** 2026-06-30  
**Location:** `coordinator/src/server/routes/orders.ts`, `frontend/src/services/`

**Context:**  
The coordinator exposes only REST endpoints. The frontend and relayer poll `GET /orders/:id` on a timer to detect state changes. There is no server-sent events (SSE) or WebSocket channel.

**Impact:**  
Each polling client adds unnecessary load to the coordinator. In future, as order volume grows, polling latency will mean users see stale order states for up to one poll interval.

**Next steps:**
1. Add an SSE endpoint (`GET /orders/:id/events`) that streams state transitions for a given order.
2. Update the frontend to switch from polling to SSE for the active-order status display.

---

## relayer/

### TD-050 · relayer/src/index.ts is a 134 KB monolith 🟡

**Discovered:** 2026-06-30  
**Location:** `relayer/src/index.ts` (134 KB, ~3 500+ lines)

**Context:**  
The relayer entry point contains the network config, ABI definitions, price cache, safety deposit calculation, event handlers, and startup logic in a single file. The relayer's own `README.md` acknowledges a planned Winston migration and structural refactor. Separate modules already exist under `relayer/src/services/`, `listeners/`, `events/`, and `utils/`, but much of the routing and orchestration logic remains in `index.ts`.

**Impact:**  
High cognitive load when debugging. Difficult to unit-test individual concerns in isolation. Long compile and type-check times.

**Next steps:**
1. Extract network/ABI config into `relayer/src/config/networks.ts`.
2. Extract the price cache and safety deposit logic into `relayer/src/services/pricing.ts`.
3. Reduce `index.ts` to a thin boot file that wires the extracted modules together.
4. Complete the Winston migration (see TD-051).

---

### TD-051 · Relayer uses console.log/error throughout instead of structured logging 🟡

**Discovered:** 2026-06-30  
**Location:** `relayer/src/index.ts`, `relayer/src/services/`, `relayer/src/listeners/`, `relayer/src/utils/` — ~393 `console.*` calls across ~14 files

**Context:**  
The relayer's `README.md` explicitly calls out a planned migration from `console.log`/`console.error` to structured JSON logging via Winston (or Pino, which the coordinator already uses). The coordinator uses `pino` + `pino-http` and produces structured logs with request IDs. The relayer produces unstructured text, making correlation across services impossible.

**Impact:**  
Log aggregation tools (Loki, CloudWatch, Datadog) cannot parse relayer output. Cross-service tracing (coordinator request ID ↔ relayer event) is not possible.

**Next steps:**
1. Add `pino` as a relayer dependency (already in coordinator — no new toolchain needed).
2. Replace `console.*` calls with `logger.info/warn/error` using a shared logger factory matching the coordinator's setup.
3. Include `orderId` / `orderHash` as structured log fields, not string interpolation.

---

### TD-052 · Hardcoded ETH/USD = $3500 fallback inside calculateDynamicSafetyDeposit 🟡

**Discovered:** 2026-06-30  
**Location:** `relayer/src/index.ts` — `calculateDynamicSafetyDeposit`, `const ETH_USD_PRICE = 3500`

**Context:**  
The function has a comment `// $3500 per ETH` and a real-time CoinGecko price cache (`getPriceSnapshot`) is available elsewhere in the same file. However, `calculateDynamicSafetyDeposit` uses the hardcoded constant directly and never calls `getPriceSnapshot`. If ETH price moves significantly, safety deposits will be mis-sized — too small at high ETH prices, over-charging at low prices.

**Impact:**  
Incorrectly priced safety deposits. Over-charging discourages resolver participation; under-charging means refund incentives are insufficient.

**Next steps:**
1. Refactor `calculateDynamicSafetyDeposit` to be async and call `getPriceSnapshot()` internally.
2. Keep the `3500` fallback only inside `fetchPricesFromCoinGecko`'s `fallback` object, not in the deposit calculation.
3. Add a unit test that mocks `getPriceSnapshot` and verifies the deposit scales with price.

---

### TD-053 · Two divergent EscrowFactory ABIs for testnet vs mainnet 🟡

**Discovered:** 2026-06-30  
**Location:** `relayer/src/index.ts` — `MAINNET_ESCROW_FACTORY_ABI` (1inch pattern) vs `TESTNET_ESCROW_FACTORY_ABI` (custom pattern)

**Context:**  
The testnet uses a custom `EscrowFactory` with a `createEscrow(config)` signature. The mainnet targets the 1inch `EscrowFactory` with a `createDstEscrow(dstImmutables, srcCancellationTimestamp)` signature. The two interfaces are fundamentally different: different function names, different parameter shapes, different event signatures. The relayer switches between them with a runtime `getEscrowFactoryABI(isMainnet)` call.

**Impact:**  
Any code path that handles contract interactions must branch on network mode. Tests only cover the testnet ABI. The mainnet path is untested.

**Next steps:**
1. Write integration tests for the `MAINNET_ESCROW_FACTORY_ABI` path against a forked mainnet (Hardhat mainnet fork).
2. Consider abstracting the two ABIs behind a common adapter interface so the rest of the relayer is ABI-agnostic.

---

### TD-054 · Dead code: v1 Stellar HTLC placeholder path still in Ethereum listener 🟢

**Discovered:** 2026-06-30  
**Location:** `relayer/src/listeners/ethereum-listener.ts` lines ~106–107, ~281–294

**Context:**  
The Ethereum listener contains a `console.log('🌟 Stellar client initialization placeholder')` comment at startup and a disabled v1 Stellar HTLC path that logs a warning and returns early. The live v2 path goes through the coordinator. The v1 code is unreachable but adds noise.

**Impact:**  
Confusing log output on startup ("Stellar client initialization placeholder"). Dead code increases maintenance surface.

**Next steps:**
1. Remove the `console.log` placeholder and the dead v1 Stellar HTLC code block.
2. Add a comment explaining that Stellar coordination is now handled by the coordinator service.

---

## resolver/

### TD-060 · No test coverage for Solana settle path 🟡

**Discovered:** 2026-06-30  
**Location:** `resolver/test/` — no Solana-specific test file; existing tests cover Ethereum and Soroban paths

**Context:**  
The resolver has test files for Ethereum (`ethereum.test.ts`), Soroban (`soroban.test.ts`), supervisor behaviour, config validation, and health checks. There is no `solana.test.ts`. The Solana settle path in `resolver/src/listeners/` is currently in simulation mode (TD-000), so live-network tests are blocked, but unit tests for the settle logic and error handling can be written now.

**Impact:**  
When the Anchor program is deployed and simulation mode is disabled, the Solana settle path will go live with no test coverage.

**Next steps:**
1. Add `resolver/test/solana.test.ts` covering: happy-path settle (mock RPC), settle failure (RPC timeout), refund after timelock, and preimage mismatch.
2. Mirror the structure of `soroban.test.ts` for consistency.

---

### TD-061 · Supervisor maxRestarts is not configurable via environment variable 🟢

**Discovered:** 2026-06-30  
**Location:** `resolver/src/supervisor.ts` — `maxRestarts` defaults to `5` when not provided in `SupervisorOptions`

**Context:**  
The `Supervisor` class accepts an optional `maxRestarts` option, but the resolver's startup code passes no value, so the default of `5` is always used. Operators cannot tune the restart ceiling without recompiling the resolver. For high-reliability deployments, a higher ceiling (or unlimited retries with exponential backoff) may be desirable.

**Impact:**  
After 5 consecutive listener crashes, the resolver process exits. On a flaky RPC connection this can happen within minutes, requiring manual restart.

**Next steps:**
1. Add `RESOLVER_MAX_RESTARTS` to `packages/config/src/schema.ts` (`resolverConfigSchema`).
2. Thread it through to the `Supervisor` constructor in `resolver/src/index.ts`.
3. Document it in `resolver/README.md` (or create one) and `env.example`.

---

### TD-062 · Resolver only supports a single key — no hot-key rotation 🟢

**Discovered:** 2026-06-30  
**Location:** `resolver/src/config.ts`, `packages/config/src/schema.ts` — `resolverConfigSchema.ethereum.resolverPrivateKey`

**Context:**  
The resolver is designed around a single Ethereum private key and a single Stellar secret. Key rotation requires stopping the resolver, updating the environment, and restarting. There is no support for running with two keys during a rotation window or for signing with an HSM.

**Impact:**  
Key rotation causes a gap in resolver availability (any orders whose destination lock arrives during the restart window will time out to the reconciler). On mainnet, a compromised key requires an emergency stop.

**Next steps:**
1. Design a key rotation protocol: allow a `RESOLVER_ETH_PRIVATE_KEY_NEXT` env var; the resolver uses the primary key for new orders and accepts the secondary key during a configurable overlap window.
2. Document the rotation procedure in the resolver README.

---

## frontend/

### TD-070 · wagmi v1 dependency is deprecated; viem v2 already in use 🟡

**Discovered:** 2026-06-30  
**Location:** `frontend/package.json` — `"wagmi": "^1.4.0"`, `"viem": "^2.21.0"`

**Context:**  
The frontend ships wagmi v1 alongside viem v2. wagmi v1 has a peer dependency on viem v1, and wagmi v2 requires viem v2. The project pins viem to v2 and overrides the peer constraint, which works today but means wagmi v1 hooks may silently use stale viem internals. wagmi v1 reached end-of-life; wagmi v2 has a different hook API (e.g. `useAccount`, `useConnect`, `useSendTransaction`).

**Impact:**  
Bundle size is inflated (two viem versions may coexist). Future viem v2 breaking changes will not be caught by wagmi v1. Security patches to wagmi v2 do not apply.

**Next steps:**
1. Migrate to wagmi v2 following the [official migration guide](https://wagmi.sh/react/guides/migrate-from-v1-to-v2).
2. Update `useEthereumWallet` and any wagmi hooks in `frontend/src/hooks/`.
3. Verify RainbowKit compatibility (RainbowKit v2 targets wagmi v2).

---

### TD-071 · Mainnet frontend flows are untested in CI 🟡

**Discovered:** 2026-06-30  
**Location:** `frontend/src/config/networks.ts`, `.github/workflows/ci.yml`

**Context:**  
`VITE_MAINNET_ENABLED` defaults to `false`. The CI pipeline never sets it to `true`, so any component or hook that branches on `isMainnetEnabled()` has no test coverage for the mainnet branch. The 1inch `EscrowFactory` interaction path in the frontend is similarly untested.

**Impact:**  
Mainnet UI regressions are invisible until a manual smoke test after setting the flag.

**Next steps:**
1. Add a CI matrix variant that builds the frontend with `VITE_MAINNET_ENABLED=true` and runs the Vitest suite.
2. Add a `MainnetBridgeForm.test.tsx` that mocks the coordinator API in mainnet mode and verifies the correct contract addresses are sent to the wallet.

---

### TD-072 · No E2E test against a real devnet 🟢

**Discovered:** 2026-06-30  
**Location:** `e2e/cross-chain.test.ts`, `e2e/sim.ts`

**Context:**  
The E2E harness runs entirely through in-process simulators (`EvmHtlcSim`, `SorobanHtlcSim`, `SolanaHtlcSim`). Simulators are valuable for differential testing but do not catch RPC compatibility issues, network-specific fee estimation failures, or contract ABI drift.

**Impact:**  
A contract redeployment that changes an event signature will not be caught by the E2E suite.

**Next steps:**
1. After TD-000 (Solana Anchor deploy), add a `e2e/devnet.test.ts` fixture that connects to Sepolia + Stellar testnet + Solana devnet and exercises a full round-trip.
2. Gate the devnet test on a `RUN_DEVNET_E2E=true` env flag so it only runs in scheduled CI, not on every PR.

---

## e2e/

### TD-080 · SolanaHtlcSim is a stub — no real Solana on-chain calls 🔴

**Discovered:** project inception  
**Location:** `e2e/sim.ts` — `SolanaHtlcSim`

**Context:**  
`SolanaHtlcSim` implements the `HtlcSim` interface with in-memory state, matching the contract semantics but never touching the Solana network. This is the correct approach while the Anchor program is not deployed, but it means the E2E differential harness does not actually test the Solana contract.

**Impact:**  
The differential harness only compares three in-memory implementations. True cross-chain differential correctness (EVM contract vs Soroban contract vs Solana program) is not tested.

**Next steps:**
1. Resolve TD-000 (Anchor deploy).
2. Replace `SolanaHtlcSim` with a live-devnet fixture that calls the deployed program.
3. Keep the in-memory sim as a fast path for pure unit-differential tests.

---

## Roadmap summary

The table below gives a consolidated view of all open items ordered by priority.

| ID | Service | Title | Severity | Depends on |
|----|---------|-------|----------|------------|
| TD-000 | Platform | Solana Anchor program not deployed | 🔴 | — |
| TD-001 | Platform | Mainnet gated until audit | 🔴 | — |
| TD-041 | Coordinator | SECRET_STORAGE_KEY optional (plaintext secrets) | 🔴 | — |
| TD-080 | E2E | SolanaHtlcSim is a stub | 🔴 | TD-000 |
| TD-030 | SDK | SolanaHTLCClient simulation mode | 🔴 | TD-000 |
| TD-010 | Contracts | HTLCEscrow registry upgrade path undocumented | 🟡 | — |
| TD-011 | Contracts | ResolverRegistry owner not enforced as multisig | 🟡 | — |
| TD-020 | Soroban | TS bindings require manual regeneration | 🟡 | — |
| TD-021 | Soroban | No admin key rotation runbook | 🟡 | — |
| TD-031 | SDK | Devnet USDC mint hardcoded | 🟡 | — |
| TD-040 | Coordinator | Hand-rolled SQL dialect translation | 🟡 | — |
| TD-042 | Coordinator | Lazy listener startup | 🟡 | — |
| TD-050 | Relayer | 134 KB index.ts monolith | 🟡 | — |
| TD-051 | Relayer | console.log instead of structured logging | 🟡 | TD-050 |
| TD-052 | Relayer | Hardcoded ETH/USD fallback in safety deposit calc | 🟡 | — |
| TD-053 | Relayer | Untested mainnet EscrowFactory ABI path | 🟡 | TD-001 |
| TD-060 | Resolver | No Solana settle path tests | 🟡 | TD-000 |
| TD-070 | Frontend | wagmi v1 deprecated | 🟡 | — |
| TD-071 | Frontend | Mainnet flows untested in CI | 🟡 | TD-001 |
| TD-012 | Contracts | ERC20-only; no multi-token routing | 🟢 | — |
| TD-013 | Contracts | No Foundry invariant/fuzz tests | 🟢 | — |
| TD-032 | SDK | Dual-hash scheme not documented | 🟢 | — |
| TD-043 | Coordinator | Reconciler no per-order ledger cursor | 🟢 | — |
| TD-044 | Coordinator | No WebSocket/SSE push | 🟢 | — |
| TD-054 | Relayer | Dead v1 Stellar placeholder code | 🟢 | — |
| TD-061 | Resolver | maxRestarts not configurable via env | 🟢 | — |
| TD-062 | Resolver | Single-key only; no hot rotation | 🟢 | — |
| TD-072 | Frontend | No E2E test against real devnet | 🟢 | TD-000 |

---

*To mark an item resolved, replace its severity tag with ✅ and append `— resolved <PR link>` to the title line.*
