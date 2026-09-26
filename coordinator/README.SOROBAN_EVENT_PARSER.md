# Soroban Event Parser Changes

This document summarizes the Soroban event parser work that was added to the coordinator.
It explains what changed, why the changes were made, and where the relevant code now lives.

## Background

The coordinator consumes Soroban HTLC contract events from two different paths:
- live event polling in `SorobanListener`
- periodic replay and reconciliation in `Reconciler`

Before this change, the event handling path relied on ad hoc assumptions about raw topic arrays and XDR-decoded values.
That meant the listener and the reconciler could interpret the same raw event differently if their decoding paths diverged.

## What changed

A shared, canonical Soroban event parser was introduced in `coordinator/src/soroban-events.ts`.
This parser is the single source of truth for decoding Soroban HTLC event topics and values.
It normalizes raw RPC data into a typed event model and makes malformed payload handling explicit.

The live listener and the reconciler now both call this shared parser.
This guarantees both ingestion and replay interpret the same event meaning consistently.

## Goals

- Move raw topic/value decoding into a dedicated parser contract.
- Avoid duplicated Soroban event decoding logic.
- Make required event fields explicit, including field presence and type expectations.
- Replace silent failures and accidental skips with explicit error values.
- Connect parser errors to metrics and logging.
- Add test coverage for normal events and malformed shapes.

## Design principles

- The parser is typed.
- It returns one of three results:
  - a typed normalized event
  - a structured `MalformedEventError`
  - `null` for unknown or irrelevant topics
- `null` is used only for governance or non-HTLC contract event topics.
- `MalformedEventError` is used for events that the parser recognizes but cannot safely interpret.
- The parser never throws; callers can handle the result deterministically.

## Parser contract

The parser lives in `coordinator/src/soroban-events.ts`.
Its public interface is:
- `decodeHtlcEvent(topicScVals, dataScVal)`
- `isMalformedEvent(result)`
- `HTLC_EVENT_SCHEMA_VERSION`

The parser understands three event kinds:
- `created`
- `claimed`
- `refunded`

Each event kind is normalized into a strict typed shape.
The normalized event shapes are:
- `CreatedEvent`
- `ClaimedEvent`
- `RefundedEvent`

These shapes carry the following fields:
- `schemaVersion`
- `kind`
- `orderId`
- `hashlock`
- `sender` / `beneficiary` / `refundAddress`
- `timelock` for created events
- `preimage` for claimed events
- `amount` and `safetyDeposit` as decimal strings for created events

## Error handling

Malformed parser results are returned as `MalformedEventError`.
This object includes:
- `isMalformed: true`
- `kind` — the event topic symbol or `xdr_decode_error`
- `reason` — machine-readable error tag
- `detail` — human-readable description

Supported `MalformedReason` values are:
- `xdr_decode_error`
- `topic_count_mismatch`
- `topic_type_mismatch`
- `data_not_array`
- `data_count_mismatch`
- `data_type_mismatch`

The parser now distinguishes between raw governance topic skips and actual malformed HTLC events.
This is important for operator visibility and safe event processing.

## Live listener integration

`coordinator/src/listeners/soroban-listener.ts` now delegates all Soroban event decoding to `decodeHtlcEvent`.
The listener treats malformed events as operational failures:
- it increments `sorobanDecodeErrors`
- it logs the event details at warning level
- it skips the event without mutating order state

Unknown topics still skip silently.
That means admin or config events no longer leak into order lifecycle processing.

## Reconciliation integration

`coordinator/src/reconciliation/reconciler.ts` also calls `decodeHtlcEvent` for Soroban replay events.
That means the reconciling path is now guaranteed to use the same event interpretation as live ingestion.

When the parser returns a malformed event, reconciliation:
- logs the failure
- skips applying any state transition
- does not count it as a successful replay

This avoids accidental state divergence from malformed raw data.

## Added tests

`coordinator/test/soroban-events.test.ts` now covers:
- successful decoding of `created`, `claimed`, and `refunded` events
- hashlock and preimage normalization into `0x` hex strings
- `schemaVersion` presence on all decoded events
- `null` results for unknown topics and empty topic arrays
- malformed payloads with explicit `MalformedEventError` for:
  - non-array data values
  - corrupt XDR payloads
  - missing topics
  - wrong topic types
  - missing data elements
  - wrong data types

New regression coverage was added for stricter `claimed` and `refunded` validation.
That ensures these event kinds require all of their declared data fields before they are accepted.

## Metric wiring

A new coordinator metrics counter is used for parser failures:
- `coordinator_soroban_decode_errors_total`

This counter is incremented in the listener when the parser returns a `MalformedEventError`.
The label `reason` is populated from the parser-provided error tag.

With this metric, operators can distinguish:
- XDR decode failures
- malformed HTLC events
- topic mismatches
- data shape mismatches

## Why this matters

Soroban event payloads are not guaranteed to remain stable across contract versions or node behaviors.
A dedicated parser contract guards the coordinator against bad data and contract ABI drift.

When decoding is shared and typed, the coordinator is safer in two ways:
- live processing and replay use the same event semantics
- malformed input is visible and testable rather than silently ignored

## Soroban vs EVM runtime differences — what the parser assumes

The parser is designed for Soroban's runtime model, which differs from
the Ethereum listener's model in ways that affect how events are sourced
and how the coordinator processes them:

