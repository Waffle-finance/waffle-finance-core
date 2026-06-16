# WaffleFinance Core Repository Issues

This file contains 60 HARD complexity engineering tasks that are suitable for an open-source bounty program. Each issue is based on the repository structure, architecture, and current implementation gaps.

## 1. Harden `HTLCEscrow` native transfer fallback and payout safety

Labels: frontend, backend, smartcontract, complexity

### Summary
Deliver a safer payout mechanism for `HTLCEscrow` native ETH transfers by replacing raw `call` semantics with robust retry and refund-safe patterns.

### Background and Context
`contracts/contracts/HTLCEscrow.sol` pays out ETH with `(bool ok, ) = payable(to).call{value: amount}("")`, which can fail for recipient contracts with complex `receive` logic.

### Current Problem
A single failed native transfer can revert a valid claim/refund transaction even when the funds should be recoverable. This makes the contract brittle when beneficiary or refund addresses are smart contracts.

### Technical Impact
This issue can cause stuck funds in an on-chain HTLC claim/refund path, reducing atomicity guarantees and exposing users to contract-level transfer failures.

### Business Impact
Bridge users and resolvers may see failed settlement transactions despite valid preimages or expired timelocks, undermining trust and increasing support overhead.

### Root Cause Analysis
`_payout` in `HTLCEscrow.sol` uses a single call with no retry, alternative payment channel, or explicit destination contract handling.

### Detailed Scope of Work
Review `HTLCEscrow.sol`, design a safer ETH payout flow, add tests for contract receivers, update `IHTLCEscrow.sol` events if needed, and document the new refund approach.

### Implementation Procedure
1. Audit `_payout` and determine acceptable gas stipend and fallback options.
2. Add an internal pull-payment queue or alternative transfer method for failed ETH payments.
3. Add tests for receiving contracts with expensive fallback logic and for intentionally failing transfers.
4. Ensure claim/refund still revert when the primary transfer fails for a legitimate reason.
5. Update README or contract comments with the new payout semantics.

### Architectural Considerations
Avoid adding custodial behaviour. The fix must preserve atomic HTLC guarantees and not introduce a withdrawable escrow account.

### Security Considerations
The enhanced payout flow must not enable reentrancy, fund capture by malicious fallback contracts, or create a denial-of-service vector.

### Performance Considerations
Keep the gas overhead minimal and avoid on-chain loops or excessive storage updates.

### Testing Requirements
Add Solidity tests for native ETH claim and refund paths with: normal EOA beneficiaries, receiver contracts that revert, receivers that consume gas, and fallback queue expiry.

### Expected Deliverables
Updated `contracts/contracts/HTLCEscrow.sol`, new or expanded tests in `contracts/test/HTLCEscrow.test.ts`, and contract comments documenting payout failure handling.

### Definition of Done
The contract passes all existing HTLC tests plus new failure-case payout tests, and the new logic is documented.

### Acceptance Criteria
A reviewer can demonstrate claims/refunds succeed with contract addresses that revert on plain transfer by using the fallback path, and the contract still reverts when the destination legitimately rejects the payment.

### Potential Risks
A pull-payment queue may increase state complexity. Avoid storing user funds in an recoverable pool longer than necessary.

### Dependencies and Constraints
Requires updating Solidity contract tests and may touch contract factory deployment patterns.

### Additional Notes
This issue is critical for mainnet readiness because it addresses a common failure mode in ETH transfer semantics.

## 2. Strengthen `ResolverRegistry` stake record consistency and list indexing under concurrent unregister operations

Labels: frontend, backend, smartcontract, complexity

### Summary
Fix the `ResolverRegistry` resolver list index manipulation and stake record consistency to prevent stale mapping entries on unregister.

### Background and Context
`contracts/contracts/ResolverRegistry.sol` uses a 1-based `_resolverIndex` mapping and `_removeFromList` to delete resolvers from `_resolverList`.

### Current Problem
Without explicit invariants or gas-optimized checks, removing resolvers can leave mapping/list inconsistencies or enable stale address reuse under edge-case reentrancy patterns.

### Technical Impact
This can lead to `isActive` returning incorrect values for resolvers, make `list()` stale, and complicate audits of stake membership.

### Business Impact
Resolver registry reliability is foundational for sybil resistance; broken membership state could allow unauthorized creation of cross-chain orders.

### Root Cause Analysis
The delete logic assumes a single non-reentrant flow and does not protect against unusual reuse of addresses or malicious registry state.

### Detailed Scope of Work
Review `_removeFromList`, validate `register`, `unregister`, `slash`, and `increaseStake`, implement safe index invariants, and add tests for boundary cases.

### Implementation Procedure
1. Add explicit asserts around `_resolverIndex[msg.sender]` and list bounds.
2. Add a `getResolverCount()` or similar invariant check for tests.
3. Ensure `unregister` cannot leave stale `_resolverIndex` values if `stakeAsset.safeTransfer` reverts.
4. Add tests for unregistering the last resolver, middle resolver, and for slashing to deactivate without deleting.
5. Document behavior in `contracts/contracts/ResolverRegistry.sol` comments.

### Architectural Considerations
Keep storage minimal and avoid introducing a separate doubly-linked list; maintain the current array-based pattern with safer invariants.

### Security Considerations
The fix must prevent state corruption and avoid enabling unauthorized stake access or invalid active status.

### Performance Considerations
The list removal path is expected to remain O(1) and should not significantly increase gas.

### Testing Requirements
Add Solidity tests around `register`, `unregister`, `slash`, `list`, and `isActive`, including invalid re-registration attempts after unregister.

### Expected Deliverables
Updated `contracts/contracts/ResolverRegistry.sol`, new tests in `contracts/test/ResolverRegistry.test.ts`, and comments clarifying state invariants.

### Definition of Done
All new registry invariants pass, and list/index state remains consistent after delete operations.

### Acceptance Criteria
A reviewer can run contract tests to confirm `list()` and `_resolverIndex` remain accurate after unregistering any registered resolver.

### Potential Risks
None beyond ensuring reentrant-safe order of state updates and transfers.

### Dependencies and Constraints
May require modifying tests in `contracts/test/ResolverRegistry.test.ts`.

### Additional Notes
This issue improves the security posture of off-chain resolver gatekeeping.

## 3. Add PostgreSQL migration and query compatibility tests for `coordinator` persistence layer

Labels: frontend, backend, smartcontract, complexity

### Summary
Introduce dedicated regression tests that exercise the coordinator persistence layer against PostgreSQL and verify SQLite-to-Postgres SQL translation correctness.

### Background and Context
`coordinator/src/persistence/db.ts` wraps Postgres over a SQLite-like interface with SQL translation logic.

### Current Problem
Current code paths are lightly tested only against SQLite in unit tests. The Postgres statement converter can mis-handle named parameters and `strftime` translations.

### Technical Impact
Buggy Postgres compatibility could cause coordinator runtime failures in production on managed databases, breaking order tracking and event replay.

### Business Impact
Production deployments relying on PostgreSQL may experience lost order state, inability to reconstruct on-chain events, and operational outages.

### Root Cause Analysis
The wrapper’s conversion logic is custom and untested for realistic queries, particularly `:named` parameters and `?` placeholders.

### Detailed Scope of Work
Build an integration test harness for PostgreSQL, add compatibility tests for all prepared statements, and fix any translation errors in `db.ts`.

### Implementation Procedure
1. Create a new `coordinator/test/db-postgres.test.ts` or extend existing tests.
2. Use a lightweight ephemeral Postgres instance via testcontainers or a locally installed `pg` with connection string from environment.
3. Exercise `OrdersRepository` methods and the full schema migrations `001_initial.sql` and `002_solana_support.sql`.
4. Add assertions for query results, null handling, and update path semantics.
5. If needed, fix `PostgresStatement.convertSqliteToPostgres` for named parameter ordering and ambiguous placeholder usage.

### Architectural Considerations
Test harness should not require an external database service in CI if possible; use a containerized Postgres or a local in-memory emulator.

### Security Considerations
Ensure test credentials are ephemeral and no secrets are committed.

### Performance Considerations
This is a developer test improvement; keep test runtime reasonable by using a single short-lived DB instance.

### Testing Requirements
Cover `announce`, `findByPublicId`, `recordSrcLock`, `recordDstLock`, `recordSecretRevealed`, `setStatus`, and `findByHashlock` flows.

### Expected Deliverables
New integration tests, updated `coordinator/src/persistence/db.ts` if needed, and CI job addition to ensure Postgres compatibility.

### Definition of Done
Coordinator persistence passes regression tests against both SQLite and PostgreSQL.

### Acceptance Criteria
A reviewer can run the new tests and confirm the same order lifecycle scenarios succeed on Postgres and SQLite.

### Potential Risks
Test container or external DB setup may add CI complexity; mitigate with cached containers or simple runtime checks.

### Dependencies and Constraints
May require `pg` dev dependencies already present; extend `coordinator/package.json` if necessary.

### Additional Notes
This issue is essential for production-readiness for deployments that choose PostgreSQL.

## 4. Improve coordinator source/destination order state reconciliation and stale event recovery

Labels: frontend, backend, smartcontract, complexity

### Summary
Build a reconciliation service in `coordinator` to detect and recover orders whose on-chain source/destination locks diverge from cached DB state.

### Background and Context
The coordinator treats the DB as a cache of on-chain state and notes it can rebuild by re-reading events, but no automatic reconciliation exists.

### Current Problem
If the local DB becomes corrupted, partial, or out-of-sync due to a crash, the coordinator may display stale orders or miss secret revelations.

### Technical Impact
Stale or missing order state can cause resolvers to act on outdated information and lead to failed bridge settlements.

### Business Impact
Order tracking reliability degrades, user trust falls, and the bridge may fail to rescue stuck swaps.

### Root Cause Analysis
There is no periodic or startup reconciliation loop that compares DB state against on-chain events and replays missing transitions.

### Detailed Scope of Work
Design and implement a recovery task that scans recent events from Ethereum, Soroban, and Solana, replays them into the DB, and records reconciliation metrics.

### Implementation Procedure
1. Add a reconciliation module under `coordinator/src/reconciliation/`.
2. On startup, compute the latest known block heights and compare event timestamps with DB update times.
3. Re-fetch recent `OrderCreated`, `OrderClaimed`, `OrderRefunded`, and corresponding Soroban/Solana events from the configured RPCs/horizon endpoints.
4. Use existing `OrderService` and `OrderRepository` APIs to replay missing order state safely without violating state transition guards.
5. Add a `/health` or metrics endpoint indicator for reconciliation status.

### Architectural Considerations
Keep recovery separate from the normal event listeners, and ensure it is safe to run concurrently during normal operation.

### Security Considerations
Verify on-chain data before writing to the DB. Do not accept data from untrusted sources, and authenticate event sources with configured RPC endpoints.

### Performance Considerations
Make the scan incremental and throttle event fetching to avoid overwhelming node providers.

### Testing Requirements
Add tests for reconciliation startup, missing event replay, and duplicate event idempotency.

### Expected Deliverables
New reconciliation module, tests, startup integration, and metrics around resync success/failure.

### Definition of Done
The coordinator can resynchronize order state after a simulated DB reset and recover missing on-chain events.

### Acceptance Criteria
A reviewer can delete the local DB, restart the coordinator, and observe it restore at least the last 24 hours of order state from on-chain events.

### Potential Risks
Event replay must avoid creating duplicate or invalid transitions. Use state-machine guards to prevent corruption.

### Dependencies and Constraints
Requires access to on-chain event data sources and may need new RPC retry semantics.

### Additional Notes
This issue is crucial for durable operator deployments and incident recovery.

## 5. Add authenticated rate limiting and abuse protection to `/secrets/reveal` and `/orders/announce`

Labels: frontend, backend, smartcontract, complexity

### Summary
Harden coordinator endpoints by adding authenticated rate limiting, IP tracking, and abuse protection for secret reveal and order announcement APIs.

### Background and Context
`coordinator/src/server/routes/orders.ts` already includes a lightweight in-memory rate limiter for announcements; secrets end-point currently lacks similar protections.

### Current Problem
An attacker can spam `/secrets/reveal` or `/orders/announce` to exhaust resources, inject bogus hashlocks, or discover order state through enumeration.

### Technical Impact
Unrestricted secret reveal traffic can increase DB load, log noise, and potentially allow denial-of-service against the coordinator.

### Business Impact
Abuse of public APIs damages reliability and increases operational costs for the bridge service.

### Root Cause Analysis
Only order announcements are rate limited. Secret reveal and history endpoints are unprotected aside from basic validation.

### Detailed Scope of Work
Implement centralized middleware for rate limiting and authentication hints, apply it to high-risk coordinator routes, and document the recommended deployment configuration.

### Implementation Procedure
1. Refactor `makeRateLimiter` into a reusable middleware under `coordinator/src/server/middleware/ratelimit.ts`.
2. Add a secret reveal rate limiter with stricter per-IP or per-publicId limits.
3. Add optional API key or token support for high-volume callers if the coordinator is deployed in a trusted resolver network.
4. Add tests for rate-limited responses and ensure the middleware behaves correctly for whitelisted origins.

### Architectural Considerations
Use an in-memory limiter for single-instance deployments and design the middleware so stateful external caches like Redis can replace it later.

### Security Considerations
Ensure rate limiting cannot be bypassed with forged `X-Forwarded-For` headers by requiring trusted proxy settings.

### Performance Considerations
Keep middleware lightweight and avoid excessive allocations on each request.

### Testing Requirements
Unit tests for rate limiter behavior and integration tests for `orders/announce` and `secrets/reveal` endpoints.

### Expected Deliverables
Refactored rate limiter code, secret-rate-limit enforcement, updated route registration in `orders.ts` and `secrets.ts`, and relevant tests.

### Definition of Done
The coordinator rejects excessive requests with 429 and logs abuse events while still allowing normal traffic.

### Acceptance Criteria
A reviewer can send more than the configured limit of requests and receive 429 responses consistently for both announce and reveal endpoints.

### Potential Risks
Overly aggressive rate limits can block legitimate resolver traffic; keep default thresholds conservative.

### Dependencies and Constraints
No external dependencies required. Must remain compatible with current route handlers.

### Additional Notes
This issue improves the coordinator security posture and helps prevent service degradation under load.

## 6. Build end-to-end Solana Anchor integration and IDL-driven client generation in SDK

Labels: frontend, backend, smartcontract, complexity

### Summary
Replace Solana simulation placeholders with IDL-driven instruction builders and account deserializers to support a deployed Anchor HTLC program.

### Background and Context
`packages/sdk/src/solana/index.ts` currently uses placeholder SystemProgram transfers and returns mock signatures in simulation mode.

### Current Problem
The SDK is not ready for real Solana settlement because critical Solana operations remain mocked, and the on-chain account layout is not deserialized.

