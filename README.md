<p align="center">
  <img src="frontend/public/images/wafflefinance-logo.svg" alt="WaffleFinance" width="120" />
</p>

<h1 align="center">WaffleFinance</h1>

<p align="center">
  <strong>Non-custodial cross-chain atomic swap — Ethereum · Stellar · Solana</strong><br/>
  No validator set. No attester. No admin escape hatch.
</p>

<p align="center">
  <a href="https://sepolia.etherscan.io/address/0xb352339BEb146f2699d28D736700B953988bB178">Sepolia Contract</a> ·
  <a href="https://stellar.expert/explorer/testnet/contract/CDIKSJKVMXKGBRD3BBEBMF7Q4GQJ52ECU6R6G5HEKXKXVGGWK2CTA6JK">Stellar Testnet</a> ·
  <a href="https://github.com/Waffle-finance/waffle-finance-core/actions">CI</a>
</p>

---

## What it is

WaffleFinance locks funds in Hash Time-Lock Contracts (HTLCs) on each chain simultaneously. Settlement is a `sha256` preimage reveal — not a multisig, not an attester signature.

If anything fails — coordinator down, resolver offline, RPC unavailable, frontend unreachable — locked funds either settle to the beneficiary or refund permissionlessly to the user. There is no state where funds are stuck under operator control.

> **Status:** Live on testnet (Sepolia + Stellar testnet + Solana devnet). Mainnet gated until independent audit (Q1 2027).

---

## Supported chains

| Chain | Asset | Status |
|---|---|---|
| Ethereum (Sepolia) | ETH | ✅ Live |
| Stellar | XLM | ✅ Live |
| Solana | SOL | ✅ Live |

---

## How it works

```
User locks ETH (24h timelock)       →    Resolver locks XLM/SOL (12h timelock)
                                                       ↓
                                          User claims XLM/SOL, revealing secret
                                                       ↓
Resolver claims ETH using secret    ←    Secret is now public on-chain
```

Both legs settle, or both legs refund. The 12h vs 24h timelock gap ensures the resolver's destination refund always expires before the user's source — so neither party can ever be stuck.

---

## Trust model

Funds move under exactly two conditions:

1. A caller submits a preimage where `sha256(preimage) == hashlock` before `timelock` — funds go to `beneficiary`
2. `timelock` has expired — anyone calls `refundOrder` and funds return to `refundAddress` (always the original user)

**Robust native-ETH payout.** A `beneficiary` / `refundAddress` that is a smart contract may revert on receipt or exhaust the bounded gas stipend. Rather than letting that block a settlement backed by a valid preimage or an expired timelock, `HTLCEscrow` attempts a direct push and, if it fails, **credits the amount to the recipient's pull-payment balance** instead of reverting. The claim/refund still finalises (the preimage is revealed on-chain either way), and the recipient — and *only* that recipient — recovers the funds permissionlessly via `withdraw()`. This adds no custodial surface: credited funds are never pooled or operator-movable, and `withdraw()` can only return a caller's own balance, never locked order funds.

The coordinator is a metadata service that never signs transactions touching user funds. Resolvers stake into `ResolverRegistry`; misbehaviour is slashable on-chain.

| Attack vector | Validator-set bridge | WaffleFinance |
|---|---|---|
| Compromise off-chain signers | **Funds lost** | No effect — no signers |
| Compromise first-party attester | **Funds lost** | No effect — no attesters |
| Break sha256 | Safe | Funds at risk (breaks all of crypto) |
| Compromise chain consensus | Funds at risk | Funds at risk (inherited) |

---

## Deployed contracts (testnet)

