# ADR-002: sha256 as the primary cross-chain hashlock

| Field | Value |
|-------|-------|
| **Status** | Active |
| **Date** | 2026-10-01 |
| **Authors** | Engineering team |
| **Supersedes** | — |
| **Superseded by** | — |

---

## Context

WaffleFinance links the source-chain and destination-chain HTLCs with a single
hashlock — a 32-byte commitment such that revealing the preimage (`sha256(preimage) == hashlock`) unlocks both legs atomically.

Three chains are involved:

- **Ethereum** — EVM supports both `sha256` (via precompile at address 0x02)
  and `keccak256` (native EVM opcode).
- **Stellar (Soroban)** — the Soroban host exposes a `sha256` host function; it
  does not expose `keccak256`.
- **Solana (Anchor)** — Anchor programs use `sha256` from the standard library;
  `keccak256` requires an additional dependency.

The `HTLCEscrow` Solidity contract accepts a preimage if *either*
`sha256(preimage) == hashlock` **or** `keccak256(preimage) == hashlock` — a
dual-hash compatibility clause added so that future Ethereum-only resolvers
using keccak256 natively can still participate.

## Decision

The SDK's `generateSecret` and `hashSecret` functions always produce a
**sha256 hashlock**.  All orders announced through `POST /orders/announce` and
all coordinator order records use the sha256 commitment.  The keccak256 digest
is computed alongside sha256 by the secrets module for Ethereum-only internal
use but is never used as the canonical hashlock for a cross-chain order.

The published cross-chain hashlock test vector (`packages/sdk/test/secrets.test.ts`
— preimage `0x0102…1f20`) documents both digests and confirms that sha256 is
the interoperable choice.

## Consequences

+ A single preimage unlocks both legs on all three chains without any
  chain-specific branching in the coordinator or relayer.
+ Third-party resolver implementations that use sha256 work out of the box.
- Third-party resolvers that assume keccak256 will produce a valid claim on
  Ethereum but would fail on Stellar and Solana if a cross-chain leg ever
  used their hashlock.  This risk is mitigated by documentation (TD-032) and
  the dual-hash EVM compatibility clause.
- Developers inspecting `HTLCEscrow.sol` may be surprised by the dual-hash
  clause and incorrectly conclude that keccak256 is acceptable for cross-chain
  orders.

## Alternatives considered

**keccak256 as primary.**  Ethereum-native and no precompile call required, but
Soroban and Anchor do not expose keccak256 without additional dependencies.
Using keccak256 would make cross-chain compatibility dependent on each chain's
library ecosystem rather than on a universal standard hash function.

**Chain-specific hashlocks.**  Each chain could use its preferred hash, with
the coordinator mapping between them.  This requires the coordinator to hold
both preimage forms and to validate them separately, adding complexity and an
additional attack surface for mismatch bugs.
