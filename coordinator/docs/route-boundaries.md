# Coordinator route and startup boundaries

All order export routes require `Authorization: Bearer <operator-key>`, using
`COORDINATOR_OPERATOR_KEYS`. Absent or malformed credentials return 401; an
unknown key returns 403. Valid operator credentials permit single, bulk, JSON,
and CSV exports. Rate-limit API keys alone do not grant export access.
Preimages are excluded from order fields and audit payloads. Export service
failures return a generic 500 body.

`GET /api/orders/history` uses a default limit of 50 and clamps integer requests
to 1–200, including zero and negative requests. Malformed integer values return
400. Clamping does not change cursor ordering or continuation semantics.

Listeners are started once per instance, including while startup is pending.
Repeated coordinator wake/start calls are harmless. Ethereum catch-up failure
falls back to live subscriptions; Soroban bootstrap failure falls back to polling
from the chain tip. Polling RPC failures use the existing loop retry policy.
Stopped listener instances are terminal; create new instances for a new lifecycle.

The PostgreSQL rollback smoke test is opt-in with `POSTGRES_TEST_URL`. Its user
must have permission to create and drop databases. The test creates a random
temporary database, exercises the production migration transaction helper,
checks that failed DDL and registry writes are absent, verifies retry, and drops
only the database it created. The configured database is used only to create and
drop that temporary database.
