# Relayer

The relayer service monitors and processes cross-chain swaps between Ethereum and Stellar.

## Logging Conventions

The relayer uses the structured Pino logger in `src/logger.ts`. Pass fields
first and a stable message second so identifiers are searchable as JSON fields.

- The centralized recovery service logs `orderId` as the order's `publicId`,
  `orderHash` as the stored hash (falling back to `publicId`), and `requestId`
  as the recovery request identifier.
- Recovery attempt records include `action`, `status`, `attempts`, and
  `nextAttemptAt`. Raw error text, reasons, and full order payloads are omitted.
- Other chain integration logs may use an on-chain escrow ID or hashlock;
  check the emitting component before joining records across services.

**Note:** `orderId` and `orderHash` represent distinct values and are not interchangeable.


## Network ABI compatibility

See the [network-to-ABI reference](NETWORK_ABI_REFERENCE.md) for factory selection,
event names, and the limits of testnet and mainnet test coverage.

See [safety-deposit pricing](SAFETY_DEPOSIT_PRICING.md) for cache windows,
the $3,500 fallback, and offline regression coverage.

