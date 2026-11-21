# Cross-Package ABI & Schema Compatibility Contract

This document defines the compatibility rules that govern how the
Soroban HTLC contract, the TypeScript SDK, and the coordinator must
stay in sync. The automated harness in
`coordinator/test/compat-harness.test.ts` enforces every rule listed
here; a failure means a boundary has drifted without the adjacent
consumer being updated.

---

## Scope

The compatibility contract covers three boundaries:

| Boundary | Producer | Consumer |
|----------|----------|----------|
| Ethereum ABI | `contracts/contracts/HTLCEscrow.sol` | `packages/sdk/src/ethereum/abi.ts` → coordinator listeners |
| Soroban event wire format | `soroban/contracts/htlc/src/lib.rs` | `coordinator/src/soroban-events.ts` |
| SDK type contract | `packages/sdk/src/types/index.ts` | coordinator persistence, HTTP routes |

---

## Rule 1 — Ethereum event signatures are pinned

The coordinator's Ethereum listener parses `OrderCreated`,
`OrderClaimed`, and `OrderRefunded` using `parseAbiItem` selectors
hardcoded in the source. The SDK's `HTLC_ESCROW_ABI` must expose
identical entries. Any rename, parameter addition, type change, or
`indexed` flag change breaks the coordinator's log filters.

**Pinned selectors (keccak256 of the canonical signature):**

| Event | Canonical signature |
|-------|---------------------|
| `OrderCreated` | `OrderCreated(uint256,address,address,address,uint256,uint256,bytes32,uint64)` |
| `OrderClaimed` | `OrderClaimed(uint256,address,bytes32,uint256,uint256)` |
| `OrderRefunded` | `OrderRefunded(uint256,address,uint256,uint256)` |

**Coordinator function selectors that must stay stable:**

| Function | Canonical signature |
|----------|---------------------|
| `createOrder` | `createOrder(address,address,address,uint256,uint256,bytes32,uint64)` |
| `claimOrder` | `claimOrder(uint256,bytes)` |
| `refundOrder` | `refundOrder(uint256)` |
| `getOrder` | `getOrder(uint256)` |

If the Solidity contract is redeployed with a changed signature, the
ABI must be updated in `packages/sdk/src/ethereum/abi.ts` **and** the
coordinator listener updated in `coordinator/src/listeners/ethereum-listener.ts`
**in the same commit**.

---

## Rule 2 — Soroban event wire format is versioned

The Soroban HTLC contract emits events under the short-symbol topics
`created`, `claimed`, and `refunded`. The coordinator decodes them in
`coordinator/src/soroban-events.ts`, which exports
`HTLC_EVENT_SCHEMA_VERSION = 1`.

**Current v1 wire format:**

```
created
  topics : (symbol "created", sender: Address, beneficiary: Address, hashlock: BytesN<32>)
  data   : (order_id: u64, asset: Address, amount: i128, safety_deposit: i128, timelock: u64)
  topics count : 4
  data count   : 5

claimed
  topics : (symbol "claimed", beneficiary: Address, hashlock: BytesN<32>)
  data   : (order_id: u64, caller: Address, preimage: Bytes, amount: i128, safety_deposit: i128)
  topics count : 3
  data count   : 5

refunded
  topics : (symbol "refunded", refund_address: Address, hashlock: BytesN<32>)
  data   : (order_id: u64, caller: Address, amount: i128, safety_deposit: i128)
  topics count : 3
  data count   : 4
```

Any change to topic count, topic order, data element count, data type,
or topic symbol name is a **breaking change**. Required procedure:

1. Bump `HTLC_EVENT_SCHEMA_VERSION` in `coordinator/src/soroban-events.ts`.
2. Add a new decode branch in `decodeHtlcEvent` for the new version.
3. Update the XDR fixtures in `coordinator/test/fixtures/soroban-xdr-fixtures.ts`.
4. Update this document.

---

## Rule 3 — SDK `OrderStatus` and coordinator statuses must match

The SDK's `OrderStatus` type (`packages/sdk/src/types/index.ts`) and
the coordinator's `OrderStatus` type
(`coordinator/src/persistence/orders-repo.ts`) must define exactly the
same string literals. The state-machine transition tables in both
packages must be identical.

**Canonical status set (v1):**
`announced`, `src_locked`, `dst_locked`, `secret_revealed`,
`completed`, `refunded`, `failed`, `expired`

**Terminal statuses** (no outgoing transitions): `completed`, `refunded`, `failed`