### Technical Impact
Solana swaps cannot transition beyond simulation mode, blocking end-to-end deployment and cross-chain settlement.

### Business Impact
The project cannot fully support Solana mainnet activity until real program integration is implemented.

### Root Cause Analysis
The implementation was intentionally left incomplete pending Anchor program deployment, with TODOs for IDL deserialization and instruction construction.

### Detailed Scope of Work
Integrate the Anchor IDL, build actual `createOrder`, `claimOrder`, and `refundOrder` instructions, and parse on-chain account state into `SolanaOrderData`.

### Implementation Procedure
1. Add the Anchor IDL for the HTLC program under `packages/sdk/src/solana/idl/` or similar.
2. Use `@project-serum/anchor` or `@solana/web3.js` to build instructions from the IDL.
3. Implement account state decoding in `getOrder()` using the IDL account layout.
4. Add integration tests to validate the client against an actual devnet Anchor deployment or a mocked Anchor program account layout.
5. Update SDK documentation and package exports.

### Architectural Considerations
Keep the Solana client interface stable for callers by preserving `SolanaHTLCClientOptions` and return types.

### Security Considerations
Ensure all instruction data is validated and that the client does not assume `PLACEHOLDER` mode when a real `programId` is configured.

### Performance Considerations
Avoid unnecessary network calls by caching IDL account layout and using high-commitment reads only when required.

### Testing Requirements
Add unit tests for IDL account decoding and integration tests for live devnet/mocked Anchor contract behavior.

### Expected Deliverables
Real Solana SDK client implementation, IDL files, test coverage, and updated comments removing simulation placeholders.

### Definition of Done
The SDK client can create, claim, refund, and query live Solana orders using an actual Anchor program ID.

### Acceptance Criteria
A reviewer can point the SDK at a deployed Anchor HTLC program and execute full order lifecycle operations without falling back to simulation mode.

### Potential Risks
Anchor IDL changes may require migration. Design the SDK to support versioned IDLs.

### Dependencies and Constraints
Requires a deployed Anchor program ID and the Anchor IDL for the HTLC contract.

### Additional Notes
This issue is a major milestone for Solana support and is directly referenced by docs and frontend feature gating.

## 7. Expand coordinator `QuoteService` with robust stale-while-revalidate caching and backpressure handling

Labels: frontend, backend, smartcontract, complexity

### Summary
Replace the current simple in-memory quote cache with a robust SWR implementation that avoids stale data, prevents thundering herds, and fails safely under upstream outages.

### Background and Context
`coordinator/src/services/quote-service.ts` caches ETH/XLM quotes for 30 seconds and serves stale results without explicit background refresh control.

### Current Problem
The current cache is vulnerable to repeated stale data returns, burst refresh storms, and lacks explicit fallback behavior when the external price provider fails.

### Technical Impact
Users may receive inconsistent or stale exchange rate quotes, which can cause mispriced swaps and resolver mismatches.

### Business Impact
Poor quote quality harms user trust and may lead to losses if settlement uses different rates than advertised.

### Root Cause Analysis
The cache implementation lacks a fully formed SWR pattern and no explicit handling of inflight refresh requests beyond a naive `Promise` guard.

### Detailed Scope of Work
Rewrite `QuoteService` caching to support fresh/stale windows, background refresh, locking, and fallback price sources.

### Implementation Procedure
1. Refactor `QuoteService` to expose `getQuote()` returning a snapshot with source metadata.
2. Implement SWR with `freshTtlMs`, `staleTtlMs`, and `inflightRefresh` semantics.
3. Add fallback behavior for external failures, including a maximum stale age and error propagation.
4. Add tests for concurrent quote requests, API outages, and stale refresh behavior.
5. Update frontend integration to display quote source and staleness.

### Architectural Considerations
Keep the service stateless aside from the cache and ensure it can be extended to oneinch or alternative sources later.

### Security Considerations
Do not expose stale quotes beyond an acceptable window that would compromise trade fairness.

### Performance Considerations
Avoid blocking callers excessively; stale quotes can be served while refresh is ongoing if still within safety bounds.

### Testing Requirements
Unit tests for caching behavior, concurrency, and failure cases; integration tests for end-to-end quote endpoints.

### Expected Deliverables
Refactored `QuoteService`, updated tests, and documentation of quote freshness semantics.

### Definition of Done
Quote provider behaves deterministically under reload, and the service passes added caching tests.

### Acceptance Criteria
A reviewer can show that aggressive backend failures still return a recent safe quote or a clear failure rather than stale or wrong data.

### Potential Risks
Need to tune TTL values and avoid returning unbounded stale prices.

### Dependencies and Constraints
May require updating frontend UI text and backend route consumption.

### Additional Notes
This issue improves both reliability and user experience around price discovery.

## 8. Add end-to-end cross-chain `sol_to_eth` route coverage in the `e2e` harness

Labels: frontend, backend, smartcontract, complexity

### Summary
Enrich the existing E2E differential harness to include `sol_to_eth` cross-chain swap coverage and timelock edge cases.

### Background and Context
`e2e/cross-chain.test.ts` currently covers EVM and Soroban semantics and some cross-chain parity, but not Solana-origin routes or full route combinations.

### Current Problem
The test harness does not exercise the Solana route or exchange-specific edge cases for `sol_to_eth`, leaving a coverage gap in cross-chain workflow validation.

### Technical Impact
Solana integration bugs and route-specific failures may remain undetected until later deployment stages.

### Business Impact
Incomplete cross-chain coverage reduces confidence for one of the project’s core promises: Ethereum, Stellar, and Solana interoperability.

### Root Cause Analysis
The test harness was implemented before the Solana route was fully wired and focuses on support chain invariants rather than full route scenarios.

### Detailed Scope of Work
Expand `e2e/cross-chain.test.ts` and `e2e/sim.ts` to model Solana and validate `sol_to_eth` route semantics including hashlock compatibility and refund timing.

### Implementation Procedure
1. Add a Solana simulator or adapt the existing `EvmHtlcSim` and `SorobanHtlcSim` abstractions for `SolanaHtlcSim`.
2. Write cross-chain tests where the source order is on Solana and the destination is Ethereum.
3. Add timelock expiration and claim/refund race tests specific to the 12h/24h gap assumptions.
4. Verify the SDK secret handling and route logic for preimage parity across chain primitives.

### Architectural Considerations
Ensure the harness remains chain-agnostic and can support future Anchor and mainnet network modes.

### Security Considerations
The new tests should verify that hashlock preimage replay across Solana/Ethereum is only valid under sha256 parity and not keccak-only.

### Performance Considerations
Keep tests deterministic and avoid network dependencies by using simulations or mocked clients.

### Testing Requirements
Add E2E tests for `sol_to_eth` happy path, invalid preimages, timeout refunds, and state reconciliation after partial settlement.

### Expected Deliverables
New test files or extended harness code under `e2e/`, plus updated documentation of supported route coverage.

### Definition of Done
The E2E suite includes at least one full Solana-to-Ethereum route scenario.

### Acceptance Criteria
A reviewer can run `pnpm --filter @wafflefinance/e2e test` and see a passing `sol_to_eth` scenario in addition to existing coverage.

### Potential Risks
If the Solana client is still in simulation mode, tests must avoid requiring a live network.

### Dependencies and Constraints
May require updates to `packages/sdk` Solana interfaces and simulation utilities.

### Additional Notes
Improved E2E coverage is necessary before enabling full multi-chain support.

## 9. Introduce secure secret storage and optional encryption for `SecretService`

Labels: frontend, backend, smartcontract, complexity

### Summary
Add optional secret encryption at rest in `coordinator` to reduce exposure of preimages stored in the local database.

### Background and Context
`coordinator/src/services/secret-service.ts` currently stores raw preimages in the orders DB, which could expose secrets if the DB is compromised.

### Current Problem
Raw secret storage is a sensitive security weakness because revealed preimages can unlock HTLC orders on both chains.

### Technical Impact
A compromised coordinator DB can leak preimages and enable front-running or secondary claim attacks on pending or completed orders.

### Business Impact
Data breaches in the coordinator can harm bridge users and reduce trust in the project’s privacy and security posture.

### Root Cause Analysis
The DB schema and secret service were designed for simplicity without encrypting preimages before persistence.

### Detailed Scope of Work
Implement optional preimage encryption using a coordinator-managed key, update schema to store encrypted blobs, and add fallback decryption support.

### Implementation Procedure
1. Add a config option in `coordinator/src/config.ts` for `SECRET_STORAGE_KEY` or KMS integration.
2. Update `SecretService` to encrypt `preimage` before `recordSecretRevealed` and decrypt on `get()`. If encryption is disabled, preserve current behaviour.
3. Migrate existing secret rows with a version column or null-check to handle plaintext entries.
4. Add protocol tests to verify encrypted storage, decryption failure, and secret retrieval.

### Architectural Considerations
Keep the secrets retrievable by the coordinator while providing defense in depth. Use authenticated encryption such as AES-GCM.

### Security Considerations
Protect the encryption key in environment variables or external vaults. Avoid hardcoding keys in source.

### Performance Considerations
Encryption/decryption overhead is minimal; ensure it does not block high throughput.

### Testing Requirements
Add tests for encryption enabled/disabled, retrieval of existing plaintext secrets, and invalid key handling.

### Expected Deliverables
Updated secret storage implementation, schema migration plan, tests, and documentation.

### Definition of Done
Preimages are stored encrypted when configured, and coordinator API semantics remain unchanged.

### Acceptance Criteria
A reviewer can enable encryption, store a secret, restart the coordinator, and still retrieve the secret correctly.

### Potential Risks
Mismanaging keys can lead to unrecoverable secrets. Document key rotation and backup clearly.

### Dependencies and Constraints
May require new `crypto` modules or external secret management integration.

### Additional Notes
This issue improves the privacy and security posture of off-chain secret coordination.

## 10. Add structured event metrics and alerts for relayer refund watchdog failures

Labels: frontend, backend, smartcontract, complexity

### Summary
Instrument the relayer refund watchdog with Prometheus-compatible metrics and alertable failure counts.

### Background and Context
`relayer/src/services/refund-watchdog.ts` logs failures but lacks metrics for operational visibility.

### Current Problem
Without metrics, operators cannot alert on repeated watchdog failures or correlate them with live order recovery issues.

### Technical Impact
Silent watchdog failures can leave stuck orders unresolved and degrade cross-chain refund reliability.

### Business Impact
Missed refunds harm customer experience and may cause funds to remain locked longer than necessary.

### Root Cause Analysis
The relayer service was developed with logs only and no metrics export path.

### Detailed Scope of Work
Add a metrics module to the relayer, expose refund watchdog success/failure counters, and integrate with existing monitoring components.

### Implementation Procedure
1. Create `relayer/src/metrics.ts` with counters and gauges for refund watchdog runs.
2. Import the metrics into `refund-watchdog.ts` and increment on success/failure, refund count, and stale order age.
3. Add a health endpoint or metrics route under `relayer` if not already present.
4. Write tests for metrics emission and failure handling.

### Architectural Considerations
Keep metrics optional and low-overhead. Use a pluggable exporter if a full Prometheus client is not yet installed.

### Security Considerations
Metrics should not expose sensitive order contents or secrets.

### Performance Considerations
Metrics collection should not block watchdog execution.

### Testing Requirements
Unit tests for metric increments and an integration test that simulates failed and successful refunds.

### Expected Deliverables
Relayer metrics module, updated watchdog instrumentation, route or exporter registration, and tests.

### Definition of Done
The relayer emits observability metrics for refund watchdog activity, and these are verifiable in test output.

### Acceptance Criteria
A reviewer can verify counter values after a simulated refund watchdog run, including `refund_watchdog_success_total` and `refund_watchdog_failure_total`.

### Potential Risks
No major risks beyond telemetry overhead.

### Dependencies and Constraints
May require adding `prom-client` or similar if not already present in the relayer.

### Additional Notes
This issue is important for production operations and alerts.

## 11. Add end-to-end key material validation for resolver startup configuration

Labels: frontend, backend, smartcontract, complexity

### Summary
Implement strict startup validation for the resolver daemon so bad Ethereum, Stellar, and Solana credentials fail fast before any listeners attach.

### Background and Context
`resolver/src/config.ts` loads `RESOLVER_STELLAR_SECRET` and RPC endpoints, but does not fully validate keys or chain mismatch semantics.

### Current Problem
Resolvers can start with malformed secrets, wrong chain IDs, or incompatible RPC endpoints and fail unpredictably during runtime.

### Technical Impact
The runtime may miss events, fail to submit claims, or operate against the wrong network without a clear startup signal.

### Business Impact
Resolver operators will struggle with deployment reliability and might inadvertently disrupt bridge availability.

### Root Cause Analysis
Current config validation is shallow and does not verify the actual validity of private keys or endpoint health before runtime operation.

### Detailed Scope of Work
Add validation utilities for Stellar secret keys, Ethereum RPC chain ID matching, and Solana program endpoint consistency. Fail startup on invalid config.

### Implementation Procedure
1. Enhance `resolver/src/config.ts` to parse and validate each required secret and endpoint.
2. Add a `validateResolverConfig()` step in `resolver/src/index.ts` before bootstrapping listeners.
3. Verify Ethereum RPC returns the expected chain ID and that Solana RPC connectivity succeeds.
4. Add tests for invalid key materials, missing required env vars, and wrong chain IDs.

### Architectural Considerations
Validation should remain isolated from runtime logic and should not require event listeners or long-running services.

### Security Considerations
Never log private key material. Use safe error messages that indicate failure without leaking secrets.

### Performance Considerations
The validation step is single-run and should be lightweight.

### Testing Requirements
Add unit tests for config parsing and integration-style tests for startup failure paths.

### Expected Deliverables
Resolver config validation code, startup integration changes, and tests.

### Definition of Done
Resolver startup rejects invalid environment configuration before any event polling begins.

### Acceptance Criteria
A reviewer can set an invalid Stellar secret and observe a clean startup failure with a clear error message.

### Potential Risks
None beyond ensuring the new validation does not require unavailable resources during dry-run tests.

### Dependencies and Constraints
May require adding Stellar key validation helpers if missing.

### Additional Notes
Simpler operator setup and faster failure diagnosis are key benefits.

## 12. Enforce safe chain address validation in coordinator history query API

Labels: frontend, backend, smartcontract, complexity

### Summary
Improve the coordinator `/orders/history` route by validating incoming chain-specific addresses before database lookup.

### Background and Context
`ordersRoutes` currently accepts any string for the history `address` query param and uses it directly in DB queries.

### Current Problem
Invalid addresses can lead to noisy or incorrect order history responses and increase risk of poorly formed requests affecting service reliability.

### Technical Impact
Unvalidated history queries can result in misrouted request handling and make API behavior inconsistent across clients.

### Business Impact
Users may see inconsistent or unhelpful history pages, especially when mobile signatures or wallet addresses are malformed.

