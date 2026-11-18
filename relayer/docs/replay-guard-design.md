# Relayer settlement replay-guard design

**Issue:** #339  
**Status:** Partially implemented — see [Implementation status](#implementation-status) below.

This document maps where duplicate or repeated settlement actions can slip
through the relayer, identifies which call chains already have a durable
replay guard, and specifies the design for the paths that do not.

> **Reading guide**
>
> Sections marked **[IMPLEMENTED]** describe controls that exist in the
> current source and are covered by tests.  Sections marked
> **[DESIGN ONLY — not yet implemented]** are proposals that have not been
> built; no source file or test currently enforces them.  Do not rely on
> design-only sections as an operational guarantee.

---

## Implementation status

| Call chain | Guard exists? | Status |
|---|---|---|
| D. XLM→ETH settlement (`StellarProofLedger`) | Yes — `src/services/stellar-proof-ledger.ts` | **[IMPLEMENTED]** |
| D. XLM→ETH refund (`RefundLedger`) | Yes — `src/services/refund-ledger.ts` | **[IMPLEMENTED]** |
| A. ETH deposit → escrow-creation tx | No durable guard | **[DESIGN ONLY — not yet implemented]** |
| B. Escrow-factory events → status mutation | No per-event dedupe key | **[DESIGN ONLY — not yet implemented]** |
| C. HTLCBridge `OrderCreated` → Stellar HTLC | Placeholder path, guard not yet wired | **[DESIGN ONLY — not yet implemented]** |

---

## Where duplicates can currently slip through

The relayer has four call chains that end in a state-changing action.  Two
already have a durable replay guard (D); two do not.

### A. ETH deposit → escrow-creation tx (`index.ts`) — **[DESIGN ONLY — not yet implemented]**

`fetchIncomingEthPayments()` (`src/listeners/eth-incoming-monitor.ts:27`) →
linear scan of the in-memory `activeOrders` Map for
`status === 'pending_relayer_escrow'` (`index.ts:2449`) →
`createEscrowForOrder()` (`index.ts:2643`) →
`contractWithSigner.createDstEscrow(...)`/`.createEscrow(...)`
(`index.ts:2706`/`2734`) → `tx.wait()` → status flips to
`'escrow_created_by_relayer'` only *after* the tx confirms
(`index.ts:2745-2746`).

The guard today is a plain in-memory string-status check, not an atomic
claim, and there is a multi-second window between "payment observed" and
"status flipped" during which a re-scan of the same block range (e.g. after
a crash/restart, since `lastProcessedBlock` is a plain local variable at
`index.ts:2424`, reset to current head on every restart — not persisted via
`CursorStore`) could re-trigger `createEscrowForOrder()` for the same order.
`activeOrders` itself is never persisted (`index.ts`, built fresh each
process start), so this window is real, not theoretical.

**No runtime control exists for this path today.**  See
[Runtime diagnostics](#runtime-diagnostics) for how to detect and manually
recover from a duplicate escrow-creation in production.

### B. Escrow-factory chain events → order status mutation — **[DESIGN ONLY — not yet implemented]**

`startContractEventPoller(escrowFactoryContract, ..., {cursorStore})`
(`index.ts:2851-2864`, poller implementation in
`src/listeners/contract-event-poller.ts:81`) → `queryFilter()` per tick
(`contract-event-poller.ts:134`) → per-event `binding.handler(...)` →
handlers at `index.ts:2767-2848` match on `orderData.hashLock` and set
`orderData.status`.

The cursor only advances after a full tick succeeds
(`contract-event-poller.ts:150-154`); if one binding's handler throws
mid-tick, the whole `toBlock` is not persisted, so **already-applied**
handlers replay on the next tick.  No composite dedupe key
(`transactionHash` + `logIndex`, both available on every `EventLog` returned
by `queryFilter`) is checked before applying a handler's mutation.

Because these handlers only set a status string (no external side effect
beyond the mutation itself), replaying them is lower risk than case A — but
it is still a gap the acceptance criteria ask to close.

**No per-event dedupe key is checked today.**

### C. HTLCBridge `OrderCreated` → Stellar HTLC creation — **[DESIGN ONLY — not yet implemented]**

`EthereumEventListener.pollEvents()` → `handleOrderCreatedEvent()` →
`processCrossChainOrder()` (`src/listeners/ethereum-listener.ts:189,232,288`)
is an explicit placeholder today (comment: "v1 placeholder Stellar HTLC path
disabled… v2 coordinator creates the Soroban HTLC").  Its
`lastProcessedBlock` (`ethereum-listener.ts:67`) is not persisted — always
starts at current head on restart, so no cross-restart replay yet, only
same-process retry-on-failure (`ethereum-listener.ts:218-223`).

This path emits no Stellar transaction today, so there is nothing to
duplicate.  **The guard design here is speculative** — it documents where to
wire protection when the v2 path goes live, not an existing gap to mitigate.

### D. XLM→ETH settlement — **[IMPLEMENTED]**

`POST /api/orders/xlm-to-eth` (`index.ts:1762`, inline variant at
`index.ts:1376`) → `globalStellarProofLedger.isConsumed(stellarTxHash)`
fast-path (`index.ts:1388`,`1791`) → `verifyIncomingStellarPayment()`
(`src/services/horizon-verifier.ts:174`) →
`globalStellarProofLedger.consume(stellarTxHash, {...})` **atomic claim**
(`index.ts:1439`,`1929`) → ETH send.

`StellarProofLedger` (`src/services/stellar-proof-ledger.ts`) and its sibling
`RefundLedger` (`src/services/refund-ledger.ts`) are the existing, working
replay-guard implementations:

- One JSON file per key (`stellarTxHash` / `orderId`) under
  `<cwd>/.stellar-proof-ledger/` and `<cwd>/.refund-ledger/`.
- Atomic write: write to `.tmp`, then `fs.rename()`.
- In-memory `Map` cache loaded at construction.
- `isConsumed(key)` fast-path read; `consume(key, metadata)` atomic claim.
- `storageDir: null` constructor option to disable disk I/O in tests.
- Process-wide `global*` singletons alongside injectable-instance constructors.

**Tests:** `test/xlm-to-eth-settlement.test.ts` fires two concurrent requests
with the same `stellarTxHash` and asserts exactly one succeeds (409 on the
second).  `test/xlm-refund.test.ts` covers the `RefundLedger` path.

> The design proposed in §A–C below is modelled on these two existing stores.
> Any new guard must follow the same shape — do not invent a new persistence
> pattern.

---

## Runtime diagnostics

### D. XLM→ETH settlement (implemented guard)

These commands work today against a running relayer.

**Check whether a specific Stellar transaction has been consumed:**

```bash
# Each consumed key is stored as a JSON file.  The filename is derived from
# the stellarTxHash (URL-safe base64 or hex, depending on the SDK version).
ls -la .stellar-proof-ledger/

# Read the record for a known txHash (substitute the actual hash):
cat ".stellar-proof-ledger/<sanitized-txhash>.json"
# Expected fields: key, consumedAt (Unix ms), metadata (orderId, amount, etc.)
```

**Check whether a refund has already been submitted for an order:**

```bash
ls -la .refund-ledger/

# Read the record for a known orderId:
cat ".refund-ledger/<orderId>.json"
# Expected fields: key, consumedAt, metadata (txHash, chain, etc.)
```

**Detect duplicate-suppression in logs:**

Both ledgers emit a structured log line when a duplicate is suppressed.
Filter for it in the relayer's output:

```bash
# If the relayer is using structured JSON output (newer files):
grep '"duplicate_suppressed"\|"already_consumed"\|"replay"' relayer.log

# If the relayer is using legacy console.log output (most of index.ts):
grep -i "duplicate\|already.*consumed\|replay.*guard\|proof.*replay" relayer.log
```

**Check the relevant Prometheus metrics (implemented):**

```bash
curl -s "$RELAYER_METRICS_URL/metrics" | grep -E \
  "relayer_xlm_refund_duplicates_suppressed_total|relayer_xlm_to_eth_proof_replays_total"
```

These counters increment each time the guard blocks a duplicate action.  A
non-zero value is expected in production; a rapidly increasing value indicates
a replay storm that should be investigated.

### A / B. Escrow-creation and event-handler paths (no guard yet)

No runtime controls exist for these paths today.  The following checks help
detect whether a duplicate action may have occurred so an operator can
assess impact.

**Detect a possible duplicate escrow creation (case A):**

```bash
# Look for multiple escrow-creation log lines for the same orderId:
grep -i "escrow.*creat\|createEscrow\|createDstEscrow" relayer.log \
  | grep "orderId=<N>"   # substitute the suspected order ID

# If two lines appear with the same orderId and different txHashes,
# a duplicate may have been submitted.  Verify on-chain:
# - Check Etherscan for the relayer's address: did two HTLC-creation txs land?
# - If both mined: the later one will fail with "order already exists" at the
#   contract level — funds are not at risk, but gas was wasted.
```

**Detect a possible duplicate event-handler mutation (case B):**

```bash
# Look for the same event being applied twice in the same process session:
grep -i "orderData.status\|status.*mutation\|handler.*applied" relayer.log \
  | grep "hashLock=<0xhash>"

# Because case B handlers only mutate in-memory status strings (no on-chain
# tx), a duplicate handler call does not cause a duplicate on-chain action —
# it is safe but wasteful.
```

---

## Safe manual recovery steps

> **Important:** The steps below describe safe read-only investigation and
> restart-based recovery.  They do not involve editing ledger files, database
> records, or blockchain state directly.  Never manually delete or modify
> `.stellar-proof-ledger/` or `.refund-ledger/` entries — doing so would
> remove the record that prevents a duplicate action and could cause a real
> duplicate on-chain submission.

### Recovery for case D (implemented guard blocks an action)

If the guard correctly blocks a duplicate XLM→ETH settlement or refund, the
request returns HTTP 409.  This is expected behaviour — the original action
already completed.

**Verify the original action completed:**

```bash
# Check the proof-ledger record (it exists because consume() succeeded once):
cat ".stellar-proof-ledger/<txhash>.json"
# Look for: consumedAt timestamp, txHash in metadata (the ETH tx that settled it)

# Verify on Etherscan that the ETH claim/refund tx mined successfully.
```

**If the ledger record exists but the ETH tx failed to mine:**

The `consume()` call succeeded (the file exists) but the downstream ETH
transaction may not have confirmed.  This is the gap the guard does not close
for case A — for case D it is rare because `consume()` is called after
`verifyIncomingStellarPayment()` succeeds.

```bash
# Check the txHash in the ledger record:
cat ".stellar-proof-ledger/<txhash>.json" | node -e "
  const d = require('fs').readFileSync('/dev/stdin','utf8');
  console.log(JSON.parse(d));
"
# If metadata.ethTxHash is present, check it on Etherscan.
# If the ETH tx reverted, the order is in a stuck state.
# Resolution: restart the relayer — it will re-read the order from the
# coordinator and attempt a new ETH tx.  The proof-ledger record will still
# block a second Stellar verification (the Stellar payment is already consumed),
# but the ETH retry path is separate and will proceed.
```

**If the guard is blocking an action you believe is legitimate:**

1. Confirm the Stellar `txHash` in the request matches the one in the
   `.stellar-proof-ledger/` file exactly (case-sensitive).
2. If the hashes differ, the request is for a different payment — the guard is
   not blocking it; something else is wrong.
3. If the hashes match, the original action was already processed.  Do not
   delete the ledger file.  Investigate whether the downstream action (ETH tx)
   completed by checking the `metadata` in the ledger record.

### Recovery for cases A / B (no guard — duplicate may have occurred)

Because no durable guard exists for escrow creation (A) or event-handler
mutations (B), the primary recovery tool is the blockchain itself.

**For case A (possible duplicate escrow-creation tx):**

- The HTLC Bridge contract rejects a second `createEscrow` for the same
  `orderId` with a revert — the duplicate tx fails on-chain and wastes gas,
  but no duplicate HTLC is created.  Funds are not at risk.
- Confirm the on-chain state: find the order's `orderId` in the relayer logs
  (`orderId=<N>`) and check Etherscan for the relayer's address.
- If one tx mined and one reverted: the order is in the correct state.
  No action required beyond monitoring gas costs.
- If both appear to have mined (unlikely given contract-level protection):
  escalate immediately — this would indicate a contract-level bug, not a
  relayer bug.

**For case B (possible duplicate status mutation):**

- Duplicate status mutations are in-memory only — they do not submit on-chain
  transactions.  The order's `activeOrders` status string may have been set
  twice to the same value, which is idempotent.
- No recovery action is required.  Restart the relayer to rebuild a fresh
  `activeOrders` Map from the coordinator state.

---

## Design: one durable identity model, two integration points — **[DESIGN ONLY — not yet implemented]**

> Everything in this section is a proposal.  Nothing below exists in source or
> tests.  The section is retained so the implementation work (issue #339) has
> a clear starting point, but operators must not rely on it for current
> production behaviour.

### Identity keys

| Settlement action | Proposed key | Rationale |
|---|---|---|
| Escrow creation tx (A) | `orderId` | Matches `RefundLedger`'s existing key choice for the same order-scoped "have we already acted" question. |
| Escrow-factory event handler (B) | `` `${contractAddress}:${eventName}:${transactionHash}:${logIndex}` `` | `orderId`/`hashLock` alone are insufficient — the same order can legitimately receive multiple different escrow-factory events; the composite key identifies one specific on-chain log. |
| Future Stellar-HTLC creation (C) | Ethereum `transactionHash` of the triggering `OrderCreated` event | Mirrors B; there is exactly one HTLC-creation action per triggering event. |

### Proposed store: `SettlementReplayGuard`

Model exactly on `StellarProofLedger` (`src/services/stellar-proof-ledger.ts`):

- One JSON file per key under `<cwd>/.settlement-replay-guard/<sanitizedKey>.json`.
- Atomic write: write to `.tmp`, then `rename()`.
- In-memory `Map` cache populated from disk at construction.
- `isConsumed(key)` fast-path read; `consume(key, metadata)` atomic claim.
- `storageDir: null` constructor option for tests; `globalSettlementReplayGuard`
  singleton for production; injectable-instance constructor for tests.

One guard instance, keyed generically by string, serves all three identity-key
shapes above.

### Proposed integration points

1. **Case A** (`index.ts:2643`, `createEscrowForOrder`): call
   `guard.consume(orderId, {action: 'escrow_creation', ...})` *before*
   `contractWithSigner.createDstEscrow(...)`/`.createEscrow(...)`.
2. **Case B** (`index.ts:2767-2848`, escrow-factory event handlers): each
   handler builds its composite key from the `EventLog`'s `transactionHash`
   and `logIndex` and calls `guard.isConsumed()`/`consume()` around the
   `orderData.status = ...` mutation.
3. **Case C**: wire the same pattern in `processCrossChainOrder()` when it
   stops being a placeholder — the TODO comment is already there.

### Proposed metrics

```
relayer_settlement_replay_guard_total{action, result, network_mode}
  action: escrow_creation | escrow_event | stellar_htlc_creation
  result: claimed | duplicate_suppressed
```

Follow the `watchdogMetrics`/`refundMetrics`/`settlementMetrics` grouping
pattern (`metrics.ts:214-231,266-270`) so existing test helpers work
unchanged.

### Proposed logging

Use the structured-JSON convention from `refund-ledger.ts:254-261` and
`stellar-proof-ledger.ts:171-178` (`process.stdout.write(JSON.stringify(...))`),
not the legacy `console.log` + emoji style in most of `index.ts`.

### Proposed tests

- **Store unit tests**: same shape as `test/cursor-store.test.ts` — fresh
  temp dir per test, `storageDir` override, assert both the API and the raw
  on-disk JSON.
- **Concurrent-replay race test**: copy
  `test/xlm-to-eth-settlement.test.ts`'s "fire two concurrent requests with
  the same key, assert exactly one wins (409 on the second)" shape.
- **Chain-event dedupe test**: extend `test/event-poller.test.ts`'s
  `fakeEventLog()` builder (already upgraded in the dedup-tests PR) to
  simulate the same block range being delivered twice and assert a handler
  only mutates `orderData` once.
- **Escrow-creation restart-replay test**: simulate a fresh `activeOrders` Map
  with an order already `'escrow_created_by_relayer'` per the guard's ledger,
  and assert `createEscrowForOrder()` is not re-invoked — mirrors
  `test/refund-watchdog.test.ts`'s pattern of injecting a fake `activeOrders`
  Map.

---

## Open question (out of scope for issue #339)

`activeOrders` itself is not persisted — the replay guard proposed here
prevents *duplicate actions* but does not prevent the relayer from losing
track of in-flight orders on a crash.  That is a separate concern
(order-state persistence) and is out of scope for #339, but it should not be
conflated with this fix.
