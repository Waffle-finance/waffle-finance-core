-- Migration: 010_soroban_checkpoints
-- Adds a durable checkpoint record for the Soroban event listener so the
-- coordinator can safely resume ingestion after a restart, redeploy, or
-- temporary RPC inconsistency without reprocessing from scratch or skipping
-- a missed ledger range.
--
-- Prior to this table the Soroban listener held its cursor and ledger
-- progress only in memory (see coordinator/src/listeners/soroban-listener.ts)
-- and reset both on certain RPC anomalies.  That is enough for a single
-- long-lived process but provides no recovery across restarts: on boot the
-- listener started just behind the chain tip and any events that occurred
-- while it was offline were only picked up by the periodic reconciler.
--
-- Columns:
--   contract_id       the Soroban HTLC contract the checkpoint belongs to.
--                     Keyed per-contract so pointing the coordinator at a new
--                     contract starts from a clean checkpoint automatically.
--   last_safe_ledger  the highest ledger sequence the listener has fully
--                     processed and is safe to resume from.  Advances forward
--                     only; a stale-cursor reset never rewinds it.
--   effective_cursor  the opaque Soroban RPC pagination cursor last returned
--                     by getEvents(), or NULL when the listener must re-derive
--                     a start ledger (fresh start or post-reset).
--   recovery_marker   ingestion health flag used to drive replay on the next
--                     poll/restart:
--                       'clean'          steady state; resume from cursor.
--                       'pending_replay' a gap / stale cursor / restart was
--                                        observed; a bounded replay is owed
--                                        before returning to the live stream.
--                       'recovering'     a bounded replay is in progress; if
--                                        the process dies mid-replay the next
--                                        start re-runs it (crash-safe).
--   updated_at        unix timestamp (seconds) of the last checkpoint write.
CREATE TABLE IF NOT EXISTS soroban_checkpoints (
    contract_id      TEXT    PRIMARY KEY,
    last_safe_ledger INTEGER NOT NULL DEFAULT 0,
    effective_cursor TEXT,
    recovery_marker  TEXT    NOT NULL DEFAULT 'clean'
                     CHECK (recovery_marker IN ('clean', 'pending_replay', 'recovering')),
    updated_at       INTEGER NOT NULL DEFAULT 0
);