### Root Cause Analysis
The history API relies on loose string input and does not leverage the existing address validation utilities used elsewhere.

### Detailed Scope of Work
Centralize address validation for Ethereum, Stellar, and Solana and apply it to `GET /orders/history`.

### Implementation Procedure
1. Extract `validateChainAddress` into a shared validation module.
2. Add a `historyAddressSchema` that rejects unsupported formats.
3. Update `/orders/history` to validate the input and reject malformed addresses with 400 errors.
4. Add tests covering valid and invalid Ethereum, Stellar, and Solana history requests.

### Architectural Considerations
Keep the validator reusable for other endpoints such as `/orders/:id` if future routes require address provenance.

### Security Considerations
Strong input validation reduces attack surface and prevents potential injection vulnerabilities.

### Performance Considerations
Validation is lightweight and should not impact response latency significantly.

### Testing Requirements
Add route-level tests for invalid address handling and ensure valid requests still work.

### Expected Deliverables
Refactored validation helpers, updated route handler, and tests.

### Definition of Done
The coordinator rejects malformed history addresses with clear validation errors.

### Acceptance Criteria
A reviewer can send an invalid address to `/orders/history` and receive a 400 response with validation details.

### Potential Risks
Must document supported formats clearly to avoid breaking legitimate variation in wallet address types.

### Dependencies and Constraints
No external dependencies required.

### Additional Notes
This issue raises API robustness for all coordinator clients.

## 13. Add frontend wallet disconnect and network mismatch recovery in BridgeForm

Labels: frontend, backend, smartcontract, complexity

### Summary
Implement robust recovery behavior in the frontend when connected wallets disconnect or switch networks mid-session.

### Background and Context
`frontend/src/components/BridgeForm.tsx` handles wallet interactions but may not recover cleanly from runtime wallet events.

### Current Problem
Users can be left in an inconsistent bridge state if MetaMask, Freighter, or Phantom disconnects or changes chain during order creation.

### Technical Impact
Stale UI state can lead to invalid transaction creation, failed submissions, or incorrect route selection.

### Business Impact
Broken UX increases abandonment and support load.

### Root Cause Analysis
Current wallet hooks and BridgeForm do not comprehensively listen for disconnect or chain change events and re-evaluate the active route when they occur.

### Detailed Scope of Work
Add event listeners to wallet hooks, propagate disconnect state to BridgeForm, and make the UI recover by resetting route selection when necessary.

### Implementation Procedure
1. Update `useFreighter.ts` and `useSolanaWallet.ts` to expose `connected` / `chainId` state and proper cleanup.
2. Add logic in `BridgeForm.tsx` to respond to wallet disconnects and network mismatches by resetting selected routes.
3. Add user-facing warnings or modals for lost connectivity.
4. Add tests for disconnect recovery and route invalidation.

### Architectural Considerations
Keep wallet provider state in a shared context to avoid duplicate event handling across components.

### Security Considerations
Do not allow stale transaction payloads to be submitted after wallet state changes.

### Performance Considerations
Event listeners should be cleaned up to avoid memory leaks.

### Testing Requirements
Add React tests for wallet disconnect/reconnect scenarios and mocked chain changes.

### Expected Deliverables
Updated wallet hooks, enhanced BridgeForm recovery state, and tests.

### Definition of Done
The frontend gracefully recovers when a connected wallet disconnects or switches networks.

### Acceptance Criteria
A reviewer can simulate a disconnect and see the UI require reconnection before continuing.

### Potential Risks
Complex event-driven state can introduce race conditions if not carefully managed.

### Dependencies and Constraints
No new dependencies expected.

### Additional Notes
This improves frontend resilience for multi-wallet users.

## 14. Correct coordinator status transitions for `recordSrcLock` and `recordDstLock`

Labels: frontend, backend, smartcontract, complexity

### Summary
Ensure coordinator repository status updates use explicit state logic rather than SQL `CASE` defaults to avoid invalid lifecycle transitions.

### Background and Context
`orders-repo.ts` currently computes status changes inside SQL updates for source and destination lock recording.

### Current Problem
Invalid or duplicate lock records can result in incorrect status updates or silently keep orders in the wrong lifecycle state.

### Technical Impact
Order state inconsistency can cause UI bugs, reconciliation problems, and broken recovery logic.

### Business Impact
Customers and operators may lose confidence in order tracking accuracy.

### Root Cause Analysis
The SQL-based status computation is brittle and not centrally aligned with `OrderService` transition guards.

### Detailed Scope of Work
Refactor repository methods to compute and validate status transitions in TypeScript, then apply discrete DB updates.

### Implementation Procedure
1. Move status determination out of SQL and into the repository layer.
2. Add explicit checks for whether the source or destination lock should transition the order state.
3. Add idempotent no-op behavior for repeated lock events in terminal states.
4. Add unit tests for boundary conditions, including repeated calls and invalid current statuses.

### Architectural Considerations
Use the state machine as the source of truth and keep repository methods aligned with `OrderService` semantics.

### Security Considerations
Maintain the same guardrails against invalid transitions.

### Performance Considerations
A small extra service call is acceptable given correctness improvements.

### Testing Requirements
Add tests for all relevant order statuses and repeated lock events.

### Expected Deliverables
Refactored repository methods, updated service logic if needed, and tests.

### Definition of Done
Status updates for lock recording are deterministic and correct for all valid order states.

### Acceptance Criteria
A reviewer can confirm repeated `recordDstLock` calls do not move a terminal order into `dst_locked` state.

### Potential Risks
None beyond the usual migration of SQL update semantics.

### Dependencies and Constraints
May touch `orders-service.ts` and `orders-repo.ts`.

### Additional Notes
This issue improves order lifecycle consistency under event replay conditions.

## 15. Add precise cross-field validation to coordinator `announceSchema`

Labels: frontend, backend, smartcontract, complexity

### Summary
Strengthen coordinator announcement validation by enforcing route-specific chain combinations in the Zod schema itself.

### Background and Context
Announcement validation currently splits semantic checks across schema parsing and service logic.

### Current Problem
Invalid announces may reach the service layer before being rejected, causing unnecessary work and inconsistent error diagnostics.

### Technical Impact
Bad input passes initial validation and may be stored or rejected only later, reducing API consistency.

### Business Impact
Clients may have a poorer developer experience and order creation may appear flaky.

### Root Cause Analysis
The schema validates only field shapes, not cross-field relationships between direction and source/destination chains.

### Detailed Scope of Work
Augment `announceSchema` with `superRefine` logic for chain-direction alignment and new validation errors.

### Implementation Procedure
1. Refactor `announceSchema` into a shared validation module.
2. Add cross-field validation for each supported direction.
3. Update order announcement route to report schema errors directly.
4. Add tests for invalid combinations like `eth_to_xlm` with `srcChain: 'solana'`.

### Architectural Considerations
Centralized schema validation improves maintainability and reduces duplicated logic.

### Security Considerations
Strong validation closes a class of malformed payload abuse.

### Performance Considerations
Additional validation is still O(1) and negligible.

### Testing Requirements
Add schema validation tests covering all valid and invalid combinations.

### Expected Deliverables
Updated schema module, route changes, and tests.

### Definition of Done
The coordinator rejects invalid chain/direction combinations at the schema level.

### Acceptance Criteria
A reviewer can submit a malformed announce payload and receive a structured validation error.

### Potential Risks
Need to keep validation in sync with future route additions.

### Dependencies and Constraints
No external dependencies.

### Additional Notes
This issue improves the coordinate API contract.

## 16. Harden `HTLCEscrow.createOrder` ERC20 approval and ETH value matching semantics

Labels: frontend, backend, smartcontract, complexity

### Summary
Improve `HTLCEscrow` `createOrder` input validation and token transfer flows to prevent UX failures from mismatched `msg.value` and ERC20 allowances.

### Background and Context
`HTLCEscrow.sol` accepts ERC20 orders by requiring `msg.value == safetyDeposit` and then pulling `amount` via `safeTransferFrom`.

### Current Problem
A mis-sized `msg.value` or missing ERC20 approval can cause order creation to revert with a generic error, and amount/safetyDeposit semantics are not clearly enforced.

### Technical Impact
Users may lose gas on failed creates or encounter ambiguous errors from failing token transfers.

### Business Impact
A poor first-order UX can deter bridge usage and raise support volume.

### Root Cause Analysis
The contract lacks a dedicated validation path for ERC20 flows and depends on the `SafeERC20` transfer revert message.

### Detailed Scope of Work
Add explicit ERC20 flow validation in `createOrder`, improve revert messages, and add tests for approval and amount mismatch cases.

### Implementation Procedure
1. Identify ERC20 vs native flows in `createOrder`.
2. Add custom reverts for missing `msg.value`, invalid token addresses, and approval failures when possible.
3. Add unit tests for ERC20 createOrder with insufficient approval and mismatched values.
4. Update SDK/frontend documentation to reflect the expected transaction semantics.

### Architectural Considerations
This is a contract-level UX and error-hardening improvement.

### Security Considerations
Ensure the fix does not alter the fundamental atomicity of fund locking.

### Performance Considerations
No significant gas change, but clearer revert paths.

### Testing Requirements
Add tests for ERC20 create orders under invalid approval and msg.value mismatch.

### Expected Deliverables
Updated contract validation code and tests.

### Definition of Done
ERC20 order creation failures are caught early and described clearly.

### Acceptance Criteria
A reviewer can reproduce the exact invalid condition and see a targeted revert reason instead of a generic failure.

### Potential Risks
Minimal; only user-facing validation changes.

### Dependencies and Constraints
None beyond contract test harness.

### Additional Notes
Improved error semantics are essential for multi-token support.

## 17. Harden Soroban HTLC admin and resolver registry interactions for immutable state assumptions

Labels: frontend, backend, smartcontract, complexity

### Summary
Audit and tighten Soroban HTLC admin functions to ensure registry updates and admin transfers do not undermine the trust-minimized HTLC semantics.

### Background and Context
`soroban/contracts/htlc/src/lib.rs` includes admin functions to set the resolver registry and update the minimum safety deposit.

### Current Problem
These admin actions can be called by a single admin account and may interact unexpectedly with the secure non-custodial intent of the contract.

### Technical Impact
Incorrect admin state transitions could permit order creation rules to be bypassed or misconfigured in a way that weakens sybil resistance.

### Business Impact
Resolver registration integrity is critical for trust in the cross-chain swap system.

### Root Cause Analysis
Admin functions are present for operational flexibility but have limited invariant documentation and no change audit trail.

### Detailed Scope of Work
Review Soroban admin functions, add guard clauses for immutability semantics, document allowed transitions, and add tests for admin misuse.

### Implementation Procedure
1. Audit `set_resolver_registry`, `clear_resolver_registry`, `set_min_safety_deposit`, and `set_admin` behavior.
2. Add explicit tests that verify resolver creation rules before and after registry updates.
3. Add comments to the contract and README around admin responsibility and gas.
4. If necessary, add an immutable flag or event that records registry changes to support off-chain monitoring.

### Architectural Considerations
Operational configuration is necessary, but it should not weaken core HTLC invariants.

### Security Considerations
Ensure no admin function can move locked funds or arbitrarily bypass hashlock/timelock conditions.

### Performance Considerations
Minimal overhead; mostly contract documentation and tests.

### Testing Requirements
Add Soroban contract tests for admin updates and their effect on create order authorization.

### Expected Deliverables
Audit findings, contract comments, and tests.

### Definition of Done
Soroban admin functions are documented and covered by regression tests.

### Acceptance Criteria
A reviewer can confirm that admin configuration changes do not alter claim/refund invariants and that registry gating behaves as expected.

### Potential Risks
Changing admin semantics may require careful coordination with deployed Soroban instances.

### Dependencies and Constraints
May involve Soroban test harness and contract snapshots.

### Additional Notes
This issue improves trust assumptions for Stellar support.

## 18. Add coordinator listener event replay tests for partial logs and reorganization recovery

Labels: frontend, backend, smartcontract, complexity

### Summary
Build coordinator tests that simulate partial Ethereum/Soroban event delivery and chain reorgs to validate listener replay correctness.

### Background and Context
`coordinator/src/listeners/*` currently processes events but lacks replay and reorg recovery coverage.

### Current Problem
Listeners may drop or duplicate state updates under partial log deliveries or chain reorganizations.

### Technical Impact
Lost or duplicate order events can corrupt order state and undermine coordinator reliability.

### Business Impact
Order tracking failures can frustrate users and make reconciliation difficult.

### Root Cause Analysis
No explicit test harness covers event delivery edge cases and listener restart behavior.

### Detailed Scope of Work
Implement tests for event replay idempotency, missed logs, and reorganized block handling in the coordinator listeners.

### Implementation Procedure
1. Add a test harness or mock client for Ethereum and Soroban listeners.
2. Simulate partial event batches, duplicate log emissions, and reorg cases.
3. Validate that `OrderService` state remains correct after replay.
4. Add any needed listener logic to detect and recover from these conditions.

### Architectural Considerations
Listeners should be able to replay events from a checkpoint and avoid duplicate side effects.

### Security Considerations
Event replay should not accept malformed or replayed events from an untrusted source.

### Performance Considerations
Tests should be deterministic and not require live network access.

### Testing Requirements
Add unit/integration tests with mocked event emission sequences and expected order states.

### Expected Deliverables
Mocked listener tests, potential listener code fixes, and documentation of replay behavior.

### Definition of Done
Listener components pass replay and duplicate event tests without corrupting order state.

### Acceptance Criteria
A reviewer can run the new tests and confirm listeners handle duplicate or reordered events safely.

### Potential Risks
May require additional listener state tracking or checkpointing support.

### Dependencies and Constraints
Could leverage existing `viem` event mocks or in-process stubs.

### Additional Notes
This issue improves production resilience for the coordinator.

## 19. Refactor relayer polling and node retry logic with exponential backoff and persistent cursors

Labels: frontend, backend, smartcontract, complexity

### Summary
Upgrade relayer block polling and event fetching to use exponential backoff, persistent cursors, and retry policies for unreliable RPC providers.

### Background and Context
`relayer/src/listeners/contract-event-poller.ts` and `adaptive-poll.ts` coordinate event polling but likely lack robust retry semantics.

### Current Problem
Transient RPC failures or rate limits can cause the relayer to miss events or retry too aggressively, reducing reliability.

### Technical Impact
Poor polling resilience can result in missed refunds, late claims, or service outages.

### Business Impact
A failing relayer undermines cross-chain settlement and can damage bridge uptime.

### Root Cause Analysis
Polling components do not appear to explicitly persist their last-processed cursor or use standard backoff patterns.

### Detailed Scope of Work
Implement robust retry/backoff logic, persist last cursor positions, and add tests for transient RPC failures.

