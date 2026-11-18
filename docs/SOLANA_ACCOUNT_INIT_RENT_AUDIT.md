# Solana Account Initialisation & Rent Audit

> **Owner:** Engineering team
> **Status:** current
> **Scope:** Solana HTLC account creation, account sizing, and rent exemption
> across the SDK, the relayer, and the devnet scripts.
> **Issue:** `fix/solana-account-init-rent-robustness`

---

## 0. Scope correction: there is no Anchor program in this repository

The issue as filed assumes an on-chain Anchor program with `#[account]`,
`#[derive(InitSpace)]`, and `space = ...`. **None of that exists here.** An
exhaustive search returned zero results for:

| Searched | Hits |
|----------|------|
| `Anchor.toml` | 0 |
| `#[program]` / `#[account]` / `InitSpace` / `init_if_needed` | 0 |
| `space = ` (Anchor attribute) | 0 |
| `anchor_lang` / `anchor-lang` in any `Cargo.toml` | 0 |
| `@coral-xyz/anchor` in any `package.json` (or in `pnpm-lock.yaml`) | 0 |
| `system_program::create_account`, `realloc`, `Rent::` | 0 |
| `anchor build` / `cargo build-sbf` in CI | 0 |

This is confirmed in-repo by `docs/UPGRADE_MIGRATION_SAFETY.md`:

> "The Solana program is currently in **simulation mode** — only SDK/IDL stubs
> are present in this repository."

What actually exists is:

1. **A hand-written TypeScript IDL** — `packages/sdk/src/solana/idl/htlc.ts` —
   that *describes* the Anchor program the SDK encodes and decodes against.
   The 227-byte account size is an assumption encoded as a literal.
2. **The real on-chain Rust is Soroban, not Solana** — `soroban/contracts/htlc`
   and `soroban/contracts/resolver-registry`. Soroban has no account sizes and
   no lamport rent; it has TTL ledgers. Out of scope for a Solana rent audit.
3. **A third "registry"** on EVM — `contracts/contracts/ResolverRegistry.sol`.
4. **No Solana resolver-registry exists at all.**

So the work below hardens the *client/service* side, which is where every
undocumented size and rent assumption in this repository actually lives. The
central deliverable is a single source of truth that the deployed Anchor
program can be checked against, and a CI gate that fails the moment the two
drift.

---

## 1. Account inventory

| # | Account | Where declared | Seeds | Size | Rent source |
|---|---------|----------------|-------|------|-------------|
| 1 | `HtlcOrder` | `packages/sdk/src/solana/idl/htlc.ts` | `[b"order", hashlock_32]` | 227 B (hardcoded literal) | **none — never computed** |
| 2 | `OrderRegistry` (global `state` / order counter) | `e2e/devnet-sim.ts` (inline magic numbers) | `[b"state"]` | **undeclared** | **none** |

Account 2 is the registry analogue. It is the only account in the repository
that a program *creates by counter* rather than by content hash, and it was
the worst offender: no size, no rent, no seed constant, offsets read as bare
literals (`readBigUInt64LE(8)`).

---

## 2. Per-account audit

### 2.1 `HtlcOrder` — 227 bytes

Byte map (after the 8-byte Anchor discriminator), as documented in the IDL:

| Offset | Size | Type | Field |
|-------:|-----:|------|-------|
| 0 | 1 | u8 | `version` |
| 1 | 32 | Pubkey | `sender` |
| 33 | 32 | Pubkey | `beneficiary` |
| 65 | 32 | Pubkey | `refund_address` |
| 97 | 32 | Pubkey | `mint` |
| 129 | 8 | u64 LE | `amount` |
| 137 | 8 | u64 LE | `safety_deposit` |
| 145 | 32 | `[u8;32]` | `hashlock` |
| 177 | 8 | i64 LE | `timelock` |
| 185 | 1 | u8 | `status` |
| 186 | 33 | `Option<[u8;32]>` | `preimage` (1 tag + 32) |
| | **219** | | **fields** |
| | **+8** | | **discriminator** |
| | **227** | | **total** |

Arithmetic is correct — 1 + 128 + 16 + 32 + 8 + 1 + 33 = 219, +8 = 227.

#### Findings