---

## Rule 4 — SDK `Direction` and coordinator `Direction` must match

The coordinator's `Direction` type must be a subset of the SDK's
`Direction` type.  New directions added to the SDK do not require an
immediate coordinator update, but directions removed from the SDK must
be removed from the coordinator simultaneously.

**Coordinator-supported directions (v1):**
`eth_to_xlm`, `xlm_to_eth`, `eth_to_sol`, `sol_to_eth`

---

## Rule 5 — Preimage validation algorithm is dual-hash

Both the Ethereum contract and the coordinator validate preimages using
`sha256(preimage) == hashlock OR keccak256(preimage) == hashlock`. The
Soroban contract uses only `sha256`. Any change to this dual-hash
invariant in either contract requires a coordinated update to:
- `coordinator/src/services/secret-service.ts`
- `coordinator/src/reconciliation/secret-reconciler.ts`
- `packages/sdk/src/secrets/index.ts`

---

## Rule 6 — Deployed event topics and encoded logs are pinned

`contracts/contracts/HTLCEscrow.sol` emits five events. Every one of
them is consumed (directly or indirectly) by the SDK and by the
coordinator/relayer listeners, so all five are part of the
compatibility surface:

| Event | Canonical signature | Indexed fields |
|-------|---------------------|----------------|
| `OrderCreated` | `OrderCreated(uint256,address,address,address,uint256,uint256,bytes32,uint64)` | `orderId`, `sender`, `beneficiary`, `token` |
| `OrderClaimed` | `OrderClaimed(uint256,address,bytes32,uint256,uint256)` | `orderId`, `beneficiary`, `preimageHash` |
| `OrderRefunded` | `OrderRefunded(uint256,address,uint256,uint256)` | `orderId`, `refundAddress` |
| `PayoutDeferred` | `PayoutDeferred(uint256,address,uint256,uint256)` | `orderId`, `beneficiary` |
| `Withdrawn` | `Withdrawn(address,uint256)` | `token`, `amount` |

The canonical `topic0` values (keccak256 of the canonical signature)
and a set of representative encoded logs captured from a local
deployment are checked in at:

- `coordinator/test/fixtures/event-topics.ts` — canonical signatures,
  `topic0` hashes, and indexed-field layout for each event.
- `coordinator/test/fixtures/encoded-logs.ts` — representative
  `Log` objects (topics + data) produced by a local deployment.

The focused harness `coordinator/test/compat/event-schema.test.ts`
decodes those logs with **both** the SDK decoder
(`packages/sdk/src/ethereum/events.ts`) and the coordinator/relayer
decoder (`coordinator/src/listeners/ethereum-listener.ts`) and asserts
that both produce identical order identifiers and lifecycle fields.

A change to any event name, parameter type, parameter order, or
`indexed` flag changes the canonical signature and therefore `topic0`,
and will fail the event-schema harness. This is intentional.

### Updating the event schema (procedure)

When an event legitimately changes:

1. Update the contract source and the interface
   (`contracts/contracts/interfaces/IHTLCEscrow.sol`).
2. Update `packages/sdk/src/ethereum/abi.ts` and the SDK decoder.
3. Update the coordinator/relayer listener decoder.
4. Regenerate the canonical topics and encoded logs:
   `pnpm --filter @wafflefinance/coordinator run fixtures:events`
   (runs a local deployment and rewrites
   `coordinator/test/fixtures/event-topics.ts` and
   `coordinator/test/fixtures/encoded-logs.ts`).
5. Review the fixture diff — every changed `topic0` or indexed-field
   layout must be justified in the PR description.
6. Update the tables in Rule 1 and Rule 6 of this document.
7. Run `pnpm --filter @wafflefinance/coordinator test` and confirm the
   event-schema and compat harnesses pass before merging.

---

## Adding a new event or function

1. Update the contract source (Solidity or Rust).
2. Update `packages/sdk/src/ethereum/abi.ts` (Ethereum) or the
   Soroban decoder (Stellar).
3. Update the coordinator listener and reconciler.
4. Update the pinned selectors in this document.
5. Add the new event to `coordinator/test/fixtures/event-topics.ts`
   and `coordinator/test/fixtures/encoded-logs.ts`, and extend
   `coordinator/test/compat/event-schema.test.ts` to decode it.
6. Update `coordinator/test/compat/compat-harness.test.ts` with the
   new expected values.
7. Run `pnpm --filter @wafflefinance/coordinator test` and confirm all
   compat tests pass before merging.