### Implementation Procedure
1. Review `contract-event-poller.ts` and `adaptive-poll.ts` for retry behavior.
2. Add a retry policy with jitter and maximum backoff for RPC failures.
3. Persist the last processed block/log cursor to disk or database so restarts resume safely.
4. Add tests simulating RPC failures and verify the relayer resumes without losing or duplicating events.

### Architectural Considerations
Polling is a core infrastructure service and must be robust to provider disruptions.

### Security Considerations
Avoid replaying events out of order; use the persistent cursor to maintain monotonicity.

### Performance Considerations
Backoff should conserve resources and avoid overwhelming nodes.

### Testing Requirements
Unit tests for retry/backoff logic and integration tests for restart recovery.

### Expected Deliverables
Refactored relayer polling code, cursor persistence, and tests.

### Definition of Done
The relayer handles transient RPC failures gracefully and resumes from the last known cursor after restart.

### Acceptance Criteria
A reviewer can run a simulated failure and see the relayer recover without data loss.

### Potential Risks
Persisting cursors must not mask actual log gaps; handle missed events carefully.

### Dependencies and Constraints
May touch relayer storage or require adding a small local persistence layer.

### Additional Notes
This issue is important for operational resilience in a heterogenous provider environment.

## 20. Add coordinator database indexes for order history performance at scale

Labels: frontend, backend, smartcontract, complexity

### Summary
Optimize coordinator order queries with indexes and schema updates to support large-scale history retrieval.

### Background and Context
`orders-repo.ts` queries `orders` by address and order ID without explicit index tuning for `src_address`, `dst_address`, or `hashlock`.

### Current Problem
Growing order volume could degrade history and lookup performance, especially for `src_address`/`dst_address` scans.

### Technical Impact
Slow queries can increase API latency and place more load on the database.

### Business Impact
Poor performance undermines user experience and may hinder scaling to high swap volume.

### Root Cause Analysis
The schema currently creates the table but lacks targeted indexes for the most common query patterns.

### Detailed Scope of Work
Add and test database indexes for key lookup paths and instrument query performance.

### Implementation Procedure
1. Review `migrations/001_initial.sql` and `002_solana_support.sql` for current schema.
2. Add new indexes on `hashlock`, `src_address`, `dst_address`, and `public_id` if missing.
3. Add migration scripts or alter statements compatible with SQLite and Postgres.
4. Add repository tests or benchmark assertions for history query performance.

### Architectural Considerations
Indexes should support both SQLite and Postgres with minimal storage overhead.

### Security Considerations
No direct security impact, but faster queries reduce the window for stale data.

### Performance Considerations
Indexes will speed reads at the cost of slightly slower writes.

### Testing Requirements
Add migration tests that verify the indexes exist and measure query latencies under synthetic load.

### Expected Deliverables
Schema migration updates, tests, and performance documentation.

### Definition of Done
Order history and lookup queries run efficiently with the new indexes.

### Acceptance Criteria
A reviewer can confirm index creation and observe improved query performance in tests.

### Potential Risks
Index writes add overhead, but that is acceptable for read-heavy order history.

### Dependencies and Constraints
Must remain compatible with both database backends.

### Additional Notes
This issue is critical before the coordinator scales to production order volumes.

## 21. Add frontend order history caching and stale-state refresh to reduce coordinator load

Labels: frontend, backend, smartcontract, complexity

### Summary
Implement local history caching in the frontend to reduce coordinator API load and provide a smoother user experience.

### Background and Context
`frontend/src/components/TransactionHistory.tsx` currently fetches order history from the coordinator on every render or reload.

### Current Problem
Repeated history requests can stress the backend and yield poor UX during network latency.

### Technical Impact
High-frequency history polling from many users can overload the coordinator and inflate network costs.

### Business Impact
Reducing backend load improves responsiveness and lowers infrastructure costs.

### Root Cause Analysis
The frontend does not yet cache or stale-while-revalidate order history, relying on direct fetches only.

### Detailed Scope of Work
Add a local cache layer that stores fetched history and refreshes it intelligently while preserving data correctness.

### Implementation Procedure
1. Introduce a history caching hook in `frontend/src/hooks` or `frontend/src/lib`.
2. Cache order history by wallet address and refresh it on focus or after a timeout.
3. Show stale data immediately while revalidating in the background.
4. Add tests for cache behavior and stale refresh UX.

### Architectural Considerations
Keep cache size bounded and invalidated on wallet changes.

### Security Considerations
Cache only order metadata; avoid storing sensitive secrets locally.

### Performance Considerations
This should reduce coordinator API calls and improve render latency.

### Testing Requirements
React hook tests for cache freshness, invalidation, and refocus refresh logic.

### Expected Deliverables
Frontend cache hook, updated history component, and tests.

### Definition of Done
The UI serves cached history quickly and refreshes in the background without duplicate coordinator load.

### Acceptance Criteria
A reviewer can observe immediate history loading from cache followed by a background refresh when returning to the page.

### Potential Risks
Cache staleness must not mislead users; include visible refresh indicators.

### Dependencies and Constraints
No extra backend changes required.

### Additional Notes
This issue improves frontend scalability and UX.

## 22. Improve SDK secret utilities with stricter preimage length and digest parity enforcement

Labels: frontend, backend, smartcontract, complexity

### Summary
Tighten SDK secret generation and hash verification to reject invalid input shapes and preserve cross-chain digest compatibility.

### Background and Context
`packages/sdk/src/secrets/index.ts` is a shared secret utility used by E2E tests and client flows.

### Current Problem
The SDK may accept invalid preimages or ambiguous hex encodings, which can lead to unexpected mismatches across EVM and Soroban.

### Technical Impact
Inconsistent secret formatting can break cross-chain atomicity and produce invalid hashlocks.

### Business Impact
Users may lose funds or experience failed swaps because the same secret is interpreted differently across chains.

### Root Cause Analysis
The secret utilities do not enforce exact 32-byte preimage length or distinguish hex prefix variants clearly.

### Detailed Scope of Work
Add strict length validation for preimages, normalize hex encoding, and add tests for cross-chain compatibility.

### Implementation Procedure
1. Review `packages/sdk/src/secrets/index.ts` and supporting types.
2. Add utility functions that enforce `0x` prefixed 32-byte preimages and hash outputs.
3. Update `verifyPreimage` to reject invalid shapes explicitly.
4. Add tests for invalid input lengths and cross-chain digest expectations.

### Architectural Considerations
Keep the public SDK API stable while tightening validation.

### Security Considerations
Strict input validation prevents malformed secrets from entering safety-critical flows.

### Performance Considerations
Validation overhead is negligible.

### Testing Requirements
Add tests for invalid hex strings, wrong lengths, and cross-chain hash acceptance semantics.

### Expected Deliverables
Updated SDK secret utilities and tests.

### Definition of Done
The SDK rejects malformed secret inputs and preserves parity between sha256 and keccak digest generation.

### Acceptance Criteria
A reviewer can attempt to generate a secret with invalid length and see a validation error.

### Potential Risks
No major risks.

### Dependencies and Constraints
None beyond existing SDK test harness.

### Additional Notes
This issue protects the cross-chain user experience at the SDK layer.

## 23. Conduct a gas optimization audit for `HTLCEscrow` and `ResolverRegistry`

Labels: frontend, backend, smartcontract, complexity

### Summary
Analyze and optimize storage layout, event payloads, and contract patterns in the core Solidity contracts for lower gas costs.

### Background and Context
The contracts are functional but may include gas inefficiencies due to storage layout or redundant checks.

### Current Problem
Higher gas costs increase user transaction fees and decrease cost competitiveness.

### Technical Impact
Gas inefficiency affects all on-chain operations including order creation, claim, refund, registration, and slashing.

### Business Impact
Lower transaction costs improve adoption and make the bridge more attractive.

### Root Cause Analysis
Contracts were likely built for correctness first without a focused gas audit.

### Detailed Scope of Work
Perform a systematic gas audit of the Solidity contracts, restructure storage where possible, and add measurement tests.

### Implementation Procedure
1. Analyze contract storage packing and identify opportunities to compact related fields.
2. Evaluate event argument ordering and possible `indexed` reduction for gas savings.
3. Add gas benchmarking tests in `contracts/test` or Foundry fixtures.
4. Refactor contract code and validate behavior with tests.

### Architectural Considerations
Optimizations should not sacrifice clarity or security.

### Security Considerations
Avoid micro-optimizations that introduce vulnerability or break invariants.

### Performance Considerations
Goal is lower gas usage for common operations.

### Testing Requirements
Add gas regression tests that compare current gas usage to optimized versions.

### Expected Deliverables
Optimized contract code, updated tests, and gas baseline metrics.

### Definition of Done
Core contracts consume less gas for key operations while preserving functionality.

### Acceptance Criteria
A reviewer can compare gas metrics before and after and confirm measurable savings.

### Potential Risks
Refactors may change ABI ordering; keep contract interfaces stable for existing deployments.

### Dependencies and Constraints
May require contract retesting and potentially new deployments.

### Additional Notes
Gas optimization is important for user adoption.

## 24. Add frontend mainnet gating and network mode validation for `VITE_MAINNET_ENABLED`

Labels: frontend, backend, smartcontract, complexity

### Summary
Ensure the frontend properly gates mainnet functionality and validates network mode configuration before allowing users to access live assets.

### Background and Context
The README references `VITE_MAINNET_ENABLED` to unlock mainnet UI, but the frontend may not fully enforce it.

### Current Problem
Users or operators may accidentally expose mainnet routes in a testnet deployment or vice versa.

### Technical Impact
Incorrect network gating can expose users to wrong assets, invalid contract addresses, or unsupported routes.

### Business Impact
A misconfigured frontend can lead to funds being sent on the wrong network or to the wrong contract.

### Root Cause Analysis
Network mode gating logic exists but may not be centralized or fully enforced across the UI.

### Detailed Scope of Work
Audit all network mode checks, centralize gating logic, and add explicit validation for mainnet/testnet mode and runtime configuration.

### Implementation Procedure
1. Identify all places that depend on `VITE_MAINNET_ENABLED`, `NETWORK_MODE`, or chain config.
2. Add a centralized network-mode helper with validation and whitelisting.
3. Add runtime guards that prevent mainnet actions unless the feature flag is enabled.
4. Add tests for both modes and invalid configuration.

### Architectural Considerations
Keep a shared config module for network mode state.

### Security Considerations
Mainnet gating prevents accidental exposure to production assets during test deployments.

### Performance Considerations
No significant performance impact.

### Testing Requirements
Add tests for network mode gating and invalid configuration detection.

### Expected Deliverables
Centralized network mode helper, UI gating enforcement, and tests.

### Definition of Done
Mainnet features are disabled unless `VITE_MAINNET_ENABLED` is explicitly set to `true` and the mode is correctly validated.

### Acceptance Criteria
A reviewer can run the frontend in testnet mode with `VITE_MAINNET_ENABLED` off and verify mainnet routes are hidden.

### Potential Risks
Need to maintain clarity for developers whether a build is testnet or mainnet.

### Dependencies and Constraints
No external dependencies.

### Additional Notes
This issue protects users from accidentally interacting with the wrong network.

## 25. Add coordinator health readiness and dependency probe endpoints

Labels: frontend, backend, smartcontract, complexity

### Summary
Build robust `/health` and readiness endpoints for the coordinator that check database connectivity and external chain listener health.

### Background and Context
The coordinator serves orders and metrics but lacks an explicit readiness probe for deployments.

### Current Problem
Operational tooling cannot easily detect if the coordinator is up but disconnected from essential blockchain services.

### Technical Impact
Kubernetes or other orchestrators may mark the service healthy while it is unable to process orders.

### Business Impact
Undetected partial failures can lead to stale order books and poor reliability.

### Root Cause Analysis
Health checks are currently basic and do not cover all runtime dependencies.

### Detailed Scope of Work
Add readiness and liveness endpoints that verify database access, event listener status, and RPC connectivity.

### Implementation Procedure
1. Extend the existing `server/routes/health.ts` with separate `/healthz` and `/readyz` routes.
2. Add dependency probes for DB connection, Ethereum RPC, Soroban RPC, and Solana RPC.
3. Expose circuit breaker status for listener components.
4. Add tests verifying both healthy and degraded states.

### Architectural Considerations
Keep probes lightweight and avoid expensive operations on each ping.

### Security Considerations
Health endpoints should not expose sensitive details but can return basic dependency availability.

### Performance Considerations
Probe calls should be cached or use existing connection state.

### Testing Requirements
Add unit tests for health endpoint responses in both healthy and failing scenarios.

### Expected Deliverables
Enhanced health routes, runtime probes, and tests.

### Definition of Done
The coordinator exposes readiness checks that accurately reflect operational dependency health.

### Acceptance Criteria
A reviewer can simulate a missing RPC endpoint and see `/readyz` fail while `/healthz` returns service availability.

### Potential Risks
Health checks must avoid false positives from transient failures.

### Dependencies and Constraints
May require adding health status exports from listener modules.

### Additional Notes
This issue improves deployment observability and autoscaling readiness.

## 26. Add coordinator event listener lag and sync metrics

Labels: frontend, backend, smartcontract, complexity

### Summary
Instrument the coordinator with metrics for blockchain listener lag and order event processing latency.

### Background and Context
The coordinator already exposes metrics, but not specific listener lag indicators.

### Current Problem
Operators cannot easily see whether the coordinator is falling behind on Ethereum, Soroban, or Solana event streams.

### Technical Impact
Undetected listener lag can stall order state updates and degrade user experience.

### Business Impact
Slow order processing undermines the bridge’s responsiveness and reliability.

### Root Cause Analysis
There is no metric collection for block height or event processing latency in the current code.

### Detailed Scope of Work
Add counters and gauges for block height difference, event processing duration, and listener status per chain.

### Implementation Procedure
1. Extend `coordinator/src/metrics.ts` with new gauges and histograms for listener latency.
2. Update each listener to publish current chain head vs processed block height.
3. Add a `coordinator_listener_lag_seconds` metric and event processing duration histograms.
4. Add tests or instrumentation checks for metric emission.

### Architectural Considerations
Metrics should be chain-specific and time-based.

### Security Considerations
No sensitive data should be exposed via metrics.

### Performance Considerations
Metrics collection must remain low overhead.

### Testing Requirements
Add unit tests or metrics assertion helpers verifying the metrics are updated.

### Expected Deliverables
New metrics definitions, listener instrumentation, and tests.

### Definition of Done
Listener lag and processing latency metrics are available to monitoring systems.

### Acceptance Criteria
A reviewer can view metrics for coordinator listener head lag in a test or local environment.

### Potential Risks
No significant risks.

### Dependencies and Constraints
Relies on existing `prom-client` instrumentation.

### Additional Notes
This issue improves SRE visibility into coordinator health.

## 27. Add relayer pending transaction recovery after restart

Labels: frontend, backend, smartcontract, complexity

### Summary
Implement persistent recovery for unsent or pending relayer transactions so restarts do not orphan in-flight settlement flows.

