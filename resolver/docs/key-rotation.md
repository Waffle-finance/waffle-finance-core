# Resolver signing key rotation

Before this change the resolver held one signing key per chain, so replacing
a key meant stopping the service, and orders that were part-way through had
to be finished by hand. `ResolverKeyRing` (`src/key-rotation.ts`) holds the
keys for each chain and records which key owns which order, so a key can be
replaced without stopping the resolver.

## How keys are used

| Order phase | Key used |
|---|---|
| `accept` (new order) | The current **active** key. The order is bound to that key. |
| `fund`, `claim`, `refund` | The key the order is **bound** to, even if a rotation has happened since. |

The on-chain order names the resolver address that accepted it, so an order
must be finished with the same key. A rotation therefore affects new orders
only.

Key states:

- **active**: signs all new orders. Each chain has at most one active key.
- **retiring**: no longer signs new orders, but still serves the orders bound
  to it. The key is removed once the overlap window has passed **and** no
  orders are bound to it. If the window passes while orders are still bound,
  the key is kept (and a warning is logged) until those orders settle.
- **revoked**: never signs again. Orders bound to the key fail with
  `KeyRevokedError` and need manual reconciliation.

## What is exposed

Logs, metrics and health endpoints use the **key id** only. The key id is the
chain name plus the first 12 hex characters of the SHA-256 of the key's
public address (for example `ethereum:3f9a0c12be47`). Private keys and
secrets are never logged, stored in snapshots or exported as metrics. The
signer keeps the secret only inside its signing function.

- `GET /keys` on the health port lists each chain's active key id, whether a
  rotation is in progress, and for every key its status, public address,
  activation time, retire-after time, revocation reason and number of bound
  orders.
- The `resolver_signing_keys{chain,state}` metric counts keys per state.
- The `resolver_key_rotation_events_total{chain,action}` metric counts
  `rotate`, `rollback`, `retire` and `revoke` events.

## Rotating a key safely

1. Generate the replacement key on the resolver host. Do not paste it into
   chat, tickets or shared config. Register or fund the new address as the
   chain requires (for example, register it in the `ResolverRegistry` and
   stake it) before it starts taking orders.
2. Keep the current key in `RESOLVER_ETH_PRIVATE_KEY` /
   `RESOLVER_STELLAR_SECRET`. Set the replacement in
   `RESOLVER_ETH_PRIVATE_KEY_NEXT` / `RESOLVER_STELLAR_SECRET_NEXT`.
3. Set `RESOLVER_KEY_OVERLAP_MS` to at least the longest order timelock you
   serve. The default is 24 h. Restart the resolver. On startup it makes the
   NEXT key active and moves the current key to retiring.
4. Check `GET /keys`. `activeKeyId` should be the new key's id, and the old
   key should be `retiring` with its `boundOrders` count going down over time.
5. When the old key has `boundOrders: 0` and the overlap window has passed,
   promote the new key: move its value into `RESOLVER_ETH_PRIVATE_KEY` /
   `RESOLVER_STELLAR_SECRET`, unset the `_NEXT` variable, and restart.

> **Restart note.** Key bindings are held in memory. After a restart, an
> order that is seen without a binding is bound to the active key the first
> time it is used. Before restarting mid-rotation, let in-flight orders on
> the old key settle, or keep the old key configured as the primary (step 2)
> so it is still loaded.

## Rolling back

If the new key misbehaves (wrong registration, not funded, signer errors),
roll back while the old key is still retiring:

- **Programmatically:** `ring.rollback()` makes the old key active again. The
  new key becomes retiring, so orders already bound to it can still finish.
- **By configuration:** unset the `_NEXT` variable and restart. Orders bound
  to the new key cannot be served after this restart, so check `GET /keys`
  first and only do this once the new key's `boundOrders` is 0.

## Emergency revocation

If a key may be compromised:

1. Call `ring.revoke(keyId, reason)`. The key stops signing immediately.
   The call returns the ids of the orders bound to the key, and the
   revocation is logged at `error` with the number of affected orders. If the
   revoked key was the active one and no replacement is loaded, the resolver
   refuses all new work on that chain (`NoActiveKeyError`) until a
   replacement is rotated in.
2. Remove the key from the resolver's environment and secret store, and
   restart with a fresh key.
3. Reconcile the affected orders by hand. The resolver does not re-sign them
   with a different key, because the on-chain order names the revoked
   address. Refund or settle them from a safe environment.
4. Deregister or withdraw the compromised address from the
   `ResolverRegistry` as soon as the chain allows it.

## Tests

`test/key-rotation.test.ts` uses mocked signers to check key selection for
each order phase, overlap-window retirement, rollback and revocation. It also
checks, using real EVM and Stellar signers, that no key material appears in
snapshots, logs or metrics. `test/registry-eligibility.integration.test.ts`
checks that in-flight orders keep their key across a rotation when run
through the full intake pipeline.