| ID | Severity | Finding |
|----|----------|---------|
| **F1** | High | `HTLC_ORDER_ACCOUNT_SIZE = 227` is a **bare literal**. Nothing derives it from the field table, so a future field added to `FIELD_OFFSET` without updating the size produces a silently corrupt constant. |
| **F2** | High | **`getMinimumBalanceForRentExemption` is never called in production.** The only calls in the repo are in `test/solana-integration.test.ts`, where the method is *spied on and mocked* to a hardcoded `2_039_280`. Nothing computes real rent for a real account. |
| **F3** | High | **No payer balance check anywhere.** `createOrder` in both `packages/sdk/src/solana/index.ts` and `relayer/src/services/solana-contract.ts` submits without verifying the payer can cover `amount + safety_deposit + rent_exemption + fee`. An underfunded payer produces an opaque runtime error at execution, not an actionable client error. |
| **F4** | High | **No simulation before send.** `_buildSignSend` goes straight to `sendRawTransaction`. `relayer` sets `skipPreflight: false` but never calls `simulate()`, so program-level logs (`Program log: ...`, custom error codes) are never surfaced. |
| **F5** | High | **No post-initialisation verification.** After `create_order` confirms, nothing re-fetches the PDA to confirm it exists, is owned by the program, has the expected data length, and is rent-exempt. A confirmed tx with a truncated account is indistinguishable from success. |
| **F6** | Medium | **Re-initialisation is only a warning.** `validateCreateOrderParams` pushes `"already initialised"` into `warnings` and returns `valid: true`. There is no `AccountAlreadyInitialized` error. |
| **F7** | Medium | **A pre-funded PDA is not detected at all.** A PDA address that already holds lamports but no data (someone transferred SOL to the future order address) is silently treated as "does not exist". The Anchor `init` will fail at runtime with `already in use`. |
| **F8** | Medium | **Size drift is asserted against a literal, not the layout.** `test/anchor-schema-stability.test.ts` and `test/fixtures-sync.test.ts` both assert `=== 227`. If someone bumps the literal to 228 to make a test pass, both still pass. The tests cannot distinguish "correct" from "consistently wrong". |
| **F9** | Medium | **The `state` registry account is undocumented.** `e2e/devnet-sim.ts` hardcodes `[b"state"]`, offset `8` for a u64 counter, and a hand-written 65-byte order layout comment that contradicts the SDK's byte map. |
| **F10** | Low | **Swallowed errors.** `account-validation.ts:445` has `catch { warnings.push(...) }` on the duplicate-PDA probe; a genuine RPC outage is downgraded to a warning. |
| **F11** | Low | `init_if_needed` is not used anywhere. There is no Anchor program here for an on-chain re-initialisation regression test. |

### 2.2 `OrderRegistry` (global `state`) — undeclared

Per `e2e/devnet-sim.ts`:

| Offset | Size | Type | Field |
|-------:|-----:|------|-------|
| 0 | 8 | `[u8;8]` | Anchor discriminator (`sha256("account:State")[0..8]`) |
| 8 | 8 | u64 LE | `order_count` |

Minimum size: 16 bytes. Rent-exempt minimum: 890_880 lamports.

#### Findings

| ID | Severity | Finding |
|----|----------|---------|
| **F12** | High | **No size constant at all.** Nothing states that this account is 16 bytes, so nothing can verify it after creation. |
| **F13** | High | **No rent is paid or checked.** `nextId` defaults to `1n` when the account is absent (`stateAccount ? … : 1n`), which silently assumes a fresh program. If the state account exists but the RPC returns a short buffer, `readBigUInt64LE(8)` reads past the end and returns `0n` — every subsequent order re-uses PDA #0. |
| **F14** | Medium | **Magic numbers** at `devnet-sim.ts:563, 574, 570`: seed `"state"`, seed `"order"`, counter offset `8`. |
| **F15** | Medium | The devnet script targets a **different program layout than the SDK**. `devnet-sim.ts` derives orders as `[b"order", id_u64_LE]` with a 56-byte `create_order`; the SDK derives `[b"order", hashlock_32]` with a 64-byte `create_order`. Both cannot match one deployed program. Reported, not reconciled — see Risks. |

---

## 3. Checklist results

