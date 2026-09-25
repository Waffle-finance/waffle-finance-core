//! Formal migration framework for the WaffleFinance HTLC contract.
//!
//! # Design rationale
//!
//! Soroban persistent storage is a key/value ledger. Once a value is written
//! under a particular key it can only be replaced by an explicit write —
//! there is no automatic schema migration. This means every contract upgrade
//! that changes a persisted type layout risks:
//!
//! - **Silent mis-deserialisation**: the new code reads old bytes and
//!   interprets them as a different type (no type tag in XDR tuples).
//! - **Stuck funds**: claim/refund fail because the `Order` can no longer be
//!   decoded, trapping the locked amount.
//! - **Logic drift**: migrated vs. un-migrated orders follow different
//!   validation paths, creating split behaviour.
//!
//! This module addresses all three by:
//!
//! 1. **Schema versioning**: a `SchemaVersion` value stored in instance
//!    storage under `DataKey::SchemaVersion`. Every read of an `Order`
//!    checks the expected version before deserialising.
//! 2. **Explicit upgrade gate**: `migrate_schema` is an admin-only entry
//!    point that transforms persisted state from one version to the next and
//!    bumps the schema version atomically. It is idempotent: running it a
//!    second time with the same target version is a no-op.
//! 3. **Incompatible-version detection**: `require_schema` panics with
//!    `Error::SchemaMismatch` when a caller tries to operate on an order
//!    under a schema version the current binary does not understand, making
//!    the failure loud rather than silent.
//! 4. **Auditable events**: every schema transition emits a
//!    `("migration", "schema")` event carrying `(from_version, to_version,
//!    migrated_count)` so indexers can detect schema changes and handle them.
//! 5. **Partial-migration recovery**: if `migrate_orders` panics mid-batch
//!    the contract is left at the old version and the admin can retry from
//!    any `start_id` without re-processing already migrated orders.
//!
//! # Version history
//!
//! | Version | Description                               |
//! |---------|-------------------------------------------|
//! | 0       | Pre-versioning (no `SchemaVersion` key).  |
//! | 1       | Current layout: `Order` as defined in     |
//! |         | `lib.rs` at initial deployment.           |
//!
//! When a future breaking change is needed:
//! 1. Add a new variant to `SchemaVersion`.
//! 2. Add an `OrderVN` snapshot struct with the *old* field layout.
//! 3. Implement `From<OrderVN> for Order` (the new canonical struct).
//! 4. Extend the `migrate_orders` dispatch table with a new arm.
//! 5. Add a test in `harness.rs` that plants V(N-1) bytes and verifies
//!    post-migration correctness.

use soroban_sdk::{contracttype, panic_with_error, symbol_short, Bytes, BytesN, Env};

use crate::{DataKey, Error, Order, OrderStatus, FINALISED_ORDER_TTL_LEDGERS};

// ─────────────────────────────────────────────────────────────────────────────
// Schema version
// ─────────────────────────────────────────────────────────────────────────────

/// Monotonically increasing integer that identifies the layout of persisted
/// `Order` entries and config keys in this deployment.
///
/// `SchemaVersion` is stored under `DataKey::SchemaVersion` in instance
/// storage and is bumped atomically at the end of a successful migration run.
/// Code that reads an `Order` MUST assert `current_version == CURRENT_SCHEMA_VERSION`
/// before proceeding with business logic.
#[contracttype]
#[derive(Copy, Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[repr(u32)]
pub enum SchemaVersion {
    /// Pre-versioning baseline. No `SchemaVersion` key was written; reading
    /// this variant from storage is only possible through the compatibility
    /// shim that treats a missing key as `V0`.
    V0 = 0,
    /// Initial versioned layout. All fields present in the `Order` struct as
    /// originally shipped.
    V1 = 1,
}

/// The schema version that this binary expects on-chain. Every read-path
/// asserts equality against this constant.
pub const CURRENT_SCHEMA_VERSION: SchemaVersion = SchemaVersion::V1;

// ─────────────────────────────────────────────────────────────────────────────
// Legacy order snapshots
// ─────────────────────────────────────────────────────────────────────────────

