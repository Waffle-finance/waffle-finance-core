# Coordinator database loss recovery

The coordinator database is a **rebuildable cache**. If it is deleted or
corrupted, the coordinator can reconstruct every *chain fact* from a bounded
event replay, but it cannot reconstruct all *off-chain order metadata* or
cached unrevealed secrets.

## What can and cannot be restored

| Data | Restored by | Guarantee |
| --- | --- | --- |
| Order hashlock, amounts, addresses, `srcOrderId`, status | Bounded chain replay via `OrdersRepository` | Yes — public chain facts |
| Chain cursors | Replay up to the recorded chain tip | Yes |
| Unrevealed secrets | `SecretReconciler` from the configured secret recovery source | Only when the source record is authorized and `sha256`/`keccak256(preimage) === hashlock` |
| Customer references, settlement notes, other operator metadata | Manual reconstruction from operator records | **No** — never on chain |

## Operator procedure

1. Stop the coordinator and preserve the damaged database file for forensics.
2. Start with a fresh database; migrations create the schema automatically.
3. Replay a bounded window from the earliest affected chain event and set the
   chain cursor to the replayed tip. Never replay an unbounded window.
4. Run secret recovery. The reconciler rejects invalid or unauthorized
   records, records each outcome, and never logs preimages.
5. Read the emitted `[recovery-summary]` JSON (also produced by
   `test/database-recovery-e2e.test.ts`). It lists restored chain facts,
   secret recovery outcomes, and `missingOffChainMetadata`.
6. For every order in `missingOffChainMetadata`, manually reconstruct the
   listed fields from the operator's own records before resuming normal
   settlement; mark the order `manualReconstructionRequired` in the incident
   ticket. Do not guess values from chain data.
7. Verify that no unauthorized/invalid secret was persisted and that preimage
   strings never appear in logs before re-enabling automated settlement.

Run the end-to-end check with:

```bash
pnpm --filter @wafflefinance/coordinator exec vitest run test/database-recovery-e2e.test.ts
```