### Background and Context
The relayer submits refund and claim transactions but may lose in-memory pending state on restart.

### Current Problem
A relayer restart can orphan pending transactions, preventing completion of refunds or claims.

### Technical Impact
Orphaned transactions may leave orders stuck and require manual intervention.

### Business Impact
High operational risk for bridge reliability and refund timeliness.

### Root Cause Analysis
Pending transaction state is held in memory and not persisted across relayer restarts.

### Detailed Scope of Work
Add persistent storage or checkpointing for pending relayer actions and reconcile them on startup.

### Implementation Procedure
1. Identify pending transaction state in relayer services.
2. Persist minimal transaction metadata to local storage or a simple DB.
3. On startup, scan persisted pending actions and resume or mark them failed safely.
4. Add tests for restart recovery and orphaned transaction handling.

### Architectural Considerations
Persist only necessary metadata and avoid turning the relayer into a full ledger.

### Security Considerations
Persisted metadata should not include private keys or sensitive secrets.

### Performance Considerations
Storage writes are infrequent and acceptable.

### Testing Requirements
Add restart recovery tests using persisted state.

### Expected Deliverables
Relayer persistence for pending transactions and recovery tests.

### Definition of Done
A relayer restart resumes incomplete refund/claim flows rather than dropping them.

### Acceptance Criteria
A reviewer can simulate a relayer crash and restart and confirm pending actions are resumed or safely retried.

### Potential Risks
Must avoid duplicate transaction submissions; use idempotent recovery logic.

### Dependencies and Constraints
May require adding a small file-based or DB-backed store.

### Additional Notes
This issue dramatically improves relayer robustness.

## 28. Enforce monorepo dependency lockfile and security audit checks in CI

Labels: frontend, backend, smartcontract, complexity

### Summary
Add CI validation for `pnpm-lock.yaml` consistency and dependency security audit results across the monorepo.

### Background and Context
The root package uses pnpm workspaces, but current CI only installs packages and does not audit dependency consistency.

### Current Problem
Lockfile or dependency drift can go undetected, producing unreproducible builds and hidden security issues.

### Technical Impact
Outdated or inconsistent dependencies create build failures and security exposures.

### Business Impact
Dependency discrepancies can delay releases and introduce vulnerabilities.

### Root Cause Analysis
CI currently does not run `pnpm install` consistency checks or security scanning after dependency changes.

### Detailed Scope of Work
Add CI steps to audit the lockfile and run dependency vulnerability checks, with clear failure criteria.

### Implementation Procedure
1. Update `.github/workflows/ci.yml` to run `pnpm install --frozen-lockfile` and `pnpm audit` if available.
2. Add a `pnpm` script for lockfile validation and optionally `npm audit` compatibility.
3. Add documentation for dependency changes in the repo contributing guide.
4. Add a test to ensure modules can be built from the lockfile without modifications.

### Architectural Considerations
This is a CI improvement, not a runtime change.

### Security Considerations
Dependency audit reduces exposure to known vulnerabilities.

### Performance Considerations
Audit steps may add CI time but are acceptable for merge quality.

### Testing Requirements
Validate the updated CI workflow and ensure locked dependencies install cleanly.

### Expected Deliverables
CI workflow updates and documentation.

### Definition of Done
The repo CI checks lockfile consistency and dependency audit results on every PR.

### Acceptance Criteria
A reviewer can see CI fail if the lockfile is inconsistent or vulnerabilities are detected.

### Potential Risks
`pnpm audit` may produce false positives; tune threshold and reporting appropriately.

### Dependencies and Constraints
Requires `pnpm` version support and possibly a vulnerability database network access.

### Additional Notes
This issue improves monorepo developer experience and security.

## 29. Improve package build portability and workspace validation in root CI

Labels: frontend, backend, smartcontract, complexity

### Summary
Add workspace build validation for all packages and enforce package manifest consistency across the monorepo.

### Background and Context
The repo contains multiple package roots but current CI only typechecks and tests a subset of packages.

### Current Problem
Unbuilt or unvalidated packages can drift and break when consumed by other modules.

### Technical Impact
Workspace consumers may face broken imports or mismatched package versions.

### Business Impact
Poor package hygiene increases developer friction and can delay releases.

### Root Cause Analysis
CI focuses on key packages but does not validate full workspace build and dependency references.

### Detailed Scope of Work
Add CI checks that build or lint every workspace package and validate package export paths.

### Implementation Procedure
1. Add a root-level `pnpm --filter ./... build` check or targeted package build pipeline.
2. Add package.json validation for workspace `name` and `version` fields.
3. Ensure `packages/sdk` build and export artifacts are generated successfully.
4. Add CI coverage for `frontend`, `coordinator`, `resolver`, `relayer`, `contracts`, and `e2e` package manifest validation.

### Architectural Considerations
CI should be comprehensive without becoming too slow; consider parallel jobs.

### Security Considerations
Higher build confidence reduces risk of shipping broken packages.

### Performance Considerations
Use package filters or partial build to limit CI runtime.

### Testing Requirements
Run the updated CI pipeline and confirm workspace build passes.

### Expected Deliverables
CI workflow improvement and any package manifest corrections.

### Definition of Done
All workspace packages are validated during CI and package exports are consistent.

### Acceptance Criteria
A reviewer can confirm that a PR touching package manifests triggers the new validation and fails when packages are broken.

### Potential Risks
Longer CI runtime; mitigate with parallelization.

### Dependencies and Constraints
No code changes beyond CI and package manifest fixes.

### Additional Notes
This issue improves repository maintainability and developer confidence.

## 30. Add Soroban HTLC IDL documentation and on-chain account schema reference

Labels: frontend, backend, smartcontract, complexity

### Summary
Create soroban contract IDL docs and account schema reference to support SDK integration and auditor review.

### Background and Context
The Soroban contracts are documented in code, but there is no published IDL or account schema reference for integrators.

### Current Problem
SDK and frontend teams lack a formal contract definition to build against, slowing integration work.

### Technical Impact
Missing IDL documentation makes it harder to implement real Solana Anchor or Soroban client code reliably.

### Business Impact
Integration delays and audit friction can postpone Solana support activation.

### Root Cause Analysis
Documentation has not kept pace with contract design across Soroban and Solana.

### Detailed Scope of Work
Generate or author contract IDL docs for Soroban and add account layout documentation.

### Implementation Procedure
1. Extract Soroban contract entrypoints and data types into a formal IDL or schema file.
2. Add docs in `soroban/README.md` or a new `soroban/docs/` directory.
3. Document event topics, admin actions, and account storage layout.
4. Update SDK and frontend docs to reference the IDL.

### Architectural Considerations
Documentation should be machine-readable where possible and versioned with the contract.

### Security Considerations
Accurate docs support safer client implementations.

### Performance Considerations
No direct runtime impact.

### Testing Requirements
Not applicable beyond doc review.

### Expected Deliverables
New Soroban IDL documentation and account schema reference.

### Definition of Done
The Soroban contracts have a formal, readable IDL or schema documentation for integration.

### Acceptance Criteria
A reviewer can use the docs to understand Soroban order data and resolver registry interactions.

### Potential Risks
None.

### Dependencies and Constraints
May require contract build tooling or manual extraction.

### Additional Notes
This issue supports broader cross-chain integration efforts.

## 31. Harden frontend transaction submission error classification and recovery flows

Labels: frontend, backend, smartcontract, complexity

### Summary
Improve the frontend’s transaction failure handling by classifying errors and providing recovery guidance instead of generic console logs.

### Background and Context
`BridgeForm.tsx` contains extensive transaction submission logging but lacks structured user-facing error states.

### Current Problem
Users may see generic failure messages and not know whether the error is gas-related, wallet-denied, or network-related.

### Technical Impact
Low-quality error handling reduces trust in bridging operations.

### Business Impact
Increased support inquiries and reduced conversion from attempted swaps.

### Root Cause Analysis
The submission flow is designed for development debugging rather than polished production recovery.

### Detailed Scope of Work
Classify error types from web3 providers, map them to user-friendly messages, and implement retry or fallbacks where appropriate.

### Implementation Procedure
1. Audit transaction submission catch blocks in `BridgeForm.tsx`.
2. Add structured error detection for wallet rejection, insufficient funds, network mismatch, and RPC timeout.
3. Display targeted UI messages and suggested actions.
4. Add tests for mapped error messages and fallback state.

### Architectural Considerations
Keep the UI decoupled from provider-specific error detail by using translation helpers.

### Security Considerations
Do not expose internal error details to end users; keep messages informative but safe.

### Performance Considerations
Error handling should not add runtime overhead in successful flows.

### Testing Requirements
React tests for simulated transaction failures and UI error presentation.

### Expected Deliverables
Frontend error mapping and recovery UI improvements.

### Definition of Done
The frontend surfaces meaningful, actionable failure messages for transaction submission errors.

### Acceptance Criteria
A reviewer can simulate a wallet rejection and see a clear message explaining the failure.

### Potential Risks
Need to avoid overly broad categorization that misattributes failures.

### Dependencies and Constraints
No external deps beyond React and wallet providers.

### Additional Notes
This issue improves buyer confidence in bridge transactions.

## 32. Add coordinator secret replay and stale revelation detection

Labels: frontend, backend, smartcontract, complexity

### Summary
Create a coordinator service to detect and replay missing secret revelations in case of missed events or DB corruption.

### Background and Context
Secret revelations are critical for cross-chain settlement, but the coordinator stores them only in the DB.

### Current Problem
A missed `OrderClaimed` event can prevent the coordinator from surfacing an already revealed secret.

### Technical Impact
Without replay, the coordinator UI and resolver network may be blind to secrets already on-chain.

### Business Impact
Users may need to regenerate or resubmit transactions unnecessarily, harming reliability.

### Root Cause Analysis
No dedicated secret replay or event reconciliation exists for on-chain revealed preimages.

### Detailed Scope of Work
Add a secret reconciliation process that rescans on-chain `OrderClaimed` events and stores preimages if missing.

### Implementation Procedure
1. Add a secret replay module under `coordinator/src/reconciliation/`.
2. On startup or periodically, rescan recent claim events and validate preimages against order hashlocks.
3. Update `SecretService` or `OrderService` with commands to recover missing secrets.
4. Add tests simulating missed claim event recovery.

### Architectural Considerations
Secret replay should leverage existing order state and not alter final settlement semantics.

### Security Considerations
Validate all recovered preimages before writing them to the DB.

### Performance Considerations
Backfill can be limited to a recent block window to control RPC usage.

### Testing Requirements
Add reconciliation tests for missing secret revelations.

### Expected Deliverables
Secret replay code, API updates if needed, and tests.

### Definition of Done
The coordinator can recover missing secrets from on-chain events.

### Acceptance Criteria
A reviewer can simulate a missing secret in the DB and confirm the coordinator recovers it from chain events.

### Potential Risks
Must avoid storing invalid or malformed secrets; use strict hash validation.

### Dependencies and Constraints
Requires access to on-chain event logs.

### Additional Notes
This issue is critical for full coordinator reliability.

## 33. Add SDK asset mapping validation and cross-chain token normalization tests

Labels: frontend, backend, smartcontract, complexity

### Summary
Strengthen the SDK asset mapping layer to validate supported token pairs and preserve type safety across Ethereum, Stellar, and Solana asset representations.

### Background and Context
`packages/sdk/src/assets/index.ts` maps native and token assets across chains but may lack strict validation.

### Current Problem
Invalid or mismatched asset mappings can cause incorrect order parameters or failed cross-chain swaps.

### Technical Impact
Cross-chain routes may use wrong asset identifiers, resulting in failed transaction submissions.

### Business Impact
Asset mismatch errors degrade user trust and reduce bridge reliability.

### Root Cause Analysis
Asset mapping is currently implemented but not robustly validated by the SDK.

### Detailed Scope of Work
Add runtime validation for asset mappings, normalization helpers, and tests for cross-chain token conversion.

### Implementation Procedure
1. Audit `packages/sdk/src/assets/index.ts` and identify all token mapping functions.
2. Add validation for unsupported token IDs and mismatched chain assets.
3. Add tests for Ethereum token address/ABI mapping, Stellar asset codes, and Solana mint normalization.
4. Document supported asset mappings and failure modes.

### Architectural Considerations
Keep mapping logic centralized and easily extensible for new assets.

### Security Considerations
Invalid mappings can lead to inadvertent fund loss; validation reduces this risk.

### Performance Considerations
Mapping helpers are cheap and should be guarded by explicit checks.

### Testing Requirements
Add SDK tests for valid and invalid asset mapping scenarios.

### Expected Deliverables
SDK validation code, tests, and docs.

### Definition of Done
The SDK rejects unsupported asset configurations and provides clear errors.

### Acceptance Criteria
A reviewer can use the SDK with a bad asset mapping and receive a deterministic validation error.

### Potential Risks
None beyond normal SDK maintenance.

### Dependencies and Constraints
No new dependencies expected.

### Additional Notes
This issue improves multi-chain asset reliability.

## 34. Add coordinator database schema versioning and migration logging support

Labels: frontend, backend, smartcontract, complexity

### Summary
Introduce explicit DB schema versioning and migration logging so coordinator upgrades can be audited and rolled back.

### Background and Context
Coordinator migrations are applied in `db.ts` but no explicit schema version or migration history table currently exists.

### Current Problem
Operators cannot easily determine which migrations have been applied or whether a DB is up to date.

### Technical Impact
Upgrade and deployment complexity increase when changes are applied across multiple database backends.

### Business Impact
Poor migration observability can lead to data drift and upgrade failures.

### Root Cause Analysis
Schema creation is idempotent but lacks version tracking.

### Detailed Scope of Work
Implement a migration history table and version check for both SQLite and Postgres databases.

### Implementation Procedure
1. Add a `migrations` table to the schema and post-migration logging in `openDatabase`.
2. Record migration file names, timestamps, and results.
3. Add a helper to query current schema version at startup.
4. Add tests verifying migration logging and versioning.

### Architectural Considerations
The version table should be simple and compatible with both backends.

### Security Considerations
Migration metadata is not sensitive but aids auditing.

### Performance Considerations
Minimal overhead.

### Testing Requirements
Add tests verifying schema version records after migration application.

### Expected Deliverables
Schema versioning support, migration logging, and tests.

### Definition of Done
The coordinator records schema migration history and can report current DB version.

### Acceptance Criteria
A reviewer can query the migration table and confirm the applied migration list.

### Potential Risks
Need to avoid migration table name collisions with future schema changes.

### Dependencies and Constraints
Must remain compatible with existing databases.

### Additional Notes
This issue improves production database manageability.

## 35. Add resolver registry stake history and event query functions for better transparency

Labels: frontend, backend, smartcontract, complexity

### Summary
Expose richer resolver registry stake history and event-driven query functions to support off-chain audit and frontend discovery.

### Background and Context
`ResolverRegistry` emits stake events but only exposes minimal view functions.

