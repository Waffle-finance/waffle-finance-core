# Order ID Contract

WaffleFinance uses a canonical public order identifier anywhere an order is
created, routed, displayed, or accepted at an API boundary.

## Format

Canonical order IDs are derived from the order hashlock:

```text
wf_0x<64 lowercase hex characters>
```

Example:

```text
wf_0x0000000000000000000000000000000000000000000000000000000000000001
```

The `wf_` prefix makes the value easy to distinguish from on-chain numeric
IDs, transaction hashes, and chain-specific account addresses. The 32-byte
hashlock keeps the ID deterministic across coordinator, relayer, resolver,
frontend, and SDK code without a central allocator.

## Validation

Use the SDK shared utilities as the source of truth:

- `validateOrderId(id)` returns `null` for valid IDs or a stable error string.
- `orderIdFromHashlock(hashlock)` derives and lowercases the canonical ID.
- `hashlockFromOrderId(id)` validates an ID and returns its hashlock.

Services should reject invalid order IDs at API boundaries before performing
storage lookups or chain actions. UIs should validate before submission and
display the same format back to users.

## Chain-Specific IDs

Some chains also emit their own order IDs, such as Ethereum `uint256` IDs or
Solana PDA addresses. Keep those in chain-specific fields such as
`src.orderId`, `dst.orderId`, `ethereumOrderId`, or `solanaOrderPda`. Do not
use them as the cross-service public ID.
