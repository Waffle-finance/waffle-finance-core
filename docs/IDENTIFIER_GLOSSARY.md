# Identifier Glossary

> **Owner:** Engineering team  
> **Last updated:** 2026-10-19  
> **Purpose:** Define every order identifier used across coordinator, relayer,
> resolver, and event logs so that the three identifiers are never confused
> when correlating log lines or debugging a specific swap.

WaffleFinance tracks orders using **three distinct identifiers**. They refer to
the same swap from three different vantage points. Mixing them up is the most
common source of correlation failures when debugging across service boundaries.

---

## The three identifiers at a glance

| Identifier | Type | Owner | Where it appears |
|---|---|---|---|
| `publicId` | `string` — `wf_0x<64 hex>` | Coordinator | Coordinator API, coordinator Pino logs, SDK, frontend, relayer-announced orders |
| `orderId` (on-chain numeric) | `bigint` / `uint256` | Ethereum contract | Ethereum HTLC contract events, relayer console logs (`orderId=`) |
| `hashlock` / `orderHash` | `bytes32` hex string | All chains | On-chain HTLC parameters, coordinator log field, relayer console logs (`orderHash=`) |

These identifiers are **not** interchangeable. A single swap has all three, but
each identifier is meaningful only in the layer that owns it.

---

## publicId

The **public order ID** is a coordinator-layer concept. It is the primary
correlation key for cross-service debugging and is present in every coordinator
Pino log line, every coordinator API response, and every SDK call.

**Format:** `wf_0x` followed by 64 lowercase hexadecimal characters (the
hashlock bytes).

**How it is derived:** `publicId = "wf_" + hashlock.toLowerCase()`  
SDK helpers: `orderIdFromHashlock(hashlock)` and `hashlockFromOrderId(publicId)`.

**Fictional example:**

```
wf_0xa1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2
```

**Where to find it:**

- Coordinator Pino log field: `"publicId"`
- `GET /api/orders/<publicId>` — coordinator REST API
- SDK `SwapOrder.publicId`
- Relayer announced-order log entries (once cross-service correlation, TD-051, is complete)

**Log example (coordinator, Pino JSON):**

```json
{
  "level": 30,
  "time": 1761004800000,
  "component": "EthereumListener",
  "publicId": "wf_0xa1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
  "blockNumber": 7240100,
  "msg": "confirmed OrderCreated processed"
}
```

---

## orderId (on-chain numeric ID)

The **on-chain order ID** is an auto-incrementing `uint256` emitted by the
Ethereum HTLC Bridge contract in the `OrderCreated` event. It identifies the
order within a specific chain's contract storage.

**Type:** `bigint` in TypeScript; `uint256` in Solidity; stored as a decimal
string in the coordinator DB column `srcOrderId` / `dstOrderId`.

**Fictional example:**

```
4721
```

**Where to find it:**

- Ethereum `OrderCreated` event arg `orderId`
- Ethereum `OrderClaimed` event arg `orderId`
- Ethereum `OrderRefunded` event arg `orderId`
- Relayer console log field: `orderId=4721`
- Coordinator log field: `"orderId"` (the internal DB row ID — distinct from the
  on-chain numeric ID; context makes the usage clear)

> **Important:** The relayer's `orderId=` log field refers to the Ethereum
> HTLC contract's numeric order ID. The coordinator's `"orderId"` Pino field
> is the internal DB primary key row integer, not the on-chain ID. They are
> numerically coincidental in tests but unrelated in production. Use
> `publicId` for cross-service correlation.

**Log example (relayer, console.log — unstructured):**

```
[2026-10-19T08:30:01Z] OrderCreated orderId=4721 orderHash=0xa1b2c3d4...
```

**Log example (coordinator, Pino JSON — on-chain orderId stored as srcOrderId):**

```json
{
  "level": 30,
  "time": 1761004801000,
  "component": "OrderService",
  "publicId": "wf_0xa1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
  "srcOrderId": "4721",
  "msg": "src lock recorded"
}
```

---

## hashlock / orderHash