**Finality**: Soroban uses BFT consensus (SCP).  Ledgers are final the
moment they close.  There are no chain reorgs and no block-confirmation
window.  The parser never needs to handle "tentative" events the way the
Ethereum parser must guard against short-lived reorgs and block-hash
mismatches.  If an event arrives "out of order" (ledger sequence goes
backwards), it is always a node-level inconsistency, not a chain reorg.

**Event sourcing**: Soroban events are fetched via cursor-based
`getEvents` pagination rather than block-range `getLogs`.  The cursor is
an opaque string that expires after the RPC node's event history window
(~48 h).  A cursor reset triggers a bounded replay in the listener, which
is why the parser is designed to be idempotent: replaying the same event
through `decideDispatch` is safe because the DB state guards against
double-application.

**No probabilistic confirmation**: because ledgers are BFT-final, the
coordinator treats a parsed event as authoritative as soon as it is
decoded without error.  There is no equivalent of Ethereum's
`confirmationDepth` setting in the Soroban path.

## Known behavior after this change

- Governance or admin Soroban topics are ignored cleanly.
- Valid HTLC events are normalized into stable coordinator event objects.
- Malformed HTLC payloads are logged and metered.
- Order state is never mutated from malformed Soroban events.
- The parser is explicit about required fields and type expectations.
- Out-of-order events (BFT-finality note: these are always node-level,
  never chain-level) are counted via
  `coordinator_soroban_out_of_order_events_total`.

## File locations

- `coordinator/src/soroban-events.ts`
  - shared Soroban HTLC event decoder
  - typed event shapes and normalized output
  - explicit parser contract and error modes

- `coordinator/src/listeners/soroban-listener.ts`
  - live Soroban RPC polling path
  - delegates decoding to the shared parser
  - logs and meters malformed events

- `coordinator/src/reconciliation/reconciler.ts`
  - Soroban reconciliation replay path
  - reuses the same shared parser
  - treats malformed events as replay skips

- `coordinator/test/soroban-events.test.ts`
  - parser unit tests
  - coverage for happy paths and malformed payloads

## What did not change

- The chain-specific order transition model remains unchanged.
- Event handling for Ethereum and Solana remains in their respective listeners.
- The coordinator still uses the same `OrderService` and persistence layers.
- This change does not alter the existing Soroban contract event formats.

## Extension guidance

If a future Soroban contract version adds new HTLC event kinds:
1. Add the new event kind to `decodeHtlcEvent`.
2. Add a typed event shape for the new event.
3. Add explicit field validation and error reasons.
4. Add unit tests for both happy-path and malformed payloads.
5. Ensure the live listener and reconciler both continue to delegate to the shared parser.

If the contract wire format changes in a backward-incompatible way:
1. bump `HTLC_EVENT_SCHEMA_VERSION`
2. preserve a compatibility path inside `decodeHtlcEvent`
3. keep existing parser behavior for older format versions if necessary
4. add targeted tests for both version branches

## Debugging malformed Soroban events

When a Soroban event is logged as malformed, inspect:
- `kind` — the event symbol that was recognized
- `reason` — the parser error tag
- `detail` — the field-level description
- `ledger` and `txHash` — event location

If `reason` is `xdr_decode_error`, the raw XDR value failed to decode.
If `reason` is `topic_count_mismatch`, the event topic array was too short.
If `reason` is `topic_type_mismatch`, a topic was not the expected string or bytes type.
If `reason` is `data_not_array`, the event value did not decode to an array.
If `reason` is `data_count_mismatch`, the event value array had too few elements.
If `reason` is `data_type_mismatch`, a specific data field did not match the expected type.

## Recommended operator checks

When `coordinator_soroban_decode_errors_total` increases:
- verify the Soroban RPC endpoint is healthy
- confirm the HTLC contract address is correct
- inspect whether the contract ABI or event layout changed
- check if node history truncation or corrupted RPC data is occurring

A small number of parse failures may be acceptable during rolling node upgrades.
A sustained rate of failures indicates an operational or contract compatibility problem.

## Testing the change

The parser was validated using existing XDR fixtures in `coordinator/test/fixtures/soroban-xdr-fixtures.ts`.
These fixtures represent the raw binary event payloads returned by a Soroban node.

The parser tests cover:
- real XDR-based `created` / `claimed` / `refunded` event shapes
- malformed topic arrays and corrupted values
- the exact same `scVal` shapes that the live listener processes

## Impact on coordinator lifecycle

This change improves event consistency across the coordinator lifecycle:
- live polling receives the same event semantics as the replay path
- reconciliation is no longer a second decoding implementation
- state transitions are guarded by the same parser contract

That reduces the risk of divergent order state due to inconsistent event interpretation.

## Future work

Possible future improvements include:
- exposing parser failure metrics via a Grafana dashboard
- adding a health signal for Soroban event schema mismatches
- unifying Soroban parser behavior with resolver-side decoding
- migrating the parser into a shared package if multiple services need it

## Summary

This work turns Soroban event decoding from an implicit, brittle path into an explicit, typed parser contract.
The parser is now the canonical decoder for both live ingestion and reconciliation.
Malformed Soroban events are now explicit operational failures, not silent skips.
The change improves coordinator safety, observability, and consistency.