### Current Problem
There is no easy on-chain way to reconstruct resolver stake history, slashing, or registration churn.

### Technical Impact
Resolver governance and audits are harder without historical query support.

### Business Impact
Lack of transparency can hurt ecosystem trust in the resolver stake model.

### Root Cause Analysis
The registry stores only current resolver state and does not include a historical event indexing interface.

### Detailed Scope of Work
Add view functions or helper contracts to retrieve stake history and support off-chain indexers.

### Implementation Procedure
1. Add optional `getResolverHistory` or event-based query access in `ResolverRegistry.sol`.
2. Add events for stake increases and slashing with consistent indexing.
3. Add tests verifying historical query semantics.
4. Document the registry audit interface for frontend and monitoring consumers.

### Architectural Considerations
Prefer event-based history to avoid expensive on-chain historical storage costs.

### Security Considerations
Do not expose sensitive resolver stake details beyond on-chain state.

### Performance Considerations
Event emission is cheap; avoid large history arrays in view functions.

### Testing Requirements
Add contract tests for event emission and registry history retrieval.

### Expected Deliverables
Registry code changes, events, and tests.

### Definition of Done
Off-chain components can reconstruct resolver stake history from on-chain logs.

### Acceptance Criteria
A reviewer can query the registry or indexer and confirm resolver stake and slash events are available.

### Potential Risks
No major risks.

### Dependencies and Constraints
May need front-end or coordinator indexer changes later.

### Additional Notes
This improves transparency for open source resolver governance.

## 36. Improve BridgeForm route selection to reject unsupported asset and wallet combos

Labels: frontend, backend, smartcontract, complexity

### Summary
Add deterministic route selection validation in the frontend to prevent users from selecting unsupported asset or wallet combinations.

### Background and Context
`BridgeForm` currently chooses wallets and route combos but may not fully block invalid asset/wallet combinations for certain chains.

### Current Problem
Users may select a route combination that is not supported by the configured wallets or asset mapping.

### Technical Impact
Invalid route selection can lead to failed workflow initiation and lost time.

### Business Impact
User confusion and lower completion rates for bridge transactions.

### Root Cause Analysis
The route selector logic is not exhaustive in validating the chosen destination and source wallet compatibility.

### Detailed Scope of Work
Audit route selection logic, enforce wallet compatibility, and add UI guards for unsupported combos.

### Implementation Procedure
1. Review `BridgeForm.tsx` route selection and wallet mapping code.
2. Add explicit compatibility checks for asset types, chain support, and wallet presence.
3. Add UI messages or disable invalid route selections.
4. Add tests for unsupported route combos and invalid wallet configurations.

### Architectural Considerations
Keep route validation centralized and data-driven.

### Security Considerations
Invalid routes should not be accepted or submitted.

### Performance Considerations
Simple validation is fast.

### Testing Requirements
Add UI tests for route selection and invalid combo handling.

### Expected Deliverables
Improved route validation, updated UI, and tests.

### Definition of Done
The frontend blocks unsupported route combos and clearly explains why.

### Acceptance Criteria
A reviewer can attempt an invalid asset/wallet combo and see it disabled.

### Potential Risks
Need to keep route rules updated with chain support changes.

### Dependencies and Constraints
No backend changes required.

### Additional Notes
This issue improves UX and reduces failed bridge starts.

## 37. Add e2e coverage for stuck refund paths and order expiry backstop behavior

Labels: frontend, backend, smartcontract, complexity

### Summary
Extend the end-to-end test suite to cover refund backstop behavior when the resolver or relayer fails after source lock.

### Background and Context
The bridge refund system depends on multiple layers, but the E2E harness currently covers only happy paths.

### Current Problem
Stuck refund behavior is not tested, leaving a critical safety path unverified.

### Technical Impact
Refund failures can leave funds locked and users unable to recover.

### Business Impact
Bridge security guarantees are compromised if refunds cannot be reliably exercised.

### Root Cause Analysis
Test coverage focuses on successful cross-chain execution rather than failure/backstop scenarios.

### Detailed Scope of Work
Add E2E tests that simulate failure of the resolver or relayer and verify that the refund path executes correctly after timelock expiry.

### Implementation Procedure
1. Add scenario tests in `e2e/cross-chain.test.ts` for source lock success, destination failure, and refund expiry.
2. Use the simulation harness to advance time and verify `refundOrder` semantics on the appropriate chain.
3. Add tests for coordinator or relayer assisted refund if available.

### Architectural Considerations
The harness should support time advancement and failure injection.

### Security Considerations
This validates the bridge’s permissionless fallback path.

### Performance Considerations
No major runtime impact.

### Testing Requirements
Add at least one full stuck refund scenario and one timeout backstop path.

### Expected Deliverables
Extended E2E tests and harness updates.

### Definition of Done
E2E suite includes refund backstop coverage.

### Acceptance Criteria
A reviewer can run the E2E suite and see the stuck refund path validated.

### Potential Risks
Need to coordinate with existing simulation utilities.

### Dependencies and Constraints
May require harness enhancements for time travel.

### Additional Notes
This issue reinforces safety properties of the bridge.

## 38. Add contract access control and invariants documentation for `HTLCEscrow` and `ResolverRegistry`

Labels: frontend, backend, smartcontract, complexity

### Summary
Document contract access control constraints and invariants clearly in the codebase and audit notes.

### Background and Context
The contracts are designed to be non-custodial, but access control assumptions are spread across comments rather than consolidated documentation.

### Current Problem
Reviewers and auditors may miss key invariants due to scattered or incomplete comments.

### Technical Impact
Poorly documented access control invariants can lead to misunderstandings during audit or upgrade decisions.

### Business Impact
Clear documentation improves audit quality and accelerates mainnet readiness.

### Root Cause Analysis
Contract comments exist but are not consolidated into a developer-facing design reference.

### Detailed Scope of Work
Add a dedicated contract invariants section in `contracts/README.md` and inline comments for key functions.

### Implementation Procedure
1. Review `HTLCEscrow.sol` and `ResolverRegistry.sol` for access control semantics.
2. Add a new `contracts/README.md` section or comment block summarizing each contract’s admin assumptions, registry gating, and finality properties.
3. Add targeted inline comments in the source for functions like `createOrder`, `claimOrder`, `slash`, and `unregister`.
4. Ensure the documentation reflects current code semantics accurately.

### Architectural Considerations
Keep the docs aligned with code and easy to update.

### Security Considerations
Documentation improves auditability but does not change code behavior.

### Performance Considerations
None.

### Testing Requirements
No tests required beyond doc review.

### Expected Deliverables
Updated contracts documentation and source comments.

### Definition of Done
Core contract invariants and access control assumptions are clearly documented for auditors.

### Acceptance Criteria
A reviewer can read the docs and understand why the contracts are non-custodial and how registry access is enforced.

### Potential Risks
Must keep docs in sync with future contract changes.

### Dependencies and Constraints
No code changes beyond comments.

### Additional Notes
This issue supports audit readiness and external review.

## 39. Add coordinator request/response audit logging with correlation IDs for order flows

Labels: frontend, backend, smartcontract, complexity

### Summary
Introduce structured audit logging for coordinator order lifecycle events with request/correlation IDs.

### Background and Context
Current coordinator logs are informative but not correlated across requests and order operations.

### Current Problem
Operators cannot trace a single order request through API calls, database writes, and event handling easily.

### Technical Impact
Lack of request tracing reduces debugging speed and obscures failed order flows.

### Business Impact
Support and incident response are slower when order lifecycles cannot be correlated.

### Root Cause Analysis
Logging exists, but correlation IDs and structured request contexts are missing.

### Detailed Scope of Work
Add middleware to generate request IDs, attach them to order logs, and propagate them through service methods.

### Implementation Procedure
1. Add correlate-request middleware in `coordinator/src/server/middleware/request-id.ts`.
2. Attach request IDs to logger contexts and propagate through `OrderService` and `SecretService` calls.
3. Update logs to include `publicId`, `hashlock`, and request IDs for API requests.
4. Add tests verifying request ID injection and log context propagation.

### Architectural Considerations
Maintain low overhead and use a stable request ID format.

### Security Considerations
Audit logs should not contain private preimages or secrets.

### Performance Considerations
A UUID generation per request is acceptable.

### Testing Requirements
Add tests for request ID middleware and structured log output.

### Expected Deliverables
Request ID middleware, logger updates, and tests.

### Definition of Done
Coordinator logs can be correlated across request and service boundaries.

### Acceptance Criteria
A reviewer can observe the same request ID in API logs and order service logs.

### Potential Risks
No major risks.

### Dependencies and Constraints
No external deps needed.

### Additional Notes
This issue improves production observability for debugging.

## 40. Add frontend fallback path for secret reveal when the coordinator is unavailable

Labels: frontend, backend, smartcontract, complexity

### Summary
Implement a fallback secret reveal path in the frontend that allows users to reveal secrets directly on-chain if the coordinator is down.

### Background and Context
The coordinator is a helpful metadata service, but the bridge must remain usable if it is unavailable.

### Current Problem
If the coordinator is offline, the user may not be able to publish revealed secrets to the counterpart chain through the current UI flow.

### Technical Impact
The user should still be able to complete a swap by directly using the chain-native claim path.

### Business Impact
This fallback capability is essential for trust in a permissionless cross-chain bridge.

### Root Cause Analysis
Frontend secret reveal flow is coupled to coordinator availability.

### Detailed Scope of Work
Add a direct on-chain reveal/claim flow for the destination chain when the coordinator is unavailable.

### Implementation Procedure
1. Detect coordinator unavailability when users attempt secret reveal.
2. Provide a direct claim interface that submits the preimage to the relevant HTLC contract.
3. Add UI messaging and warning copy about coordinator fallback mode.
4. Add tests or manual validation.

### Architectural Considerations
This should be an optional fallback, not the primary path.

### Security Considerations
Ensure the preimage is only revealed to the correct chain and not leaked to third-party services.

### Performance Considerations
Direct chain submission may be slower but is acceptable as a fallback.

### Testing Requirements
Add UI tests for fallback detection and direct reveal path.

### Expected Deliverables
Frontend fallback path, UI, and docs.

### Definition of Done
Users can reveal secrets directly on-chain when the coordinator is unavailable.

### Acceptance Criteria
A reviewer can disable the coordinator and still reveal a secret from the frontend through the direct claim flow.

### Potential Risks
Need to ensure the direct path does not bypass safety checks.

### Dependencies and Constraints
May require SDK contract methods for claim-only flows.

### Additional Notes
This issue strengthens the bridge’s permissionless fallback model.

## 41. Add relayer health endpoints and runtime liveness reporting

Labels: frontend, backend, smartcontract, complexity

### Summary
Expose relayer runtime health and status endpoints to support external monitoring and orchestrators.

### Background and Context
The relayer is an essential service but does not currently expose a health endpoint.

### Current Problem
Operators cannot probe relayer liveness without inspecting logs or network activity.

### Technical Impact
A missing health endpoint reduces deployability in container orchestrators.

### Business Impact
Without health checks, the relayer may not be automatically restarted when it fails.

### Root Cause Analysis
Relayer focus has been on event handling rather than operational endpoints.

### Detailed Scope of Work
Add a minimal HTTP health endpoint and runtime status indicator to the relayer daemon.

### Implementation Procedure
1. Add Express or lightweight HTTP handling in `relayer/src/index.ts` or a new `server` module.
2. Expose `/health` and optionally `/metrics` if already implemented.
3. Report status of pending refunds, RPC connectivity, and listener health.
4. Add tests for the endpoint responses.

### Architectural Considerations
Keep the health server optional and configurable.

### Security Considerations
Health endpoints should not reveal secrets.

### Performance Considerations
Lightweight health checks are acceptable.

### Testing Requirements
Add endpoint tests for healthy and degraded service states.

### Expected Deliverables
Relayer health endpoint code and tests.

### Definition of Done
The relayer exposes a health endpoint that reflects service status.

### Acceptance Criteria
A reviewer can query `/health` and receive a 200 response when the relayer is operational.

### Potential Risks
None beyond exposing minimal service metadata.

### Dependencies and Constraints
May require adding `express` if not already present.

### Additional Notes
This issue improves relayer production readiness.

## 42. Add resolver runtime supervision and graceful shutdown support

Labels: frontend, backend, smartcontract, complexity

### Summary
Add supervisor logic for the resolver runtime to gracefully handle shutdown, signal termination, and recover from listener errors.

### Background and Context
`resolver/src/commands/run.ts` starts listeners and loggers, but graceful termination logic may be incomplete.

### Current Problem
The resolver may not clean up resources or persist state properly on shutdown.

### Technical Impact
Unclean shutdowns can leave in-flight operations in an unknown state and complicate restarts.

### Business Impact
Resolver instability reduces bridge availability and operational confidence.

### Root Cause Analysis
There is no clearly defined shutdown or restart supervision path.

### Detailed Scope of Work
Add signal handling, shutdown hooks, and a supervisory loop for listener failures.

### Implementation Procedure
1. Add `SIGINT`/`SIGTERM` handlers in `resolver/src/index.ts` or `commands/run.ts`.
2. Ensure all listeners stop cleanly and the logger flushes.
3. Add a supervisor that restarts listeners on recoverable errors or exits on fatal failures.
4. Add tests for graceful shutdown behavior.

### Architectural Considerations
Graceful shutdown should be idempotent and not risk duplicate processing.

### Security Considerations
No secret detail should leak during shutdown.

### Performance Considerations
Shutdown should be quick and not leave dangling resources.

### Testing Requirements
Add tests for the shutdown path and supervisor error handling.

### Expected Deliverables
Resolver graceful shutdown and supervision logic.

### Definition of Done
Resolver can shut down cleanly and recover from transient listener errors.

### Acceptance Criteria
A reviewer can send a termination signal and confirm listeners stop gracefully.

### Potential Risks
Need to avoid restarting on unrecoverable errors incorrectly.

### Dependencies and Constraints
No new dependencies required.

### Additional Notes
This issue improves long-running daemon reliability.

## 43. Add coordinator stale order cleanup and orphaned record reconciliation

Labels: frontend, backend, smartcontract, complexity

### Summary
Implement a cleanup process for stale or orphaned orders in the coordinator database to maintain a healthy cache.

### Background and Context
The coordinator treats the DB as a cache of on-chain state and can rebuild it, but stale or orphaned records may persist indefinitely.

### Current Problem
Orders that never complete due to missing events or manual interventions can clutter the database and confuse users.

### Technical Impact
Accumulated stale orders degrade query performance and complicate debugging.

### Business Impact
Maintaining a clean order book is essential for a trustworthy UI and efficient operations.

### Root Cause Analysis
No cleanup or retention policy exists for orders that remain in limbo after the chain has advanced.

### Detailed Scope of Work
Add a background cleanup task that identifies and removes or archives stale orders older than a retention window.