The **hashlock** (also called `orderHash` in the relayer's unstructured logs)
is the 32-byte SHA-256 preimage commitment that secures the HTLC across all
chains. It is the lowest-level, chain-agnostic identifier: the same 32-byte
value appears in the Ethereum contract, the Soroban contract, the Solana
program, and every off-chain service.

**Type:** `bytes32` hex string, always 66 characters: `0x` followed by 64
lowercase hex characters.

**Fictional example:**

```
0xa1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2
```

Note that the `publicId` example above is `wf_` + this exact string — the
relationship is definitional, not coincidental.

**Where to find it:**

- Ethereum `OrderCreated` event arg `hashlock`
- Soroban contract event topic (XDR-encoded `bytes32`)
- Solana program log JSON field `hashlock`
- Coordinator log field: `"hashlock"` (safe to log — the hashlock is a public
  commitment; the preimage is the secret and must not be logged)
- Relayer console log field: `orderHash=0xa1b2c3d4…`

> **Security note:** The hashlock is public. The **preimage** (the value whose
> SHA-256 hash equals the hashlock) is the secret that must never appear in
> logs, metrics, or API responses. The coordinator stores preimages encrypted
> at rest.

**Log example (coordinator, Pino JSON):**

```json
{
  "level": 30,
  "time": 1761004800500,
  "component": "SorobanListener",
  "publicId": "wf_0xa1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
  "hashlock": "0xa1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
  "ledger": 588700,
  "msg": "Soroban OrderCreated processed"
}
```

**Log example (relayer, console.log — unstructured):**

```
[2026-10-19T08:30:01Z] Stellar payment verified orderHash=0xa1b2c3d4... status=confirmed
```

---

## How the three identifiers relate

Using the fictional example above throughout:

```
hashlock  = 0xa1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2
publicId  = wf_0xa1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2
orderId   = 4721   ← contract-assigned at HTLC creation; not derivable from hashlock
```

```
publicId  = "wf_" + hashlock        (always derivable both ways via SDK helpers)
orderId   = uint256 from contract   (only available after the on-chain HTLC is created)
```

The `orderId` is chain-specific and only meaningful within a single chain's
contract. A cross-chain swap has one `publicId` but potentially two on-chain
numeric IDs (one per chain's HTLC contract), stored as `srcOrderId` and
`dstOrderId` in the coordinator DB.

---

## Identifier flow through services

```
Frontend / SDK
  │  publicId = wf_0xa1b2…          ← derived from hashlock before submit
  │  hashlock = 0xa1b2…             ← embedded in the HTLC creation tx
  ▼
Coordinator (announces order)
  │  log field: publicId            ← primary key for all coordinator logs
  │  log field: hashlock            ← present on all event-processing logs
  ▼
Ethereum HTLC contract (OrderCreated event)
  │  event arg: orderId = 4721      ← assigned by contract
  │  event arg: hashlock = 0xa1b2…  ← links back to publicId
  ▼
Coordinator Ethereum Listener
  │  log fields: publicId, srcOrderId="4721", hashlock
  ▼
Relayer (console.log — unstructured, TD-051)
     log text:  orderId=4721 orderHash=0xa1b2…
     (no publicId correlation yet — tracked in TD-051)
```

---

## Cross-service correlation recipe

When debugging a specific swap:

1. **Start with `publicId`** — look up the order in the coordinator:
   `curl "$COORDINATOR_URL/api/orders/<publicId>"`.
2. **Get the `hashlock`** from the response — use it to search all other logs:
   `grep "0xa1b2c3d4" relayer.log`.
3. **Get `srcOrderId`** from the coordinator response — use it to search
   relayer logs: `grep "orderId=4721" relayer.log`.
4. **On-chain verification** — paste `hashlock` into Etherscan / Stellar Expert /
   Solana Explorer to find the HTLC transaction directly.

---

## Source references

| Identifier | Source file |
|---|---|
| `publicId` format and SDK helpers | [`docs/ORDER_IDS.md`](./ORDER_IDS.md) |
| Coordinator log fields | [`docs/DEBUGGING_GUIDE.md`](./DEBUGGING_GUIDE.md#coordinator-pino-structured-json) |
| Relayer log conventions and known gaps | `relayer/README.md` |
| Chain-specific event keys (dedup) | `coordinator/src/reconciliation/event-identity.ts` |