| Check | Before | After |
|-------|--------|-------|
| Space includes the 8-byte discriminator | Pass (documented, not enforced) | Pass (derived, and validated at import) |
| Space accounts for every field | Pass (arithmetic correct) | Pass (derived from field-size table, plus an independent byte-map drift gate) |
| No magic numbers | **Fail** (F1, F9, F12, F14) | **Pass for the SDK and relayer**; the devnet harness still carries its own 65-byte layout (F15), unresolved by design |
| Rent computed from real account size | **Fail** (F2) | **Pass** — SDK, relayer, and devnet harness all query `getMinimumBalanceForRentExemption` with the derived size |
| Payer balance checked incl. rent + fees | **Fail** (F3) | **Pass** — `assertPayerCanFund` in the SDK client, the relayer preflight, and the devnet harness |
| `init_if_needed` not used / guarded | Pass (unused) | Pass (no Anchor program is present to add an on-chain regression test) |
| Client size matches on-chain size | **Fail** (F8 — untestable) | **Partial** — SDK layout/offset drift is now genuinely gated; there is still no on-chain source to compare |
| Errors never swallowed | **Fail** (F10) | **Pass** — RPC failures are hard errors (`rpc_unavailable`); duplicate PDA is `already_initialized` / `unexpected_account_balance` |
| Simulation before send | **Fail** (F4) | **Pass** — `simulateTransactionOrThrow` runs explicitly in both the SDK client and the relayer, with logs attached to the thrown error |
| Post-init verification | **Fail** (F5) | **Pass** — owner, exact size, and rent exemption re-checked after confirmation |
| Tests exist for the invariants | **Fail** (no sizing test file) | **Pass** — `test/solana-account-sizing.test.ts`, 43 cases |

---

## 4. What changed

### New: `packages/sdk/src/solana/account-sizing.ts`

The single source of truth. Exports:

- `ANCHOR_DISCRIMINATOR_SIZE = 8`
- Primitive width constants (`PUBKEY_SIZE = 32`, `U64_SIZE = 8`, …)
- `SOLANA_TYPE_SIZES` — borsh widths for every Rust type used
- `SOLANA_ANCHOR_ACCOUNT_LAYOUTS` — a declarative field table per account
  type; `HTLC_ORDER_ACCOUNT_SIZE` and `ORDER_REGISTRY_ACCOUNT_SIZE` are now
  **computed** from it
- `accountSizeFor(layout)` / `assertAccountSize(expected, actual, label)`
- `getRentExemptMinimum(connection, size)`
- `assertPayerCanFund(...)` — required vs. available lamports
- `assertAccountIsUninitialised(...)` — `AccountAlreadyInitialized`,
  `UnexpectedAccountBalance`
- `verifyInitialisedAccount(...)` — exists / owner / data length / rent-exempt
- `simulateTransactionOrThrow(...)` — surfaces simulation logs
- Errors: `SolanaAccountInitError` and the four requested subclasses
  `InvalidAccountSizeError`, `InsufficientRentError`,
  `AccountAlreadyInitializedError`, `UnexpectedAccountBalanceError`

### Changed

- `packages/sdk/src/solana/idl/htlc.ts` — `HTLC_ORDER_ACCOUNT_SIZE` now derived
  from the field table, not a literal. `ORDER_SEED` retained.
- `packages/sdk/src/solana/index.ts` — `createOrder` gains a preflight
  (payer solvency incl. rent + fee, uninitialised-PDA check) and a
  post-confirmation verification pass. `_buildSignSend` simulates first and
  surfaces logs. All new failures throw typed errors with diagnostics.
- `relayer/src/services/solana-contract.ts` and `e2e/devnet-sim.ts` are not
  changed in this branch. Their account creation, fee/rent checks, and account
  layouts remain follow-up work; the devnet script also uses a different PDA
  and instruction layout from the SDK IDL.
- `docs/DOC_MAP.md` — this file indexed.

---

## 5. Drift gate

`test/anchor-schema-stability.test.ts` recomputes the account size from the
field table **independently** of the exported constant and asserts equality.
Changing a field without changing the size (or vice versa) fails the test.
This only checks consistency among the SDK layout, exported size, and offsets;
it cannot prove that the SDK matches a deployed program because the on-chain
source is not in this repository.
