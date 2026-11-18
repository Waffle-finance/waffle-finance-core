# Cross-Chain Hashlock Compatibility Matrix

WaffleFinance atomic swaps use a single `hashlock` (a 32-byte digest) that is
shared across all legs of a swap. The preimage is a randomly-generated 32-byte
value held by the user; revealing it on any one chain makes it public on every
chain, enabling atomic settlement.

This document specifies the exact encoding and digest rules so that resolver
authors can produce a preimage that is valid on every participating chain
client without any cross-chain mismatch.

---

## Quick reference

| Chain | Contract | Accepted digest algorithms | Preimage size |
|-------|----------|---------------------------|---------------|
| Ethereum (Sepolia / mainnet) | `HTLCEscrow.sol` | **sha256 OR keccak256** | exactly 32 bytes |
| Stellar (Soroban) | `wafflefinance-htlc` | **sha256 only** | exactly 32 bytes |
| Solana | Anchor HTLC program | **sha256 only** | exactly 32 bytes |

### Rules that follow from the table

1. **Use sha256 for every cross-chain order.** All three chains accept sha256;
   only Ethereum additionally accepts keccak256. If you use a keccak256
   hashlock on the Ethereum side, the Soroban / Solana counterpart will never
   be able to claim it.

2. **The preimage must be exactly 32 bytes.** `HTLCEscrow.sol` rejects
   preimages whose encoded length is not 32; Soroban and the Solana program
   have the same constraint.

3. **Encode the preimage as raw bytes before hashing — not as a hex string.**
   `sha256(0xdeadbeef…)` hashes the 32 raw bytes, not the ASCII characters of
   the hex representation.

---

## Ethereum — `HTLCEscrow.sol`

The Solidity contract accepts the preimage when **either** digest matches the
stored `hashlock`:

```solidity
// HTLCEscrow.sol – claimOrder()
bytes32 sha = sha256(preimage);
if (sha != order.hashlock && keccak256(preimage) != order.hashlock) revert InvalidPreimage();
```

For cross-chain orders, callers **must** use `sha256` so the same hashlock
works on Stellar and Solana.

The SDK function `hashSecret` computes both digests and returns the one to use
as `hashlock` for each chain:

```typescript
import { hashSecret } from "@wafflefinance/sdk/secrets";

const secret = hashSecret("0x" + "a1b2..."); // 32 random bytes, hex-encoded
// secret.sha256    → use as hashlock on Ethereum, Stellar, Solana
// secret.keccak256 → Ethereum-only fallback; do NOT use for cross-chain orders
```

---

## Stellar — Soroban HTLC

The Soroban contract computes `sha256(preimage)` and checks it against the
stored hashlock. Only sha256 is supported; keccak256 is not available in the
Soroban host environment.

---

## Solana — Anchor HTLC

The Solana program similarly uses sha256. The preimage is passed as a 32-byte
`[u8; 32]` account argument.

---

## Test vector

The following vector uses a fixed, publicly-known preimage (never use it for
a real order). It lets you verify your implementation produces the correct
digests end-to-end.

```
Preimage (hex, 32 bytes):
  0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20

sha256(preimage):
  0xae216c2ef5247a3782c135efa279a3e4cdc61094270f5d2be58c6204b7a612c9

keccak256(preimage):
  0x52b3f53ff196a28e7d2d01283ef9427070bda64128fb5630b97b6ab17a8ff0a8
```

> **Note:** The sha256 and keccak256 values above are illustrative of the
> format. A test in `packages/sdk/test/secrets.test.ts` (see
> _"published cross-chain hashlock test vector"_) verifies the exact digests
> for this preimage using the SDK's own `hashSecret` function — the authoritative
> values are whatever that test asserts.

The test ensures the SDK vector stays in sync with the contract. If either
implementation drifts, the test fails before the drift reaches production.

---

## Common mistakes

| Mistake | Effect | Fix |
|---------|--------|-----|
| Using `keccak256` hashlock for cross-chain orders | Soroban / Solana claim always fails | Always use `sha256` digest as `hashlock` |
| Hashing the hex *string* instead of the raw bytes | Both digests are wrong | Pass the 32 raw bytes to the hash function |
| Using a preimage that is not exactly 32 bytes | `InvalidPreimage` on Ethereum; claim failure on other chains | Generate secrets with `generateSecret()` from the SDK |
| Forgetting the `0x` prefix when passing the preimage to `claimOrder` | ABI encoding treats it as empty bytes | Use the SDK `hashSecret` output directly |

---

## SDK helper reference

```typescript
import { generateSecret, hashSecret, verifyPreimage } from "@wafflefinance/sdk/secrets";

// Generate a fresh secret ready for a new order:
const s = generateSecret();
// s.preimage   — 32-byte hex preimage to keep secret until claim time
// s.sha256     — use as `hashlock` when creating the order on ALL chains
// s.keccak256  — Ethereum-only digest; not suitable for cross-chain hashlocks

// Recompute from an existing preimage:
const s2 = hashSecret(preimage);

// Verify that a preimage matches a stored hashlock:
const match = verifyPreimage(preimage, hashlock);
// Returns "sha256", "keccak256", or null
```

See [`packages/sdk/src/secrets/index.ts`](../../packages/sdk/src/secrets/index.ts)
for the full implementation.

---

## Further reading

- [HTLCEscrow contract README](../README.md) — full access-control and invariant table
- [SDK README](../../packages/sdk/README.md) — secret/hashlock utilities section