### Implementation Procedure
1. Define stale order criteria (e.g., announced orders older than 30 days with no matching source lock).
2. Implement scheduled cleanup logic in the coordinator service.
3. Add metrics for removed stale orders.
4. Add tests that simulate stale data cleanup.

### Architectural Considerations
Prefer archival or soft-delete to allow recovery if needed.

### Security Considerations
Ensure cleanup does not remove valid in-progress orders.

### Performance Considerations
Run cleanup during low traffic and limit batch sizes.

### Testing Requirements
Add tests for retention policy and cleanup execution.

### Expected Deliverables
Cleanup task code, metrics, and tests.

### Definition of Done
Stale orders are identified and removed or archived according to policy.

### Acceptance Criteria
A reviewer can simulate old orphaned orders and confirm they are cleaned up automatically.

### Potential Risks
Need to avoid deleting orders with delayed processing paths.

### Dependencies and Constraints
May require new schema fields for archival state.

### Additional Notes
This improves long-term database health.

## 44. Add packages/sdk bundling and tree-shaking optimization for library consumers

Labels: frontend, backend, smartcontract, complexity

### Summary
Optimize the shared SDK package build for tree-shaking and modern bundlers by reviewing exports and build configuration.

### Background and Context
`packages/sdk/package.json` and `tsconfig.json` define the SDK build, but tree-shaking may be impacted by barrel exports or module formats.

### Current Problem
Consumers of `@wafflefinance/sdk` may import more code than necessary and increase bundle size.

### Technical Impact
Larger frontend bundles degrade performance and load times.

### Business Impact
Slow dApp performance harms adoption and user experience.

### Root Cause Analysis
The SDK package export strategy may not be optimized for `module` field or tree-shaking.

### Detailed Scope of Work
Review SDK package exports, adjust build targets, and add bundle-size regression checks.

### Implementation Procedure
1. Audit `packages/sdk/package.json` for `exports` and `module`/`main` fields.
2. Ensure the build output is ES module friendly and can be tree-shaken by Vite.
3. Add tests or bundle analysis to verify only used parts are included.
4. Adjust code structure if needed to avoid side-effectful barrel exports.

### Architectural Considerations
Keep the SDK API ergonomic while optimizing for modern bundlers.

### Security Considerations
No direct security implications.

### Performance Considerations
Smaller bundles reduce frontend load time.

### Testing Requirements
Add bundle size or tree-shaking tests with a sample consumer.

### Expected Deliverables
SDK build configuration improvements and regression checks.

### Definition of Done
The SDK provides tree-shakable exports and smaller consumer bundles.

### Acceptance Criteria
A reviewer can run a bundle analysis and confirm unused SDK modules are omitted.

### Potential Risks
Need to preserve backward-compatible import paths.

### Dependencies and Constraints
May require `vite` or `rollup` analysis tooling.

### Additional Notes
This issue improves developer and user performance.

## 45. Add Solidity differential tests for sha256 vs keccak preimage acceptance in HTLCEscrow

Labels: frontend, backend, smartcontract, complexity

### Summary
Add explicit Solidity regression tests verifying `HTLCEscrow` accepts both sha256 and keccak preimages while preserving cross-chain compatibility assumptions.

### Background and Context
The contract comments say it accepts either digest, but tests should fully cover both modes.

### Current Problem
Existing tests may not cover all combinations of acceptable and unacceptable preimages for hashlocks.

### Technical Impact
A missing test can let a bug slip into the digest acceptance logic.

### Business Impact
A broken preimage acceptor invalidates cross-chain atomicity and may cause failed swaps.

### Root Cause Analysis
The acceptance semantics are nuanced and need explicit coverage.

### Detailed Scope of Work
Write Solidity tests for `claimOrder` on sha256 hashlocks, keccak hashlocks, and mismatched preimages.

### Implementation Procedure
1. Inspect current HTLCEscrow tests and identify gaps.
2. Add at least four tests: sha256-based claim success, keccak-based claim success, sha256 hashlock rejected by wrong preimage, and keccak hashlock reject.
3. Verify the contract stores `preimageKeccak` correctly for both cases.

### Architectural Considerations
No contract changes if logic is correct, but tests provide coverage.

### Security Considerations
This ensures digest acceptance is exactly as intended.

### Performance Considerations
Test-only changes.

### Testing Requirements
Add new `contracts/test/HTLCEscrow.test.ts` cases.

### Expected Deliverables
Expanded HTLC contract test coverage.

### Definition of Done
The digest compatibility logic is explicitly exercised in tests.

### Acceptance Criteria
A reviewer can see passing tests for both digest modes and mismatches.

### Potential Risks
None.

### Dependencies and Constraints
No new dependencies.

### Additional Notes
This issue strengthens contract correctness validation.

## 46. Add coordinator soft-expired order semantics and state-machine handling for long-lived orders

Labels: frontend, backend, smartcontract, complexity

### Summary
Clarify and implement `expired` state semantics in the coordinator order state machine to support orders that have passed timelock but are not yet refunded.

### Background and Context
`order-machine.ts` includes `expired` as a soft state, but the persistence and service layers may not fully support it.

### Current Problem
Orders that exceed timelock without refund may not be properly categorized or surfaced in the UI.

### Technical Impact
Users may not see that an order has expired and is eligible for refund.

### Business Impact
Delayed refunds reduce user confidence and can lead to lost funds if the user does not manually intervene.

### Root Cause Analysis
Soft expiration semantics are defined in code but not consistently acted upon in the coordinator state machine and persistence layer.

### Detailed Scope of Work
Add explicit expired state handling in `OrderService`, repository methods, and frontend status interpretation.

### Implementation Procedure
1. Verify `canTransition` rules around `expired` and `refunded`.
2. Add a periodic scan or API-derived expiration check to set `expired` state when a timelock passes.
3. Update API serialization to mark orders as expired when appropriate.
4. Add tests for expired transitions and UI semantics.

### Architectural Considerations
Expired is a soft state and should not block refund actions.

### Security Considerations
No critical security impact, but improves user awareness.

### Performance Considerations
Periodic expiration scanning should be low frequency.

### Testing Requirements
Add unit tests for transitions to `expired` and behavior when the timelock passes.

### Expected Deliverables
State-machine updates, scan logic, and tests.

### Definition of Done
Orders correctly transition to `expired` when timelocks pass without refund.

### Acceptance Criteria
A reviewer can simulate a timelock expiration and see the order state update to `expired`.

### Potential Risks
Need to avoid false expiration for orders already settled.

### Dependencies and Constraints
May require history endpoints or scheduler updates.

### Additional Notes
This issue improves user-facing order lifecycle clarity.

## 47. Add frontend network mode unit tests and build-time mainnet gating checks

Labels: frontend, backend, smartcontract, complexity

### Summary
Add frontend test coverage for network mode detection and ensure mainnet gating is validated during build-time.

### Background and Context
Frontend network mode flags determine available routes and asset display.

### Current Problem
Limited test coverage exists for network mode transitions and build-time gating.

### Technical Impact
A broken network mode gate can cause the UI to display unsupported mainnet flows in testnet deployments.

### Business Impact
Potential user confusion and incorrect asset handling.

### Root Cause Analysis
Existing frontend tests do not cover network mode combinations enough.

### Detailed Scope of Work
Add tests for `useNetworkMode`, `VITE_MAINNET_ENABLED` gating, and build-time route availability.

### Implementation Procedure
1. Add tests for `useNetworkMode` to verify mainnet/testnet selection.
2. Add component tests for `MainnetVersionBanner` and route gating behavior.
3. Add build-time assertions or lint checks to ensure mainnet flag is only enabled in production contexts if appropriate.

### Architectural Considerations
Tests should not require actual wallet providers.

### Security Considerations
No security impact.

### Performance Considerations
No runtime impact.

### Testing Requirements
Add unit tests for network mode helpers and UI gating components.

### Expected Deliverables
Updated frontend tests and build-time validation.

### Definition of Done
Network mode gating is covered by tests and enforced in build artifacts.

### Acceptance Criteria
A reviewer can run frontend tests and see network mode gating verified.

### Potential Risks
None.

### Dependencies and Constraints
No new dependencies.

### Additional Notes
This issue reduces mainnet/testnet configuration mistakes.

## 48. Add relayer placeholder Solana program detection and operational warnings

Labels: frontend, backend, smartcontract, complexity

### Summary
Detect when the Solana HTLC program is still set to placeholder mode and emit explicit warnings or disable Solana-specific relayer behavior.

### Background and Context
`relayer/src/index.ts` may contain code paths for Solana support, but placeholder program IDs can lead to unsupported operations.

### Current Problem
Operators may deploy the relayer with a placeholder Solana program and not realize Solana settlement is effectively disabled.

### Technical Impact
The relayer may appear to be functioning but not actually process Solana-origin swaps.

### Business Impact
A false sense of coverage can lead to missed Solana migration and operational gaps.

### Root Cause Analysis
Configuration detection around Solana program IDs is not explicit.

### Detailed Scope of Work
Add a detection layer that warns or disables Solana flows when the program ID is `PLACEHOLDER`.

### Implementation Procedure
1. Add config validation for `SOLANA_HTLC_PROGRAM` in relayer startup.
2. Emit clear logs and status metrics when placeholder mode is active.
3. Add tests for placeholder detection.

### Architectural Considerations
Keep Solana flows disabled until a real program is configured.

### Security Considerations
No direct security impact, but improves transparency.

### Performance Considerations
Negligible.

### Testing Requirements
Add startup config tests for placeholder cases.

### Expected Deliverables
Relayer config validation and warning logic.

### Definition of Done
Operators can immediately see if Solana is not configured.

### Acceptance Criteria
A reviewer can start the relayer with a placeholder program ID and observe a clear warning.

### Potential Risks
None.

### Dependencies and Constraints
No external dependencies.

### Additional Notes
This issue improves deployment clarity for Solana support.

## 49. Normalize SDK chain client interfaces and error handling across Ethereum, Soroban, and Solana

Labels: frontend, backend, smartcontract, complexity

### Summary
Standardize the SDK HTLC client interfaces and error handling semantics for all supported chains.

### Background and Context
The Ethereum, Soroban, and Solana clients currently expose different input/output shapes and error behavior.

### Current Problem
Inconsistent SDK interfaces complicate multi-chain integration and error handling in the frontend and coordinator.

### Technical Impact
Developers must handle multiple client contracts differently, increasing bug risk.

### Business Impact
A consistent SDK improves developer productivity and reduces integration errors.

### Root Cause Analysis
The clients were built independently for each chain with different conventions.

### Detailed Scope of Work
Align client method names, input types, output shapes, and error handling across SDK chain modules.

### Implementation Procedure
1. Review `packages/sdk/src/ethereum/index.ts`, `soroban/index.ts`, and `solana/index.ts`.
2. Define a shared interface for `createOrder`, `claimOrder`, and `refundOrder` operations.
3. Standardize error types and return objects.
4. Update dependent frontend code and tests.

### Architectural Considerations
Avoid breaking existing public SDK APIs if possible; provide adapter wrappers if necessary.

### Security Considerations
Consistent error handling avoids leaking internal implementation details.

### Performance Considerations
No runtime impact beyond interface changes.

### Testing Requirements
Add SDK tests for interface normalization and cross-client behavior.

### Expected Deliverables
Normalized SDK client interfaces and tests.

### Definition of Done
All SDK HTLC clients present consistent method signatures and error behavior.

### Acceptance Criteria
A reviewer can integrate all three chain clients with the same high-level code pattern.

### Potential Risks
May require adapter code to preserve backward compatibility.

### Dependencies and Constraints
Could impact frontend and coordinator SDK usage.

### Additional Notes
This issue improves the developer experience of the SDK.

## 50. Add coordinator order history query caching and pagination performance improvements

Labels: frontend, backend, smartcontract, complexity

### Summary
Optimize coordinator history queries and pagination so large address histories remain performant.

### Background and Context
`orders-repo.ts` history queries use `LIMIT :limit OFFSET :offset`, which can degrade with large offsets.

### Current Problem
Offset-based pagination does not scale for users with long order histories.

### Technical Impact
API response time can grow linearly with offset, causing poor performance for active users.

### Business Impact
Slow history retrieval can damage user trust and increase backend load.

### Root Cause Analysis
Database pagination uses naive offset pagination without cursor-based or indexed improvements.

### Detailed Scope of Work
Introduce cursor-based pagination and caching for order history APIs.

### Implementation Procedure
1. Add `created_at` or `id` cursors to `orders/history` API semantics.
2. Refactor `byAddress` SQL query to use cursor-based page boundaries.
3. Add optional in-memory cache for common address history requests.
4. Add tests for pagination correctness and performance.

### Architectural Considerations
Cursor pagination is more scalable and easier to maintain.

### Security Considerations
Cursor values should not leak internal DB IDs if sensitive.

### Performance Considerations
This significantly improves large-history response times.

### Testing Requirements
Add tests for pagination behavior and cursor boundary handling.

### Expected Deliverables
API and repository changes, docs, and tests.

### Definition of Done
Order history pagination is cursor-based and performant for large datasets.

### Acceptance Criteria
A reviewer can fetch paginated history with a cursor and observe efficient DB query execution.

### Potential Risks
Client updates may be needed for new pagination semantics.

### Dependencies and Constraints
No external dependencies.

### Additional Notes
This issue future-proofs order history scaling.

## 51. Add Solidity gas regression test harness and monitor contract gas budget changes

Labels: frontend, backend, smartcontract, complexity

### Summary
Create a Solidity or Hardhat gas regression harness to monitor contract gas usage over time.

### Background and Context
Gas budgets are important for the HTLC contracts but current tests do not measure them systematically.

### Current Problem
There is no automated guard against future gas regressions in common HTLC operations.

### Technical Impact
Gas costs may creep upward undetected.

### Business Impact
Higher user transaction fees can reduce competitiveness.

### Root Cause Analysis
Contract tests focus on behavior, not gas budget enforcement.

### Detailed Scope of Work
Add gas measurement assertions for `createOrder`, `claimOrder`, `refundOrder`, `register`, and `slash`.

### Implementation Procedure
1. Add a test harness in `contracts/test/gas-regression.test.ts`.
2. Capture gas used for key operations and compare against baseline thresholds.
3. Add comments or CI warnings when gas exceeds benchmarks.
4. Ensure the harness runs in CI as part of contract test job.

### Architectural Considerations
Gas regression testing should be deterministic and not overly fragile.

### Security Considerations
No security impact.

### Performance Considerations
Test runtime increases slightly but is manageable.

### Testing Requirements
Add gas benchmark tests and baseline thresholds.

### Expected Deliverables
Gas regression test harness.

### Definition of Done
Contract gas usage is monitored with automated regression tests.

### Acceptance Criteria
A reviewer can run gas regression tests and see threshold enforcement.

### Potential Risks
Thresholds must be tuned carefully to avoid false positives.