/// Snapshot of the `Order` struct layout from schema version 0 (pre-versioning
/// baseline). This layout is identical to `Order` except it lacks the
/// `created_at` and `finalised_at` fields that were added when versioning was
/// introduced. Storing this as a separate type prevents the compiler from
/// letting us accidentally use it where the live `Order` is expected.
///
/// During migration from V0 → V1 the contract reads an `OrderV0` from storage
/// and converts it to an `Order` (V1), filling `created_at = 0` and
/// `finalised_at = 0` as the safest unknown-provenance defaults.
#[contracttype]
#[derive(Clone, Debug)]
pub struct OrderV0 {
    pub id: u64,
    pub sender: soroban_sdk::Address,
    pub beneficiary: soroban_sdk::Address,
    pub refund_address: soroban_sdk::Address,
    pub asset: soroban_sdk::Address,
    pub amount: i128,
    pub safety_deposit: i128,
    pub hashlock: BytesN<32>,
    pub timelock: u64,
    pub status: OrderStatus,
    pub preimage: Bytes,
}

impl OrderV0 {
    /// Upgrade an `OrderV0` to the current `Order` (V1). Fields that did not
    /// exist in V0 are set to sentinel values:
    ///
    /// - `created_at  = 0` — creation timestamp unknown; indexers should treat
    ///   0 as "pre-migration".
    /// - `finalised_at = 0` — if the order is already in a terminal state the
    ///   exact finalisation time is unknown; treat 0 as "pre-migration".
    pub fn into_v1(self) -> Order {
        Order {
            id: self.id,
            sender: self.sender,
            beneficiary: self.beneficiary,
            refund_address: self.refund_address,
            asset: self.asset,
            amount: self.amount,
            safety_deposit: self.safety_deposit,
            hashlock: self.hashlock,
            timelock: self.timelock,
            status: self.status,
            preimage: self.preimage,
            created_at: 0,
            finalised_at: 0,
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Version helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Read the current schema version from instance storage. Returns `V0` when
/// the key is absent (pre-versioning deployments never wrote it).
pub fn read_schema_version(env: &Env) -> SchemaVersion {
    env.storage()
        .instance()
        .get(&DataKey::SchemaVersion)
        .unwrap_or(SchemaVersion::V0)
}

/// Write `version` to instance storage as the canonical schema version.
pub fn write_schema_version(env: &Env, version: SchemaVersion) {
    env.storage()
        .instance()
        .set(&DataKey::SchemaVersion, &version);
}

/// Assert that the on-chain schema version equals `CURRENT_SCHEMA_VERSION`.
/// Panics with `Error::SchemaMismatch` if it does not. Call this at the top of
/// every state-reading entry point to prevent silent mis-deserialisation.
pub fn require_current_schema(env: &Env) {
    let on_chain = read_schema_version(env);
    if on_chain != CURRENT_SCHEMA_VERSION {
        panic_with_error!(env, Error::SchemaMismatch);
    }
}

/// Assert that the on-chain schema is *no newer* than `CURRENT_SCHEMA_VERSION`
/// and *at least* `min_version`. Used in migration entry points to detect
/// attempts to run a migration that was already applied or to skip a required
/// predecessor migration.
///
/// Panics with:
/// - `Error::SchemaMismatch` — current version is already at or above `to`
///   (migration already applied or a higher version is live; refuse downgrade).
/// - `Error::MigrationPreconditionFailed` — current version is below `from`
///   (a prerequisite migration has not been run yet).
pub fn require_migration_precondition(env: &Env, from: SchemaVersion, to: SchemaVersion) {
    let on_chain = read_schema_version(env);
    if on_chain >= to {
        // Either already migrated or a newer version is live.
        panic_with_error!(env, Error::SchemaMismatch);
    }
    if on_chain < from {
        // Prerequisite migration has not been applied.
        panic_with_error!(env, Error::MigrationPreconditionFailed);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Migration logic
// ─────────────────────────────────────────────────────────────────────────────

/// Event topic for schema migration events.
fn topic_migration() -> Symbol {
    symbol_short!("migration")
}
fn topic_schema() -> Symbol {
    symbol_short!("schema")
}

/// Entry point called by `HtlcContract::migrate_orders`. Validates
/// preconditions, runs the appropriate V(N-1)→VN migrator for the range
/// `[start_order_id, end_order_id)`, and—if `finalize` is true—atomically
/// bumps the schema version and emits the `("migration", "schema")` event.
///
/// Setting `finalize = false` lets the admin run multiple batches and only
/// commit the version bump on the final call, preventing the contract from
/// entering a half-migrated state that `require_current_schema` would block.
///
/// Returns `(migrated_count, new_version)`.
pub fn execute_migration(
    env: &Env,
    start_order_id: u64,
    end_order_id: u64,
    finalize: bool,
) -> (u32, SchemaVersion) {
    let from_version = read_schema_version(env);
    // Validate preconditions: on-chain must be exactly V0 (the only migration
    // path that exists today). The caller (`HtlcContract::migrate_orders`) has
    // already checked `current >= CURRENT_SCHEMA_VERSION` and returned
    // `AlreadyMigrated`, so by the time we reach here `from_version` is V0.
    // This call is a defence-in-depth guard for direct callers in tests.
    require_migration_precondition(env, SchemaVersion::V0, SchemaVersion::V1);

    // Build the slice of order ids to process.
    // We use a simple inclusive range. With large ranges the caller should
    // batch; Soroban's per-tx instruction budget limits how many entries can
    // be processed in a single invocation.
    let ids: soroban_sdk::Vec<u64> = {
        let mut v = soroban_sdk::Vec::new(env);
        let mut id = start_order_id;
        while id < end_order_id {
            v.push_back(id);
            id += 1;
        }
        v
    };

    // Iterate the Vec directly; no heap allocation needed in no_std.
    let mut migrated: u32 = 0;
    for id in ids.iter() {
        let key = DataKey::Order(id);
        let legacy: Option<OrderV0> = env.storage().persistent().get(&key);
        if let Some(v0) = legacy {
            let v1 = v0.into_v1();
            let remaining_ttl = env.storage().persistent().get_ttl(&key);
            let extend_to = remaining_ttl.max(FINALISED_ORDER_TTL_LEDGERS);
            env.storage().persistent().set(&key, &v1);
            env.storage()
                .persistent()
                .extend_ttl(&key, extend_to, extend_to);
            migrated += 1;
        }
    }

    let new_version = if finalize {
        write_schema_version(env, SchemaVersion::V1);
        env.events().publish(
            (topic_migration(), topic_schema()),
            (from_version as u32, SchemaVersion::V1 as u32, migrated),
        );
        SchemaVersion::V1
    } else {
        from_version
    };

    (migrated, new_version)
}

/// Stamp the contract as already at `CURRENT_SCHEMA_VERSION` without
/// performing any data transformation. Use this for **new deployments** that
/// were never in V0: the constructor calls this so the schema key is present
/// from day one and `require_current_schema` passes immediately.
pub fn stamp_initial_version(env: &Env) {
    write_schema_version(env, CURRENT_SCHEMA_VERSION);
}

// ─────────────────────────────────────────────────────────────────────────────
// Schema-aware Order read helper
// ─────────────────────────────────────────────────────────────────────────────

/// Read an `Order` from persistent storage, asserting schema compatibility
/// before returning. Panics with `Error::SchemaMismatch` when the on-chain
/// schema version does not match what this binary expects, ensuring that no
/// state-mutating call can silently operate on mis-versioned data.
///
/// Returns `None` when the entry does not exist (equivalent to
/// `OrderNotFound` at the call site).
pub fn read_order_checked(env: &Env, order_id: u64) -> Option<Order> {
    require_current_schema(env);
    env.storage()
        .persistent()
        .get(&DataKey::Order(order_id))
}

// ─────────────────────────────────────────────────────────────────────────────
// Config-key migration helpers
// ─────────────────────────────────────────────────────────────────────────────

/// Validate that all expected instance-storage config keys are present after a
/// migration. Returns a bitmask of missing keys so the caller can emit a
/// detailed diagnostic event or panic.
///
/// Bit positions:
/// - Bit 0: `Admin` missing
/// - Bit 1: `NextOrderId` missing
/// - Bit 2: `MinSafetyDeposit` missing
/// - Bit 3: `SchemaVersion` missing
///
/// A return value of `0` means all required keys are present.
pub fn check_config_keys(env: &Env) -> u32 {
    let mut missing: u32 = 0;
    if !env.storage().instance().has(&DataKey::Admin) {
        missing |= 1;
    }
    if !env.storage().instance().has(&DataKey::NextOrderId) {
        missing |= 2;
    }
    if !env.storage().instance().has(&DataKey::MinSafetyDeposit) {
        missing |= 4;
    }
    if !env.storage().instance().has(&DataKey::SchemaVersion) {
        missing |= 8;
    }
    missing
}

/// Emit a `("migration", "config_check")` event with the bitmask of missing
/// keys. If `missing == 0` the event serves as an audit trail confirming
/// post-migration integrity.
pub fn emit_config_check_event(env: &Env, missing: u32) {
    env.events().publish(
        (topic_migration(), symbol_short!("cfg_chk")),
        missing,
    );
}
