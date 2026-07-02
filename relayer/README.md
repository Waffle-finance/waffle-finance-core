# Relayer

The relayer service monitors and processes cross-chain swaps between Ethereum and Stellar.

## Public API

The supported compatibility endpoints, response variants, errors, operational
limits, examples, and consumed chain events are defined in the
[coordinator and relayer public API contract](../docs/API_CONTRACT.md#relayer-api).

## Logging Conventions

The relayer includes structured identifiers in its logs for easier tracking and correlation:

- `orderId=` refers to the **on-chain order ID** (e.g. the bigint from the HTLC Bridge contract events).
- `orderHash=` refers to the **hashlock** (or 1inch Fusion hash).

**Note:** `orderId` and `orderHash` represent distinct values and are not interchangeable.

### Known Gaps (Follow-ups)

1. **Full Correlation:** Full cross-service correlation with the coordinator's `publicId` is not currently implemented in these logs.
2. **Winston Migration:** A migration from `console.log`/`console.error` to structured JSON logging via Winston is planned but not yet implemented.
