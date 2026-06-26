-- Migration: 005_schema_migrations
-- Creates the migration history table used for schema version auditing.
--
-- Each applied migration is recorded with its file name, the unix timestamp
-- when it was applied, and how long it took in milliseconds.  Operators can
-- query this table to confirm which migrations are present and when they ran.
--
-- This migration is intentionally idempotent: the coordinator bootstraps the
-- table before the migration loop, so CREATE TABLE IF NOT EXISTS is always a
-- no-op by the time this file is executed.  The file exists so that the table
-- itself appears in the migration history alongside every other migration.

CREATE TABLE IF NOT EXISTS schema_migrations (
    migration   TEXT    PRIMARY KEY,
    applied_at  BIGINT  NOT NULL,
    duration_ms BIGINT  NOT NULL
);