### Dependencies and Constraints
Uses existing Hardhat/gas reporting tools.

### Additional Notes
This issue protects against hidden gas regressions.

## 52. Add resolver listener lifecycle and leak detection tests

Labels: frontend, backend, smartcontract, complexity

### Summary
Write tests that verify resolver listener startup/shutdown lifecycle and resource leak absence.

### Background and Context
Listener components in the resolver may leak listeners or fail to stop cleanly.

### Current Problem
Listener lifecycle bugs can cause node instability over long runtimes.

### Technical Impact
Resource leaks can lead to memory growth and eventual process failure.

### Business Impact
Unstable resolver daemons reduce bridge reliability.

### Root Cause Analysis
No dedicated tests cover long-lived listener lifecycle behavior.

### Detailed Scope of Work
Add tests for starting, stopping, and restarting listener components cleanly.

### Implementation Procedure
1. Create unit tests for `EthereumListener` and `SorobanListener` lifecycle methods.
2. Simulate start/stop cycles and verify handler cleanup.
3. Add leak detection assertions for event listeners or timers.

### Architectural Considerations
Lifecycle management should be explicit and idempotent.

### Security Considerations
No direct security impact.

### Performance Considerations
Prevents long-term leaks.

### Testing Requirements
Add lifecycle tests and cleanup verification.

### Expected Deliverables
Resolver listener lifecycle tests.

### Definition of Done
Listeners can be started and stopped repeatedly without leaks.

### Acceptance Criteria
A reviewer can run the tests and confirm no listener handles remain after stop.

### Potential Risks
None.

### Dependencies and Constraints
None beyond existing resolver tests.

### Additional Notes
This issue strengthens daemon reliability.

## 53. Add frontend linting rules for complex form logic and `BridgeForm` maintainability

Labels: frontend, backend, smartcontract, complexity

### Summary
Introduce targeted ESLint rules or custom linting guidance to reduce cognitive complexity in `BridgeForm.tsx` and similar components.

### Background and Context
`BridgeForm.tsx` is large and contains complex logic, making it hard to maintain.

### Current Problem
High component complexity increases the risk of bugs and regressions.

### Technical Impact
The frontend codebase becomes harder to extend and audit.

### Business Impact
Slower feature development and higher maintenance costs.

### Root Cause Analysis
No project-specific linting or style enforcement for complex components.

### Detailed Scope of Work
Add lint rules or coding standards to identify large components and encourage refactoring.

### Implementation Procedure
1. Review `.eslintrc.json` and identify relevant rules such as `complexity`, `max-lines`, and `max-statements`.
2. Add or tune rules to target `BridgeForm.tsx` or large components.
3. Optionally extract subcomponents and logic helpers to reduce complexity.
4. Add tests or lint pipeline checks.

### Architectural Considerations
Linting should enforce maintainability without being overly strict.

### Security Considerations
Better maintainability reduces future security bugs.

### Performance Considerations
None.

### Testing Requirements
Run ESLint and confirm new rules pass with the updated component structure.

### Expected Deliverables
ESLint rule updates and `BridgeForm` refactor if needed.

### Definition of Done
The frontend passes lint checks with maintainability rules enabled.

### Acceptance Criteria
A reviewer can run lint and see the `BridgeForm` complexity issues resolved.

### Potential Risks
False positives from overly aggressive lint rules.

### Dependencies and Constraints
May require ESLint plugin config updates.

### Additional Notes
This issue improves long-term frontend maintainability.

## 54. Document coordinator observability and alerting best practices for production

Labels: frontend, backend, smartcontract, complexity

### Summary
Add production observability guidance and alerting best practices for the coordinator service.

### Background and Context
There are Prometheus metrics in `coordinator/ops`, but no consolidated documentation for production observability.

### Current Problem
Operators lack a shared reference for what metrics to monitor and what alerts to configure.

### Technical Impact
Suboptimal monitoring can delay incident detection and response.

### Business Impact
Better observability reduces downtime and operational risk.

### Root Cause Analysis
Metrics are implemented, but docs are incomplete.

### Detailed Scope of Work
Create a coordinator observability guide covering metrics, dashboards, and alert rules.

### Implementation Procedure
1. Add or update `coordinator/ops/README.md` with recommended alerts for listener lag, secret replay failures, and DB health.
2. Document metric names and thresholds.
3. Include examples for Prometheus/Grafana.

### Architectural Considerations
Docs should reflect current metric names and config options.

### Security Considerations
No direct security impact.

### Performance Considerations
None.

### Testing Requirements
Manual doc review.

### Expected Deliverables
Updated observability docs.

### Definition of Done
Production operators have a clear observability guide.

### Acceptance Criteria
A reviewer can follow the docs to configure basic coordinator monitoring.

### Potential Risks
Docs may become stale; keep it versioned.

### Dependencies and Constraints
No code changes beyond docs.

### Additional Notes
This issue improves SRE readiness.

## 55. Strengthen release CI with contract artifact verification and package publish gating

Labels: frontend, backend, smartcontract, complexity

### Summary
Enhance the release workflow to verify compiled contract artifacts and package builds before publishing.

### Background and Context
`.github/workflows/release.yml` exists but may not include full artifact or package validation.

### Current Problem
Release workflows can pass without verifying the exact built artifacts or package exports used for publishing.

### Technical Impact
Incomplete release validation increases the risk of shipping broken or mismatched artifacts.

### Business Impact
Release quality and reliability suffer.

### Root Cause Analysis
Current release CI may focus on source checks but not artifact consistency.

### Detailed Scope of Work
Add build verification steps and artifact checksum validation to the release workflow.

### Implementation Procedure
1. Review `release.yml` for current build and publish steps.
2. Add explicit contract compilation verification and package build sanity checks to the release pipeline.
3. Add artifact checksum or diff checks if possible.
4. Add a gating step that fails release if package build output does not match expectations.

### Architectural Considerations
Release CI should be deterministic and reproducible.

### Security Considerations
Artifact validation reduces supply chain risk.

### Performance Considerations
Release prep may take longer but is worth it.

### Testing Requirements
Validate the release workflow in a dry run or PR pipeline.

### Expected Deliverables
Release CI improvements and documentation.

### Definition of Done
The release workflow verifies contract artifacts and package builds before publishing.

### Acceptance Criteria
A reviewer can inspect the release workflow and confirm the new verification steps.

### Potential Risks
Release CI complexity increases; keep it manageable.

### Dependencies and Constraints
Relies on existing GitHub Actions features.

### Additional Notes
This issue improves release confidence.

## 56. Add frontend structured debug logging for wallet operations and order submission flows

Labels: frontend, backend, smartcontract, complexity

### Summary
Add structured logging in the frontend to capture wallet connection and submission flow details for easier debugging.

### Background and Context
The frontend currently uses `console.log` for debugging and lacks a structured debug logging framework.

### Current Problem
Debugging frontend failures in production or QA is difficult without consistent, structured logs.

### Technical Impact
Operators cannot diagnose wallet and transaction issues effectively.

### Business Impact
Slower bug resolution and higher support costs.

### Root Cause Analysis
No logging abstraction exists for frontend runtime events.

### Detailed Scope of Work
Introduce a frontend logging utility that can be enabled for debug builds and structured around event types.

### Implementation Procedure
1. Create `frontend/src/utils/logger.ts` or enhance existing logger support.
2. Replace ad hoc `console.log` calls in `BridgeForm.tsx` and wallet hooks with structured log calls.
3. Add a configuration flag to enable debug logging in development and staging.
4. Add tests or snapshots if possible.

### Architectural Considerations
Keep the logger lightweight and optional.

### Security Considerations
Do not log secrets or sensitive wallet data.

### Performance Considerations
Only enable structured logging in debug modes to avoid overhead.

### Testing Requirements
Add tests for the logger utility and verify no sensitive data is emitted.

### Expected Deliverables
Frontend logging utility and refactored debug statements.

### Definition of Done
Frontend wallet flow logs are structured and easier to analyze.

### Acceptance Criteria
A reviewer can see consistent log output for wallet connect/disconnect and order submit events.

### Potential Risks
Need to ensure logs remain readable and not overly verbose.

### Dependencies and Constraints
No external deps needed.

### Additional Notes
This issue aids debugging and QA.

## 57. Add coordinator event correlation and failure classification for secret reveal paths

Labels: frontend, backend, smartcontract, complexity

### Summary
Implement classified failure handling for secret reveal paths in the coordinator, differentiating validation failures, DB issues, and event replay conflicts.

### Background and Context
`SecretService` currently logs warnings for unmatched preimages but returns generic errors.

### Current Problem
Clients and operators cannot distinguish between invalid secrets, DB failures, and stale reveal attempts.

### Technical Impact
Poor failure classification makes debugging and client retry logic harder.

### Business Impact
Users may not know whether to retry or abandon a failing secret reveal.

### Root Cause Analysis
`SecretService` throws generic Error objects rather than typed failure cases.

### Detailed Scope of Work
Add typed secret reveal errors, enhance API responses, and document failure categories.

### Implementation Procedure
1. Introduce custom `SecretRevealError` subclasses or discriminated result types.
2. Update `SecretService.reveal` to distinguish invalid preimages, unknown orders, and DB write failures.
3. Update `secretsRoutes` to map errors to structured JSON responses.
4. Add tests for each failure type.

### Architectural Considerations
Keep the error model explicit and extensible.

### Security Considerations
Do not expose secrets or on-chain preimages in error responses.

### Performance Considerations
Negligible.

### Testing Requirements
Add unit tests for each error classification path.

### Expected Deliverables
Typed secret reveal errors and improved API responses.

### Definition of Done
The coordinator differentiates secret reveal failure modes clearly.

### Acceptance Criteria
A reviewer can see distinct error codes for invalid secret, unknown order, and DB failure.

### Potential Risks
Need to avoid revealing too much information to clients.

### Dependencies and Constraints
No external dependencies.

### Additional Notes
This issue helps clients handle secret reveals more intelligently.

## 58. Add frontend integration tests for coordinator API failure cases and retry behavior

Labels: frontend, backend, smartcontract, complexity

### Summary
Extend frontend tests to cover coordinator API failures and retry behavior in the bridge flow.

### Background and Context
The frontend currently assumes coordinator APIs are available and does not test failure modes thoroughly.

### Current Problem
Coordinator downtime or network errors can lead to untested frontend paths.

### Technical Impact
Uncaught failure states can produce broken UI behavior.

### Business Impact
Client-side resilience is essential for a robust cross-chain bridge.

### Root Cause Analysis
Frontend tests focus on happy paths rather than coordinator failure scenarios.

### Detailed Scope of Work
Add integration tests that simulate coordinator API errors and verify retry/fallback behavior.

### Implementation Procedure
1. Add mocked network responses for coordinator endpoints in frontend tests.
2. Test the bridge form when `/orders/announce` fails and when quote or history endpoints return errors.
3. Verify the UI shows retry prompts or error messages.

### Architectural Considerations
Use existing test utilities to mock fetch or XHR.

### Security Considerations
No direct impact.

### Performance Considerations
Test-only.

### Testing Requirements
Add frontend integration tests for coordinator error handling.

### Expected Deliverables
New frontend tests and UI handling improvements if needed.

### Definition of Done
Frontend handles coordinator failures predictably in tests.

### Acceptance Criteria
A reviewer can run the tests and see coordinator error cases covered.

### Potential Risks
None.

### Dependencies and Constraints
No new dependencies expected.

### Additional Notes
This issue improves frontend resilience.

## 59. Add contract deployment config validation and environment gating for Solidity scripts

Labels: frontend, backend, smartcontract, complexity

### Summary
Validate contract deployment environment variables and network configuration before deploy scripts run.

### Background and Context
`contracts/scripts/deploy.ts` and Hardhat config rely on environment variables that may be misconfigured.

### Current Problem
A deploy script can run against the wrong network or with invalid addresses without sufficient pre-flight checks.

### Technical Impact
Incorrect deployments waste gas and can create orphaned contract states.

### Business Impact
Deployment errors are costly and can delay releases.

### Root Cause Analysis
Deployment scripts currently assume config correctness without explicit validation.

### Detailed Scope of Work
Add deploy-time config validation and preflight checks for required addresses and network mode.

### Implementation Procedure
1. Add environment validation in `deploy.ts` and `hardhat.config.ts`.
2. Validate required addresses, private key presence, and network endpoints.
3. Add dry-run warnings and explicit error messages for common misconfigurations.
4. Add tests or scripts to verify validation logic.

### Architectural Considerations
Deploy scripts should fail early and clearly.

### Security Considerations
Do not log private keys or secrets.

### Performance Considerations
Validation only runs once.

### Testing Requirements
Add tests for bad deployment envs and preflight check results.

### Expected Deliverables
Deployment config validation and tests.

### Definition of Done
Deploy scripts refuse to run with invalid environment configuration.

### Acceptance Criteria
A reviewer can run the deploy script with a missing env var and observe a clear failure.

### Potential Risks
None.

### Dependencies and Constraints
No external dependencies.

### Additional Notes
This issue reduces production deployment risk.

## 60. Improve monorepo developer experience with a reproducible dev container and workspace README guides

Labels: frontend, backend, smartcontract, complexity

### Summary
Add or enhance developer onboarding docs and dev container configuration to make the repo easier to set up consistently.

### Background and Context
The current README provides start steps, but there is no dedicated dev container or consolidated onboarding guide.

### Current Problem
New contributors may struggle with environment setup across multiple package roots and toolchains.

### Technical Impact
Higher onboarding friction slows contribution velocity.

### Business Impact
Fewer quality contributions and longer ramp times for maintainers.

### Root Cause Analysis
The repo has many language/toolchain requirements but lacks an integrated developer environment guide.

### Detailed Scope of Work
Add a `.devcontainer` or `docs/DEVELOPMENT.md` with reproducible setup instructions and workspace-specific commands.

### Implementation Procedure
1. Create or update a devcontainer configuration for Node 22, pnpm, Rust, Stellar CLI, and Foundry.
2. Document package-specific build and test commands in `README.md` or a dedicated `DEVELOPMENT.md`.
3. Add troubleshooting notes for common environment issues.
4. Add a quick-start section for using the dev container.

### Architectural Considerations
Keep docs concise and accurate for the monorepo’s mixed stack.

### Security Considerations
No security impact.

### Performance Considerations
Dev environment should be reproducible and performant enough for development.

### Testing Requirements
Manual validation by launching the dev container or verifying docs via a local run.

### Expected Deliverables
Dev container config or docs and onboarding guidance.

### Definition of Done
New contributors can start development using the documented dev environment.

### Acceptance Criteria
A reviewer can follow the guide and set up the workspace for local development.

### Potential Risks
Maintaining devcontainer config requires periodic updates.

### Dependencies and Constraints
May require adding `.devcontainer` files or verifying existing environment support.

### Additional Notes
This issue improves long-term contributor experience.