| Contract | Chain | Address |
|---|---|---|
| `HTLCEscrow` | Sepolia | [`0xb352339BEb…988bB178`](https://sepolia.etherscan.io/address/0xb352339BEb146f2699d28D736700B953988bB178) |
| `ResolverRegistry` | Sepolia | [`0x7D9ce70Aa4…1B6D1D99`](https://sepolia.etherscan.io/address/0x7D9ce70Aa40E144E8BbE266a0dc3b3F91B6D1D99) |
| `wafflefinance-htlc` | Stellar testnet | [`CDIKSJKV…CTA6JK`](https://stellar.expert/explorer/testnet/contract/CDIKSJKVMXKGBRD3BBEBMF7Q4GQJ52ECU6R6G5HEKXKXVGGWK2CTA6JK) |
| `wafflefinance-resolver-registry` | Stellar testnet | [`CBSR7Z4M…Z4WGF`](https://stellar.expert/explorer/testnet/contract/CBSR7Z4MHLPMLFFM5K3PK3YLZAVCOMJ4KPVRWO4VPL3FF64MSTIZ4WGF) |
| Anchor HTLC | Solana devnet | Pending deployment |

---

## Refund layers

Four independent recovery mechanisms — each a backstop for the previous one.

| Layer | Trigger | Latency |
|---|---|---|
| On-chain HTLC refund | `timelock` expires; anyone calls `refundOrder` | ≤ 24h |
| Frontend refund dialog | "Refund" button in transaction history | User-driven |
| Automatic refund | Destination leg fails mid-request; relayer refunds inline | < 30s |
| Background watchdog | Swap pending > 5 min; background scanner fires | < 6 min |

Even with the coordinator, relayer, and frontend all offline, layer 1 alone is sufficient — the user calls `refundOrder` directly from any wallet.

---

## Repository layout

```
contracts/          Solidity — HTLCEscrow + ResolverRegistry (Ethereum)
soroban/            Rust — Soroban HTLC + ResolverRegistry (Stellar)

packages/
  sdk/              @wafflefinance/sdk — shared TS types, asset mappings,
                    state machine, Solana + Stellar + Ethereum HTLC clients

coordinator/        Order book service (SQLite/Postgres, REST, never holds keys)
  src/
    listeners/      Ethereum + Soroban + Solana event listeners
    services/       OrderService, SecretService, QuoteService
    persistence/    Schema, migrations, repository
    server/         Express routes (/orders, /quotes, /secrets, /metrics)
    state-machine/  Shared order state machine
  migrations/
    001_initial.sql     Base schema
    002_solana_support.sql  Adds solana to Chain/Direction constraints

relayer/            Bridge relay service
  src/
    listeners/      Block polling, contract event poller
    services/       Gas tracker, refund watchdog, XLM refund, recovery

resolver/           Open-source resolver runner + Docker image
frontend/           React + Vite dApp (Ethereum · Stellar · Solana)
e2e/                Cross-chain differential test harness
```

The supported build, test, lint, and smoke-test entry points for every
package are documented in [docs/COMMANDS.md](docs/COMMANDS.md) — start there
to find the right command for the package you're touching. New to the repo?
Start with the [Contributor Handbook](docs/CONTRIBUTOR_HANDBOOK.md) instead —
it maps package boundaries to validation checklists. For how the pieces fit
together end to end, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Quick start

**Dev container (recommended):** open the repo in VS Code with the [Dev Containers extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers). VS Code will prompt you to reopen in the container — it installs Node 22, pnpm, Rust, stellar-cli, and Foundry automatically.

**Native setup** — requirements: Node 22.5+, pnpm 8+, Rust stable + `wasm32-unknown-unknown` target, `stellar-cli`, Foundry.

```bash
git clone https://github.com/Waffle-finance/waffle-finance-core
cd waffle-finance-core
pnpm install
cp env.example .env          # fill in RPC URLs and private keys
```

```bash
# Build shared SDK (required before anything else)
pnpm --filter @wafflefinance/sdk build

# Compile + test Solidity contracts
pnpm --filter @wafflefinance/contracts exec hardhat test

# Test Soroban contracts
cd soroban && cargo test && cd ..

# Start coordinator
pnpm --filter @wafflefinance/coordinator dev

# Seed with demo data for local development (optional)
pnpm --filter @wafflefinance/coordinator seed-demo

# Start frontend
pnpm --filter @wafflefinance/frontend dev
```

See [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) for per-package commands, PostgreSQL setup, Stellar contract deployment, and troubleshooting notes.

See [`docs/OPERATIONS.md`](docs/OPERATIONS.md) for deployment checklists, incident response runbooks, and monitoring guidance.

See [`docs/TECHNICAL_DEBT.md`](docs/TECHNICAL_DEBT.md) for the service-level technical debt register and roadmap — architectural gaps, known limitations, and planned improvements across all services.

See [`docs/QUALITY_GATE.md`](docs/QUALITY_GATE.md) for the contract that keeps code, runtime config, and docs in sync — including a running list of drift found in the repo.

See [`docs/DEPLOYMENT_ROLLBACK_RUNBOOK.md`](docs/DEPLOYMENT_ROLLBACK_RUNBOOK.md) for the rollback-first deployment procedure for the coordinator and relayer.

See [`docs/RELEASE_CONTRACT.md`](docs/RELEASE_CONTRACT.md) for the typed build/release contract covering every package, including known gaps in local release verification.

See [`docs/SMOKE_TEST_CONTRACT.md`](docs/SMOKE_TEST_CONTRACT.md) for the repo-wide smoke test contract spanning coordinator readiness, order announcement, SDK init, and the frontend entry point.

See [`docs/RPC_DEGRADATION_TEST_MATRIX.md`](docs/RPC_DEGRADATION_TEST_MATRIX.md) for the deterministic multi-chain RPC degradation test matrix — proving the coordinator, relayer, and resolver degrade honestly under delayed, reset, and partial-receipt RPC conditions.

See [`docs/PERFORMANCE_BASELINE.md`](docs/PERFORMANCE_BASELINE.md) for the measurable performance baseline covering order lookup, announcement, event replay, and stale-order cleanup.

See [`docs/DRIFT_DETECTION_RUNBOOK.md`](docs/DRIFT_DETECTION_RUNBOOK.md) for the runbook that catches drift between deployed contract addresses, config values, runtime code, and docs before it reaches production.

See [`docs/MAINTENANCE_CALENDAR.md`](docs/MAINTENANCE_CALENDAR.md) for the scheduled operational task calendar — health checks, dependency reviews, environment parity, and release validation tasks with owners and cadences.

See [`docs/BACKLOG_HYGIENE.md`](docs/BACKLOG_HYGIENE.md) for issue quality standards, templates, ownership rules, and the triage and stale-issue process that keeps the backlog actionable.

See [`docs/RELEASE_NOTES_PROCESS.md`](docs/RELEASE_NOTES_PROCESS.md) for how to write release notes, what categories to cover, and how to record validation and rollback guidance. The fill-in template is at [`.github/RELEASE_NOTES_TEMPLATE.md`](.github/RELEASE_NOTES_TEMPLATE.md).

---

## Wallet support

| Wallet | Chain | Hook |
|---|---|---|
| MetaMask | Ethereum | `window.ethereum` |
| Freighter | Stellar | `useFreighter()` |
| Phantom | Solana | `useSolanaWallet()` |

All three wallets can be connected simultaneously from the wallet menu. The bridge form automatically selects the correct wallets based on the chosen route.

---

## Solana integration

The Solana leg is fully wired end-to-end:

- **SDK** — `SolanaHTLCClient` in `packages/sdk/src/solana/` handles `createOrder`, `claimOrder`, `refundOrder` with real Anchor instruction builders and account deserialization.
- **Relayer** — `ConfiguredSolanaIntegration` in `relayer/src/services/solana-contract.ts` submits real Solana transactions for lock, claim, and refund operations.
- **Coordinator** — `SolanaListener` polls RPC for HTLC program logs and forwards `OrderCreated`, `OrderClaimed`, `OrderRefunded` events into `OrderService`.
- **DB** — `Chain` type includes `"solana"`, `Direction` includes `"eth_to_sol"` and `"sol_to_eth"`. Migration `002_solana_support.sql` upgrades existing databases.
- **Frontend** — `useSolanaWallet()` handles Phantom connection. Route selector in `BridgeForm` exposes all four routes.
- **Asset mappings** — `resolveSolanaAsset()` and `resolveEthereumTokenFromSolana()` in `packages/sdk/src/assets/` cover testnet (devnet USDC) and mainnet (native SOL).

To enable Solana settlement, set:

```env
SOLANA_RPC_URL=https://api.devnet.solana.com
SOLANA_HTLC_PROGRAM=<your_program_id>
SOLANA_PRIVATE_KEY=<your_relayer_keypair>
```

---

## Running a resolver

Anyone who stakes into `ResolverRegistry` can run a resolver.

```bash
docker run ghcr.io/wafflefinance/resolver:latest register
docker run ghcr.io/wafflefinance/resolver:latest run
```

See [`resolver/`](resolver/) for environment variable reference.

---

## Deploying contracts

```bash
cp env.example .env

# Sepolia testnet
pnpm --filter @wafflefinance/contracts exec hardhat run scripts/deploy.ts --network sepolia

# Mainnet (after audit)
pnpm --filter @wafflefinance/contracts exec hardhat run scripts/deploy.ts --network mainnet
```

Deployment addresses are written to `deployments.<network>.json` and picked up automatically by the coordinator and frontend.

---

## Test coverage

| Layer | Tests | Framework |
|---|---|---|
| Soroban HTLC | 10 | Rust `#[contracttest]` |
| Soroban ResolverRegistry | 6 | Rust `#[contracttest]` |
| EVM HTLCEscrow | 15 | Hardhat + Chai |
| EVM ResolverRegistry | 6 | Hardhat + Chai |
| SDK | 8 | Vitest |
| Coordinator | 4 | Vitest |

All suites gate every pull request via GitHub Actions.

---

## Key environment variables

All environment variables across the monorepo packages are consolidated and validated using the shared `@wafflefinance/config` package (under `packages/config`). Invalid or missing values fail fast with clear, actionable validation messages at startup.

| Variable | Used by | Description |
|---|---|---|
| `ETHEREUM_RPC_URL` | relayer, coordinator | Sepolia or mainnet RPC |
| `RELAYER_PRIVATE_KEY` | relayer | ETH signing key |
| `RELAYER_STELLAR_SECRET` | relayer | Stellar signing key |
| `SOLANA_RPC_URL` | coordinator | Solana RPC endpoint |
| `SOLANA_HTLC_PROGRAM` | coordinator, relayer | Anchor program ID (leave blank to disable Solana) |
| `NETWORK_MODE` | relayer, frontend | `testnet` or `mainnet` |
| `VITE_MAINNET_ENABLED` | frontend | Set `true` post-audit to unlock mainnet UI |

Full reference in [`env.example`](env.example).

---
ChunkedIndex Dead Surface Area Cleanup

Issue

Remove or justify unused "ChunkedIndex" APIs

The "ChunkedIndex" implementation in "src/storage.rs" contains five methods that currently appear to be unused:

- "ChunkedIndex::set_subject_chunk"
- "ChunkedIndex::set_issuer_chunk"
- "ChunkedIndex::issuer_count"
- "ChunkedIndex::get_subject_all"
- "ChunkedIndex::get_issuer_all"

The first two are private helper methods, while the final three are public methods.

Running:

cargo check --lib

reports these methods as unused.

The purpose of this task is to determine whether these methods are genuinely unnecessary, whether they should be integrated into the existing chunked-pagination implementation, or whether they need to remain as intentionally exposed API.

The final result should make the "ChunkedIndex" API easier to understand and ensure that dead code does not obscure the load-bearing chunk storage and pagination logic.

---

1. Background

"ChunkedIndex" is responsible for maintaining chunked storage for subject and issuer indexes.

The module uses chunked persistence rather than storing an unbounded collection in a single persistent value.

Conceptually, the storage model looks like:

Subject
  |
  +-- Chunk 0
  +-- Chunk 1
  +-- Chunk 2
  +-- ...

and:

Issuer
  |
  +-- Chunk 0
  +-- Chunk 1
  +-- Chunk 2
  +-- ...

The chunked representation is important because the storage layer needs to work within persistence and serialization constraints while still supporting retrieval of large indexes.

The current implementation contains multiple methods that appear related to this design.

However, not every method is actually part of the active implementation path.

That creates ambiguity.

A contributor reading the module may reasonably assume that:

set_subject_chunk(...)

and:

set_issuer_chunk(...)

are the canonical ways of writing chunks.

They are not currently used by the actual write path.

Instead, the active methods:

write_subject_chunks(...)

and:

write_issuer_chunks(...)

perform the persistent writes directly.

Likewise, the public methods:

issuer_count(...)
get_subject_all(...)
get_issuer_all(...)

currently have no callers within "src/".

This means the API exposes functionality that does not appear to participate in the current internal design.

---

2. Problem Statement

The problem is not simply that five functions generate compiler warnings.

The larger problem is architectural clarity.

"ChunkedIndex" is a load-bearing storage component.

Its chunk-writing and pagination behavior needs to be easy to understand.

Unused methods introduce several problems:

1. They increase the apparent API surface.
2. They make it harder to identify the canonical write path.
3. They suggest functionality that may not actually be supported internally.
4. They increase maintenance requirements.
5. They make future refactoring more difficult.
6. They can cause contributors to use the wrong helper.
7. They make compiler warnings less useful.
8. They obscure which functions are actually required by production code.
9. They make the storage abstraction look more complicated than it is.
10. They can preserve outdated implementation ideas after the architecture has changed.

The goal is therefore to establish one clear and intentional API.

---

3. Affected Methods

The following methods are the direct scope of this task.

3.1 "set_subject_chunk"

Location:

src/storage.rs:1304-1316

Current characteristics:

- Private helper.
- Never called.
- Appears intended to write a subject chunk.
- Actual chunk writing currently happens through "write_subject_chunks".
- Its direct persistence behavior overlaps with the active implementation.

---

3.2 "set_issuer_chunk"

Location:

src/storage.rs:1304-1316

Current characteristics:

- Private helper.
- Never called.
- Appears intended to write an issuer chunk.
- Actual chunk writing currently happens through "write_issuer_chunks".
- Its functionality overlaps with the active write path.

---

3.3 "issuer_count"

Location:

src/storage.rs:1464

Current characteristics:

- Public method.
- No callers found in "src/".
- Appears to expose issuer-count information.
- Needs an API-usage investigation before removal.

---

3.4 "get_subject_all"

Location:

src/storage.rs:1478

Current characteristics:

- Public method.
- No callers found in "src/".
- Appears to retrieve all subject entries.
- Potentially overlaps with paginated retrieval functionality.

---

3.5 "get_issuer_all"

Location:

src/storage.rs:1482

Current characteristics:

- Public method.
- No callers found in "src/".
- Appears to retrieve all issuer entries.
- Potentially overlaps with paginated retrieval functionality.

---

4. Primary Objective

Determine whether the five methods should:

1. Be deleted as dead code.
2. Be integrated into the active implementation.
3. Be retained as intentionally public API.
4. Be replaced with better-named or better-scoped APIs.
5. Be covered by tests if they are intentionally retained.

The preferred result is not simply "make "cargo check" quiet."

The preferred result is:

«Make the "ChunkedIndex" implementation accurately reflect the functionality that is actually supported and required by the project.»

---

5. Important Constraint

Do not blindly delete the public methods.

Private unused helpers and unused public APIs have different implications.

For private methods, repository-local usage is generally sufficient to establish whether they are dead.

For public methods, the investigation must consider:

- External callers.
- Integration tests.
- Examples.
- Benchmarks.
- Documentation.
- Generated bindings.
- Public library API expectations.
- Other workspace crates.
- Feature-gated code.

Before removing a public method, verify the repository structure and crate usage carefully.

---

6. Repository Investigation

Before modifying code, inspect the entire repository.

Start with:

git status

Confirm the working tree is clean or understand any existing changes.

Then inspect:

src/storage.rs

around:

ChunkedIndex

and the affected methods.

Search for all references:

rg "set_subject_chunk" .

rg "set_issuer_chunk" .

rg "issuer_count" .

rg "get_subject_all" .

rg "get_issuer_all" .

Also search for:

rg "ChunkedIndex" .

This establishes the broader usage of the type.

---

7. Inspect the Active Write Path

The most important part of the investigation is understanding:

write_subject_chunks(...)

and:

write_issuer_chunks(...)

Determine:

- How chunks are created.
- How chunks are serialized.
- How chunks are persisted.
- How chunk counts are stored.
- How existing chunks are overwritten.
- How stale chunks are removed.
- How pagination interacts with writes.
- Whether the unused helpers duplicate only one part of the process.
- Whether there are subtle differences between the helper and active implementation.

Do not delete helpers merely because they look duplicated.

First confirm that the active methods fully replace their behavior.

---

8. Compare the Helpers

Compare:

set_subject_chunk(...)

with the corresponding code in:

write_subject_chunks(...)

Then compare:

set_issuer_chunk(...)

with:

write_issuer_chunks(...)

Look specifically for:

- Key generation.
- Serialization.
- Storage namespace.
- Error handling.
- Value encoding.
- Chunk numbering.
- Metadata updates.
- Transaction boundaries.
- Environment access.
- Persistence behavior.

The comparison should establish whether the helper is:

exact duplicate

or:

partial abstraction

or:

historical implementation

or:

intended abstraction that was never adopted

---

9. Inspect the Read Path

The same investigation must be performed for:

issuer_count
get_subject_all
get_issuer_all

Inspect nearby methods.

Look for methods such as:

get_subject_page
get_issuer_page
subject_count
issuer_count
get_subject_chunk
get_issuer_chunk

or equivalent names.

Determine whether the public methods are remnants of an earlier API.

---

10. Understand Pagination

The project should preserve the existing chunked-pagination design.

The task is not an excuse to redesign pagination.

Document how pagination currently works.

For example:

index
  |
  +-- total count
  |
  +-- chunk 0
  +-- chunk 1
  +-- chunk 2
  +-- chunk N

A page request should only load the necessary chunk data where possible.

If the active implementation is designed to avoid loading an entire index into memory, do not replace it with a simpler implementation that defeats that purpose.

---

11. Why "get_*_all" Requires Extra Attention

Methods named:

get_subject_all()

and:

get_issuer_all()

can be deceptively convenient.

However, retrieving an entire index may have undesirable characteristics.

For a large index:

get_all()

could require:

chunk 0
chunk 1
chunk 2
...
chunk N

to be loaded into memory.

That may conflict with the reason the project introduced chunking in the first place.

Therefore, before retaining these methods, determine whether full retrieval is genuinely required by the application.

If pagination is the intended access pattern, unused "get_*_all" methods should not remain merely because they are convenient.

---

12. Public API Considerations

The methods:

issuer_count
get_subject_all
get_issuer_all

are public.

Public visibility does not automatically mean they must remain forever.

However, removing public API requires greater care.

Check:

cargo metadata

and inspect workspace members.

Then search all workspace crates.

Also inspect:

tests/
examples/
benches/

if present.

Search outside "src/":

rg "get_subject_all" .

and equivalent searches for every method.

If no references exist and the methods are not part of an intentionally supported external API, removal may be appropriate.

---

13. Check Documentation

Search for method names in documentation:

rg "get_subject_all" README.md docs/ src/ tests/ examples/

Repeat for all five methods.

Also inspect:

/// documentation comments

associated with the methods.

If documentation promises behavior that is not otherwise used, decide whether the documentation is outdated or whether the API is intended for external use.

---

14. Check Feature-Gated Code

Search for conditional compilation:

#[cfg(...)]

around "ChunkedIndex".

A method may appear unused under the default configuration but be required under another feature.

Run:

cargo check --all-features

if the project supports features.

Also consider:

cargo test --all-features

where practical.

Do not remove functionality that is required by a supported feature configuration.

---

15. Check Workspace Dependencies

If this is a workspace, inspect:

cargo metadata --no-deps

Identify all local packages.

Then search all packages for:

ChunkedIndex

and the five methods.

This prevents accidentally removing functionality required by another crate.

---

16. Establish the Canonical Write API

The final code should make it obvious which methods perform chunk writes.

If:

write_subject_chunks(...)

is the canonical subject writer, then contributors should not also see an unused:

set_subject_chunk(...)

without a clear reason.

The same applies to issuer chunks.

The goal is to avoid two competing abstractions.

---

17. Preferred Private Helper Decision

If:

set_subject_chunk(...)

and:

set_issuer_chunk(...)

are genuinely unused and duplicate active implementation logic, remove them.

Do not introduce new callers merely to silence the compiler.

For example, avoid doing this:

write_subject_chunks(...)
    -> set_subject_chunk(...)

unless the helper genuinely improves the implementation.

An abstraction should exist because it improves correctness, reuse, or readability—not simply because the function already exists.

---

18. Alternative: Refactor Into Helpers

There is one legitimate reason to keep the private helpers.

If the active write functions contain duplicated storage operations and the helper can centralize them without changing behavior, then refactoring may be appropriate.

For example:

fn set_subject_chunk(...) -> Result<...>

could become the single canonical primitive used by:

write_subject_chunks(...)

However, this should only be done if the resulting code is clearer.

Do not force an abstraction that makes the chunk-writing lifecycle harder to understand.

---

19. Avoid Premature Generic Abstraction

It may be tempting to create:

set_chunk(...)

with generic subject/issuer parameters.

Avoid doing this unless the storage model clearly supports such an abstraction.

Subject and issuer chunks may have different:

- Key formats.
- Serialization.
- Counts.
- Retrieval semantics.
- Pagination requirements.

The cleanup should preserve domain clarity.

---

20. Investigate "issuer_count"

Determine what:

issuer_count(...)

actually represents.

Possible interpretations include:

- Number of issuers.
- Number of chunks.
- Number of entries.
- Number of persisted issuer records.

These are not necessarily equivalent.

Document the exact semantics before making a decision.

---

21. Count Versus Chunk Count

For example:

issuer_count = 1000

does not necessarily mean:

1000 chunks

If each chunk contains:

100 entries

then:

1000 entries

may correspond to:

10 chunks

The implementation should not expose ambiguous terminology.

If "issuer_count" is retained, its documentation should clearly describe what is being counted.

---

22. Investigate "get_subject_all"

Determine whether:

get_subject_all(...)

is simply a convenience wrapper around chunk iteration.

If so, determine whether it:

- Preserves ordering.
- Handles empty indexes.
- Handles partial chunks.
- Handles corrupted/missing chunks.
- Allocates a new collection.
- Returns references or owned values.
- Propagates storage errors.

If no production or external use exists, these semantics may not justify maintaining a public method.

---

23. Investigate "get_issuer_all"

Perform the same analysis for:

get_issuer_all(...)

Confirm whether it is:

- Required.
- Redundant.
- Historical.
- Useful for debugging only.
- Useful for tests only.
- Potentially dangerous for large indexes.

---

24. Do Not Optimize Unrelated Code

This issue should remain focused.

Do not change:

- Database schemas.
- Serialization formats.
- Public data structures.
- Pagination semantics.
- Chunk size.
- Storage key formats.
- Error types.

unless the investigation proves that one of these changes is necessary to remove the dead API safely.

---

25. Backward Compatibility

Before removing public methods, consider semantic-versioning expectations.

If this crate is published and the methods are part of its externally consumed API, removing them may constitute a breaking change.

Inspect:

[package]
name = ...
version = ...

and repository release conventions.

Also inspect:

CHANGELOG

if available.

If the crate is internal-only, the compatibility concern may be significantly smaller.

---

26. Recommended Decision Process

Use the following decision tree.

Is the method referenced anywhere?
        |
       Yes
        |
        v
Keep it and investigate its role.
        |
       No
        |
        v
Is it private?
   |              |
  Yes            No
   |              |
   v              v
Remove unless     Check external
needed for        API compatibility
future internal        |
design.                v
                   Is public API
                   intentionally
                   supported?
                    |       |
                   Yes      No
                    |       |
                    v       v
                  Keep    Remove

For private methods, unused code should normally be removed.

For public methods, make an explicit API decision.

---

27. Tests Before Modification

Run the existing test suite before changing code.

At minimum:

cargo test --lib

Then:

cargo test

If the repository supports it:

cargo test --all-features

Record the baseline.

The cleanup should not introduce unrelated failures.

---

28. Compiler Baseline

Run:

cargo check --lib

Confirm the reported warnings.

Then run:

cargo clippy --all-targets --all-features

if Clippy is part of the project's normal validation.

Do not treat every warning as part of this issue.

Only the five identified methods are directly in scope.

---

29. Implementation Option A — Delete Dead Methods

The simplest implementation is:

1. Remove "set_subject_chunk".
2. Remove "set_issuer_chunk".
3. Remove "issuer_count".
4. Remove "get_subject_all".
5. Remove "get_issuer_all".
6. Run formatting.
7. Run compilation.
8. Run tests.
9. Run Clippy.
10. Review the diff.

This option is appropriate if all five methods are demonstrably dead and the public API is not externally required.

---

30. Implementation Option B — Keep Public Methods

If the public methods are intentionally part of the library API, keep:

issuer_count
get_subject_all
get_issuer_all

but remove the two unused private helpers.

Then ensure the public methods have:

- Clear documentation.
- Tests.
- Correct error behavior.
- Correct pagination semantics.
- Explicit justification for their existence.

The goal would then be to eliminate dead private implementation surface while intentionally retaining public API.

---

31. Implementation Option C — Refactor Helpers

If the private helper logic is genuinely useful, refactor:

write_subject_chunks

to call:

set_subject_chunk

and:

write_issuer_chunks

to call:

set_issuer_chunk

Only choose this option if it improves readability and does not change behavior.

Tests must demonstrate that the refactor is behavior-preserving.

---

32. Avoid Fake Usage

Do not introduce meaningless calls such as:

let _ = self.set_subject_chunk(...);

just to make the compiler consider the function used.

Likewise, do not call "get_subject_all" from a debug-only path merely to preserve it.

Dead code should be removed unless there is a real reason to keep it.

---

33. Test Coverage for Chunk Writes

If helpers are refactored or deleted, tests should exercise the actual write path:

write_subject_chunks(...)

and:

write_issuer_chunks(...)

Test:

- Empty input.
- One chunk.
- Exactly one full chunk.
- Multiple chunks.
- Partial final chunk.
- Replacement of existing chunks.
- Retrieval after writing.
- Ordering.

---

34. Test Empty Indexes

Verify that an empty index behaves correctly.

For example:

subjects = []
issuers = []

Expected behavior should be established and preserved.

Potential outcomes include:

empty page

or:

empty collection

depending on the API.

Do not alter these semantics during cleanup.

---

35. Test Single-Chunk Indexes

Test a collection small enough to fit into one chunk.

This establishes the basic storage behavior.

For example:

entries = 1

and:

entries = chunk_size

should both be covered where practical.

---

36. Test Multi-Chunk Indexes

Test a collection that requires several chunks.

For example:

entries = chunk_size * 2 + 1

This verifies:

chunk 0
chunk 1
chunk 2

and ensures the final partial chunk is correctly handled.

---

37. Test Pagination

Pagination is the load-bearing design.

Tests should verify:

page 0
page 1
page 2

produce the expected entries.

Also verify:

page beyond end

behaves correctly.

---

38. Test Ordering

If the index guarantees ordering, preserve it.

A cleanup should not accidentally change:

[A, B, C, D]

into:

[D, C, B, A]

or otherwise reorder entries.

This is particularly important if "get_*_all" methods are removed and consumers switch to pagination.

---

39. Test Chunk Boundaries

Chunk boundaries are especially important.

Test values around:

chunk_size - 1
chunk_size
chunk_size + 1

These are common sources of off-by-one bugs.

---

40. Test Stale Chunk Removal

If "write_*_chunks" replaces a larger index with a smaller one, verify that stale chunks are not accidentally retained.

For example:

old:
chunk 0
chunk 1
chunk 2

then write:

new:
chunk 0

The old:

chunk 1
chunk 2

should not remain visible to future reads if the storage design requires their removal.

---

41. Storage Key Stability

Do not change storage key formats as part of this cleanup unless absolutely necessary.

The task concerns dead surface area.

Existing persisted data may depend on the current keys.

Changing them could create a migration problem unrelated to the issue.

---

42. Serialization Stability

Similarly, avoid modifying serialization formats.

The cleanup should not change:

stored bytes

or:

deserialization behavior

unless a test demonstrates an existing defect directly connected to the dead API.

---

43. Error Handling

Ensure the cleanup does not accidentally remove error propagation.

Storage operations can fail.

The active methods should continue to propagate:

Result

errors appropriately.

Do not replace proper error handling with:

unwrap()

or:

expect(...)

just to simplify code.

---

44. Documentation Update

After deciding which methods remain, update documentation if necessary.

The module should make the canonical architecture obvious.

For example:

ChunkedIndex stores subject and issuer indexes in persistent chunks.
Writes are performed by write_subject_chunks/write_issuer_chunks.
Reads use the pagination APIs.

Do not document methods that no longer exist.

---

45. Remove Stale Comments

Search for comments referring to removed helpers.

For example:

// Set each chunk using set_subject_chunk

would become stale if the helper is removed.

Remove or rewrite such comments.

---

46. Search Again After Editing

After modifications, repeat:

rg "set_subject_chunk" .

rg "set_issuer_chunk" .

rg "issuer_count" .

rg "get_subject_all" .

rg "get_issuer_all" .

This catches:

- Documentation references.
- Tests.
- Dead imports.
- Comments.
- Missed callers.

---

47. Formatting

Run:

cargo fmt --all -- --check

If formatting fails:

cargo fmt --all

Then inspect the resulting diff.

Formatting should not create unnecessary unrelated changes.

---

48. Compilation

Run:

cargo check --lib

The five unused-method warnings should disappear if the methods were removed.

Then run:

cargo check

if the repository supports non-library targets.

---

49. Tests

Run:

cargo test --lib

Then:

cargo test

If appropriate:

cargo test --all-features

All existing tests should continue passing.

---

50. Clippy

Run:

cargo clippy --all-targets --all-features

Review any warnings.

Do not automatically modify unrelated code.

---

51. Diff Review

Inspect:

git diff -- src/storage.rs

The final diff should be easy to explain.

Ideally it should contain:

- Removal of genuinely unused methods.
- Any necessary documentation updates.
- Tests if required.
- No unrelated architectural changes.

---

52. Git Status

Finally:

git status

Verify only intended files changed.

---

53. Acceptance Criteria

The task is complete when all applicable criteria below are satisfied.

Code

- [ ] "set_subject_chunk" is removed or intentionally integrated.
- [ ] "set_issuer_chunk" is removed or intentionally integrated.
- [ ] "issuer_count" is removed or intentionally retained.
- [ ] "get_subject_all" is removed or intentionally retained.
- [ ] "get_issuer_all" is removed or intentionally retained.
- [ ] No dead imports remain.
- [ ] No stale comments remain.

Architecture

- [ ] The canonical chunk-writing path is obvious.
- [ ] Subject chunk writes use one clear implementation.
- [ ] Issuer chunk writes use one clear implementation.
- [ ] Pagination remains intact.
- [ ] No unnecessary abstraction remains.

API

- [ ] Public methods were checked for external/workspace usage.
- [ ] Any removed public API has been assessed for compatibility.
- [ ] Any retained public method has a clear purpose.

Testing

- [ ] Existing tests pass.
- [ ] Chunk boundaries remain correct.
- [ ] Multi-chunk behavior remains correct.
- [ ] Empty indexes remain correct.
- [ ] Pagination remains correct.

Validation

- [ ] "cargo fmt --all -- --check" passes.
- [ ] "cargo check --lib" passes.
- [ ] "cargo test" passes.
- [ ] Relevant feature configurations pass.
- [ ] Clippy is clean or unrelated warnings are documented.

---

54. Suggested Commit Structure

If the change is small, one commit is appropriate:

storage: remove unused ChunkedIndex APIs

The commit should describe the cleanup rather than implying a functional redesign.

Example:

storage: remove unused ChunkedIndex APIs

Remove unused chunk setter helpers and unreferenced aggregate
accessors from ChunkedIndex after confirming that chunk writes and
pagination use the existing load-bearing paths.

---

55. Pull Request Description

The pull request should explain:

1. What was unused.
2. How usage was verified.
3. Which methods were removed.
4. Which methods, if any, were retained.
5. Why the active chunking implementation is unaffected.
6. What tests were run.

A concise PR summary can look like:

## Summary

- Remove unused ChunkedIndex chunk setter helpers.
- Remove unreferenced aggregate accessors after repository-wide usage checks.
- Preserve the existing chunked write and pagination implementation.
- Clean up the public surface so load-bearing APIs are easier to identify.

## Validation

- cargo fmt --all -- --check
- cargo check --lib
- cargo test
- cargo clippy --all-targets --all-features

Adjust the summary to match the actual implementation.

---

56. What Not To Do

Do not:

- Rewrite "ChunkedIndex".
- Change the storage format.
- Change chunk sizes.
- Replace pagination with full retrieval.
- Introduce unrelated abstractions.
- Modify unrelated modules.
- Delete methods without checking workspace usage.
- Preserve dead methods solely to avoid a breaking change without investigating API policy.
- Add artificial callers.
- Ignore feature-gated code.
- Change behavior unnecessarily.
- Mix this cleanup with unrelated bug fixes.

---

57. Risk Assessment

The risk of deleting the private helpers is relatively low if repository-wide search confirms no callers.

The risk associated with deleting public methods is higher.

The primary risks are:

external consumers
feature-gated callers
integration tests
workspace crates
published API compatibility

These should be investigated before deletion.

The functional risk to chunk storage should remain low if the existing:

write_subject_chunks
write_issuer_chunks

implementation is left unchanged.

---

58. Expected Final Architecture

After cleanup, the module should have a clear conceptual structure.

For example:

ChunkedIndex
|
+-- chunk key generation
|
+-- write_subject_chunks
|
+-- write_issuer_chunks
|
+-- subject pagination
|
+-- issuer pagination
|
+-- chunk retrieval
|
+-- count/metadata required by active implementation

There should not be a second unused layer of setters that suggests an alternative write architecture.

---

59. Why This Matters

Dead code is particularly problematic in infrastructure modules.

A storage module is not merely ordinary application code.

Developers need to know:

Which method writes data?
Which method reads data?
Which method controls pagination?
Which metadata is authoritative?
Which APIs are supported?

If unused methods remain, those answers become harder to determine.

Removing unnecessary surface area makes the architecture easier to maintain.

---

60. Maintainability Goal

The ideal result should allow a future contributor to open:

src/storage.rs

and quickly understand:

ChunkedIndex writes through these methods.
ChunkedIndex reads through these methods.
These methods are intentionally public.
These helpers are internal implementation details.

No archaeology should be required to determine whether a method is still relevant.

---

61. Review Questions

Before merging, reviewers should ask:

API

- Is every retained public method actually justified?
- Was external usage considered?
- Are public method names accurate?

Storage

- Did the change modify persistent behavior?
- Did storage keys remain unchanged?
- Did serialization remain unchanged?

Pagination

- Is pagination untouched?
- Are chunk boundaries preserved?
- Are large indexes still handled efficiently?

Code quality

- Is there now one obvious implementation?
- Were unnecessary abstractions removed?
- Is the resulting module easier to understand?

Tests

- Do existing tests pass?
- Are important chunk boundaries covered?
- Are there tests for any newly retained API?

---

62. Manual Verification

If automated tests do not cover all cases, perform manual verification.

Create a small index containing:

1 entry

then:

chunk_size entries

then:

chunk_size + 1 entries

and finally:

multiple chunks

Verify that retrieval produces the expected data.

---

63. Large Index Considerations

If "get_subject_all" and "get_issuer_all" are removed, confirm that callers have an appropriate paginated alternative.

The removal should not force consumers to implement unsafe storage access themselves.

The preferred pattern should remain:

request page
    |
    v
load relevant chunk
    |
    v
return page

rather than:

load everything
    |
    v
return entire index

where the latter defeats the chunking architecture.

---

64. If Public Methods Are Retained

If the investigation concludes that:

issuer_count
get_subject_all
get_issuer_all

are intentionally supported APIs, do not remove them simply because there are no internal callers.

Instead:

1. Add documentation.
2. Add tests.
3. Confirm their intended use.
4. Confirm their performance characteristics.
5. Make their relationship with pagination clear.

For example, documentation could explain that:

get_subject_all

is intended for callers that explicitly need the complete collection, while pagination should be preferred for large indexes.

---

65. If Public Methods Are Removed

If they are not supported externally, remove them cleanly.

Then verify there are no references:

rg "issuer_count" .
rg "get_subject_all" .
rg "get_issuer_all" .

The only remaining references should be historical discussion, if any.

Do not leave commented-out versions of the deleted methods.

Git history already provides that information.

---

66. If the Helpers Are Refactored

If:

set_subject_chunk

and:

set_issuer_chunk

are retained as active internal helpers, make sure their names accurately describe their role.

Their call graph should be obvious:

write_subject_chunks
        |
        v
set_subject_chunk
        |
        v
persistent storage

and:

write_issuer_chunks
        |
        v
set_issuer_chunk
        |
        v
persistent storage

Tests should exercise the public/primary write methods rather than directly testing private helpers unless there is a specific reason.

---

67. Avoid Changing Behavior During Refactoring

A refactor should preserve:

inputs
outputs
errors
storage keys
serialization
ordering
pagination

If any of these change, the PR has become more than a dead-code cleanup.

Separate such changes into another issue unless they are required to solve this one.

---

68. Compiler Warning Goal

After the cleanup, run:

cargo check --lib

The five identified unused-method warnings should no longer appear.

If other warnings remain, determine whether they are pre-existing.

Do not claim the entire repository is warning-free unless that has actually been verified.

---

69. Documentation Goal

The documentation should reflect the actual architecture.

Avoid descriptions such as:

ChunkedIndex provides multiple ways to write chunks.

if there is only one supported write path.

Instead, documentation should identify the canonical methods.

---

70. Review Diff Size

This issue should ideally result in a relatively small diff.

A large diff is a warning sign.

If the implementation changes hundreds of lines of unrelated storage code, stop and split the work.

The issue is fundamentally about:

dead surface area

not redesigning the storage engine.

---

71. Regression Prevention

The most valuable regression prevention is ensuring the active methods remain covered.

Tests should target:

write_subject_chunks
write_issuer_chunks

and the active retrieval/pagination APIs.

This ensures future cleanup does not accidentally remove the real implementation.

---

72. Future Contributor Guidance

After this issue is merged, new contributors should avoid adding public convenience methods without a clear consumer.

Before adding a method to "ChunkedIndex", ask:

Who calls this?
Why is it needed?
Does an existing method already provide this functionality?
Does it preserve the chunking design?
Does it need to be public?

This prevents the same dead-surface problem from returning.

---

73. API Design Principle

The general principle should be:

«Keep the smallest API that accurately represents supported behavior.»

An API should not expose functionality merely because implementing the function is easy.

Every public method increases:

- Documentation burden.
- Testing burden.
- Compatibility burden.
- Maintenance burden.
- Cognitive load.

---

74. Storage Design Principle

The chunked storage implementation should remain centered around its actual purpose:

bounded storage
+
predictable pagination
+
efficient retrieval

Convenience APIs should not obscure these properties.

---

75. Code Review Checklist

Reviewer:

- [ ] Confirmed all five methods were searched repository-wide.
- [ ] Confirmed feature-gated usage was considered.
- [ ] Confirmed workspace usage was considered.
- [ ] Confirmed external API implications.
- [ ] Confirmed active write paths remain unchanged.
- [ ] Confirmed chunk storage keys remain unchanged.
- [ ] Confirmed pagination remains unchanged.
- [ ] Confirmed tests pass.
- [ ] Confirmed formatting passes.
- [ ] Confirmed no unrelated changes exist.

---

76. Suggested Commands

Run the following during implementation:

git status

rg "set_subject_chunk" .

rg "set_issuer_chunk" .

rg "issuer_count" .

rg "get_subject_all" .

rg "get_issuer_all" .

rg "ChunkedIndex" .

cargo metadata --no-deps

cargo check --lib

cargo test --lib

cargo test

cargo fmt --all -- --check

cargo clippy --all-targets --all-features

---

77. Expected Outcome

The final implementation should have no unexplained dead "ChunkedIndex" surface.

The active storage path should be obvious.

If methods are deleted, the deletion should be justified by repository-wide usage analysis.

If methods are retained, their purpose should be explicitly documented and tested.

Either way, the result should improve architectural clarity without changing the underlying chunked-storage behavior.

---

78. Definition of Done

This issue can be marked complete when:

[✓] Unused private helpers investigated
[✓] Unused public APIs investigated
[✓] External/workspace usage checked
[✓] Feature-gated usage checked
[✓] Canonical write path identified
[✓] Dead methods removed or justified
[✓] Pagination preserved
[✓] Storage format preserved
[✓] Tests pass
[✓] Formatting passes
[✓] Compiler warnings addressed
[✓] Diff reviewed

---

79. Final Recommendation for Implementation

The default implementation path should be conservative:

1. Investigate all five methods.
2. Confirm the two setter helpers are genuinely redundant.
3. Remove the private setters if no real abstraction benefit exists.
4. Investigate the three public methods independently.
5. Remove the public methods only after confirming they are not supported externally.
6. Do not rewrite the active chunked write or pagination logic.
7. Add or update tests where API behavior is being retained.
8. Run the full validation suite.
9. Review the final diff for unrelated changes.

The important distinction is:

unused != automatically removable

for public API, while:

private + unused + redundant

is generally strong evidence that removal is appropriate.

---

80. Summary

"ChunkedIndex" is a load-bearing storage abstraction, so its API should clearly communicate which operations are actually part of the supported design.

The five methods identified by "cargo check --lib" should be investigated individually.

The two private setters:

set_subject_chunk
set_issuer_chunk

appear to be redundant because the active write methods already perform the required persistent chunk writes.

The three public methods:

issuer_count
get_subject_all
get_issuer_all

require a broader API investigation because lack of internal callers does not automatically prove that they are safe to remove.

The cleanup should preserve the existing chunked-pagination architecture and should not become a storage redesign.

The final goal is straightforward:

less dead code
+
clearer API
+
one obvious write path
+
preserved pagination
+
no unnecessary behavioral changes

A successful implementation will make "src/storage.rs" easier to understand, reduce misleading API surface, and make it immediately apparent which parts of "ChunkedIndex" are genuinely load-bearing.
## License

MIT. See `LICENSE` (file not yet committed to the repository).
