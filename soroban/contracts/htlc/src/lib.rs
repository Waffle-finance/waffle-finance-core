#![no_std]
//! WaffleFinance HTLC contract for Stellar (Soroban).
//!
//! This contract implements the Stellar side of the WaffleFinance cross-chain
//! bridge. It mirrors the semantics of the Ethereum `HTLCEscrow` contract
//! so that a swap between Ethereum and Stellar enforces the same
//! atomicity invariants on both chains:
//!
//! - A sender locks `amount` of a Stellar asset under a `hashlock`
//!   (sha256(preimage)) and a `timelock`.
//! - Before the `timelock` the `beneficiary` can claim the locked
//!   amount by revealing the preimage.
//! - After the `timelock` anyone can call `refund_order` to return the
//!   locked amount to the original `refund_address` (typically the
//!   original sender).
//!
//! The contract never holds custodial discretion: every transfer is
//! constrained by the on-ledger hashlock + timelock. No address —
//! including the coordinator or admin — can move locked funds without
//! satisfying these conditions.
//!
//! # Governance
//!
//! Configuration (admin, minimum safety deposit) is set atomically at
//! deploy time via the constructor, so adminship of a fresh deployment
//! cannot be front-run. Admin handover is two-step
//! (`transfer_admin` + `accept_admin`, with `revoke_pending_admin` as
//! an escape hatch) and every admin/config mutation emits an event
//! (`adm_xfer` / `cfg` topics) carrying the old and new values.
//!
//! # State archival (TTL) behaviour
//!
//! Soroban archives ledger entries whose TTL expires. For a
//! funds-holding contract this is a liveness hazard: an archived
//! `Order` entry makes `claim_order`/`refund_order` fail exactly when
//! funds are at stake, and an archived instance makes *every*
//! invocation fail until the instance is restored. This contract
//! manages TTLs so that neither happens in normal operation:
//!
//! - **Instance storage** (admin, order-id counter, config) is
//!   re-extended on every state-mutating entry point, so any activity
//!   keeps the contract alive for at least [`INSTANCE_TTL_EXTEND_TO`]
//!   ledgers (~30 days).
//! - **Order entries** get a TTL at creation derived from the order's
//!   own `timelock_seconds` (converted to ledgers assuming the
//!   fastest plausible ledger close time) plus a
//!   [`ORDER_TTL_MARGIN_LEDGERS`] safety margin (~14 days), so the
//!   entry outlives the claim window and the post-expiry refund
//!   window.
//! - `claim_order` / `refund_order` re-extend the entry when writing
//!   the terminal state, so claimed/refunded records stay queryable
//!   for indexers and reconciliation for ~30 days.
//! - [`HtlcContract::extend_order_ttl`] is a public, permissionless
//!   keep-alive: anyone can bump a live order's TTL if a claim window
//!   risks straddling an archival boundary (e.g. after a long period
//!   of network-wide TTL reductions).
//!
//! If an entry is archived anyway (e.g. the contract sits idle past
//! its instance TTL), no funds are lost: archived persistent and
//! instance entries can be restored with a standard
//! `RestoreFootprint` operation (paying the rent bump), after which
//! claim/refund proceed normally under the original hashlock +
//! timelock rules.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error,
    symbol_short, token, vec, Address, Bytes, BytesN, Env, IntoVal, Symbol,
};

#[cfg(test)]
mod test;

#[cfg(test)]
mod harness;

/// Maximum allowed timelock duration in seconds (24 hours).
/// Mirrors the EVM contract bound and protects users from accidentally
/// locking funds for unreasonably long periods.
const MAX_TIMELOCK_SECONDS: u64 = 86_400;

/// Minimum allowed timelock duration in seconds (5 minutes).
/// Ensures there is enough time for the user to actually claim.
const MIN_TIMELOCK_SECONDS: u64 = 300;

// ---------------------------------------------------------------------
// State-archival (TTL) parameters
//
// Soroban TTLs are denominated in ledgers, while order timelocks are
// denominated in seconds. Mainnet targets ~5 s per ledger, but close
// times can dip below that; converting with a conservative 4 s/ledger
// over-provisions the ledger count so the wall-clock coverage still
// holds if ledgers close faster than the target.
// ---------------------------------------------------------------------

/// Conservative (fastest plausible) ledger close time used to convert
/// seconds to ledgers when sizing TTLs.
const ASSUMED_MIN_LEDGER_TIME_SECS: u64 = 4;

/// Ledgers per day at [`ASSUMED_MIN_LEDGER_TIME_SECS`] (21,600).
const LEDGERS_PER_DAY: u32 = (24 * 3600 / ASSUMED_MIN_LEDGER_TIME_SECS) as u32;

/// When the instance TTL falls below this threshold (~14 days), a
/// state-mutating call re-extends it. Chosen so that any activity at
/// least fortnightly keeps the instance permanently live.
const INSTANCE_TTL_THRESHOLD: u32 = 14 * LEDGERS_PER_DAY;

/// Target instance TTL (~30 days). A quiet contract stays invocable
/// for a month after its last state-mutating call before the instance
/// (and admin/config entries) can be archived and need restoring.
const INSTANCE_TTL_EXTEND_TO: u32 = 30 * LEDGERS_PER_DAY;

/// Safety margin (~14 days) added on top of an order's timelock when
/// sizing its entry TTL. Covers the post-expiry refund window and
/// clock/close-time drift, so the entry cannot be archived while
/// either claim or refund is still actionable.
const ORDER_TTL_MARGIN_LEDGERS: u32 = 14 * LEDGERS_PER_DAY;

/// TTL (~30 days) applied to an order entry when it reaches a terminal
/// state (claimed/refunded), keeping the record queryable for indexers
/// and off-chain reconciliation.
const FINALISED_ORDER_TTL_LEDGERS: u32 = 30 * LEDGERS_PER_DAY;

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum Error {
    /// Contract has already been initialised. Retained for ABI
    /// stability; unreachable now that configuration happens in the
    /// constructor.
    AlreadyInitialised = 1,
    /// Contract has not been initialised yet.
    NotInitialised = 2,
    /// Caller is not the configured admin.
    Unauthorized = 3,
    /// Order does not exist.
    OrderNotFound = 4,
    /// Order is not in a claimable state.
    OrderNotClaimable = 5,
    /// Order is not in a refundable state.
    OrderNotRefundable = 6,
    /// The preimage does not hash to the order's hashlock.
    InvalidPreimage = 7,
    /// The order timelock has not yet expired.
    NotExpired = 8,
    /// The order timelock has already expired.
    Expired = 9,
    /// The supplied amount is zero.
    InvalidAmount = 10,
    /// The supplied timelock is outside the allowed bounds.
    InvalidTimelock = 11,
    /// The supplied safety deposit is below the configured minimum.
    SafetyDepositTooSmall = 12,
    /// Caller is not authorised as a resolver.
    ResolverNotAuthorised = 13,
    /// Internal arithmetic overflow.
    Overflow = 14,
    /// No admin transfer is pending.
    NoPendingTransfer = 15,
}

/// Lifecycle state for a single HTLC order.
#[contracttype]
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum OrderStatus {
    /// Funds are locked and the preimage has not yet been revealed.
    Funded = 0,
    /// Beneficiary revealed the preimage and received the funds.
    Claimed = 1,
    /// Timelock expired and the funds were returned to refund_address.
    Refunded = 2,
}

/// A single hash + time-locked order.
#[contracttype]
#[derive(Clone, Debug)]
pub struct Order {
    pub id: u64,
    /// Account that locked the funds (and paid the safety deposit).
    pub sender: Address,
    /// Account that can claim the funds by revealing the preimage.
    pub beneficiary: Address,
    /// Account that receives the funds back after a timeout.
    pub refund_address: Address,
    /// The asset locked. Use the native XLM asset contract here for
    /// native swaps; SAC and Soroban tokens are also supported.
    pub asset: Address,
    /// Amount of `asset` locked (in the asset's smallest unit).
    pub amount: i128,
    /// Safety deposit posted by the order creator. Goes to whoever
    /// triggers the terminal state (claim or refund) as an incentive
    /// to keep the network alive.
    pub safety_deposit: i128,
    /// sha256(preimage).
    pub hashlock: BytesN<32>,
    /// Unix-second timestamp after which `refund_order` becomes valid.
    pub timelock: u64,
    /// Current lifecycle state.
    pub status: OrderStatus,
    /// Preimage revealed by claim_order (empty until claim).
    pub preimage: Bytes,
    /// Ledger timestamp at creation time.
    pub created_at: u64,
    /// Ledger timestamp at terminal state (0 while funded).
    pub finalised_at: u64,
}

/// Storage keys. Persistent storage is bumped on every write so the
/// ledger entry stays alive for the entire lifetime of the order.
#[contracttype]
#[derive(Clone)]
enum DataKey {
    /// Admin address that can update configuration (e.g. min safety deposit).
    Admin,
    /// Address proposed by the admin to take over the role. The
    /// transfer only completes when this address calls `accept_admin`.
    PendingAdmin,
    /// Next order id counter.
    NextOrderId,
    /// Order data, keyed by id.
    Order(u64),
    /// Address of the ResolverRegistry contract. Optional; if unset, the
    /// HTLC accepts any resolver (the contract is still safe because all
    /// movements are gated by hashlock/timelock).
    ResolverRegistry,
    /// Minimum safety deposit (in stroops, i.e. 1e-7 XLM).
    MinSafetyDeposit,
}

/// Events emitted by the contract. Topics are short symbols so they fit
/// in the 4-symbol Soroban constraint.
fn topic_created() -> Symbol { symbol_short!("created") }
fn topic_claimed() -> Symbol { symbol_short!("claimed") }
fn topic_refunded() -> Symbol { symbol_short!("refunded") }
/// Admin-transfer lifecycle: paired with "proposed" / "accepted" /
/// "revoked" and (old, new) address data.
fn topic_admin_transfer() -> Symbol { symbol_short!("adm_xfer") }
/// Config mutations: paired with a per-setting symbol and (old, new)
/// value data.
fn topic_config() -> Symbol { symbol_short!("cfg") }

#[contract]
pub struct HtlcContract;

#[contractimpl]
impl HtlcContract {
    // ---------------------------------------------------------------------
    // Lifecycle
    // ---------------------------------------------------------------------

    /// Configure the contract atomically at deploy time. Running this
    /// as a constructor (instead of a separate post-deploy `initialize`
    /// transaction) closes the front-running window in which a third
    /// party could claim adminship of a freshly deployed contract.
    /// `admin` can update `min_safety_deposit` and the optional
    /// `ResolverRegistry` address. The admin can NEVER move user funds.
    pub fn __constructor(env: Env, admin: Address, min_safety_deposit: i128) {
        // The host only runs the constructor once, at deploy; this
        // guard is defense-in-depth against any re-invocation path.
        if env.storage().instance().has(&DataKey::Admin) {
            panic_with_error!(&env, Error::AlreadyInitialised);
        }
        if min_safety_deposit < 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::NextOrderId, &1u64);
        env.storage().instance().set(&DataKey::MinSafetyDeposit, &min_safety_deposit);
        Self::extend_instance_ttl(&env);
    }

    /// Set or update the resolver registry contract address. Pass
    /// `Option::None` semantics by calling `clear_resolver_registry`.
    pub fn set_resolver_registry(env: Env, registry: Address) {
        Self::require_admin(&env);
        let old: Option<Address> = env.storage().instance().get(&DataKey::ResolverRegistry);
        env.storage().instance().set(&DataKey::ResolverRegistry, &registry);
        Self::extend_instance_ttl(&env);
        env.events().publish(
            (topic_config(), symbol_short!("registry")),
            (old, Some(registry)),
        );
    }

    /// Remove the resolver registry binding (any address may create orders).
    pub fn clear_resolver_registry(env: Env) {
        Self::require_admin(&env);
        let old: Option<Address> = env.storage().instance().get(&DataKey::ResolverRegistry);
        env.storage().instance().remove(&DataKey::ResolverRegistry);
        Self::extend_instance_ttl(&env);
        env.events().publish(
            (topic_config(), symbol_short!("registry")),
            (old, None::<Address>),
        );
    }

    /// Update the minimum safety deposit.
    pub fn set_min_safety_deposit(env: Env, new_minimum: i128) {
        Self::require_admin(&env);
        if new_minimum < 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        let old: i128 = env
            .storage()
            .instance()
            .get(&DataKey::MinSafetyDeposit)
            .unwrap_or(0);
        env.storage().instance().set(&DataKey::MinSafetyDeposit, &new_minimum);
        Self::extend_instance_ttl(&env);
        env.events().publish(
            (topic_config(), symbol_short!("min_sd")),
            (old, new_minimum),
        );
    }

    /// Propose a new admin. The role only changes hands once
    /// `new_admin` calls `accept_admin`, so a typo'd address cannot
    /// permanently brick the admin functions — the current admin stays
    /// in control (and can `revoke_pending_admin`) until acceptance.
    pub fn transfer_admin(env: Env, new_admin: Address) {
        Self::require_admin(&env);
        let current = Self::admin(env.clone());
        env.storage().instance().set(&DataKey::PendingAdmin, &new_admin);
        Self::extend_instance_ttl(&env);
        env.events().publish(
            (topic_admin_transfer(), symbol_short!("proposed")),
            (current, new_admin),
        );
    }

    /// Complete a pending admin transfer. Must be authorised by the
    /// pending admin itself, proving the address is usable.
    pub fn accept_admin(env: Env) {
        let pending: Address = env
            .storage()
            .instance()
            .get(&DataKey::PendingAdmin)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NoPendingTransfer));
        pending.require_auth();
        let old = Self::admin(env.clone());
        env.storage().instance().set(&DataKey::Admin, &pending);
        env.storage().instance().remove(&DataKey::PendingAdmin);
        Self::extend_instance_ttl(&env);
        env.events().publish(
            (topic_admin_transfer(), symbol_short!("accepted")),
            (old, pending),
        );
    }

    /// Cancel a pending admin transfer (escape hatch for a mistaken
    /// `transfer_admin`). Only the current admin may revoke.
    pub fn revoke_pending_admin(env: Env) {
        Self::require_admin(&env);
        let pending: Address = env
            .storage()
            .instance()
            .get(&DataKey::PendingAdmin)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NoPendingTransfer));
        env.storage().instance().remove(&DataKey::PendingAdmin);
        Self::extend_instance_ttl(&env);
        env.events().publish(
            (topic_admin_transfer(), symbol_short!("revoked")),
            (Self::admin(env.clone()), pending),
        );
    }

    // ---------------------------------------------------------------------
    // Core HTLC operations
    // ---------------------------------------------------------------------

    /// Create and fund a new HTLC order.
    ///
    /// `sender.require_auth()` is the on-ledger authorisation that
    /// the sender owns the locked funds. The function transfers
    /// `amount` of `asset` from `sender` to this contract and records
    /// the order under `hashlock`.
    pub fn create_order(
        env: Env,
        sender: Address,
        beneficiary: Address,
        refund_address: Address,
        asset: Address,
        amount: i128,
        safety_deposit: i128,
        hashlock: BytesN<32>,
        timelock_seconds: u64,
    ) -> u64 {
        Self::require_initialised(&env);
        sender.require_auth();

        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        if safety_deposit < 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        if !(MIN_TIMELOCK_SECONDS..=MAX_TIMELOCK_SECONDS).contains(&timelock_seconds) {
            panic_with_error!(&env, Error::InvalidTimelock);
        }

        let min_sd: i128 = env
            .storage()
            .instance()
            .get(&DataKey::MinSafetyDeposit)
            .unwrap_or(0);
        if safety_deposit < min_sd {
            panic_with_error!(&env, Error::SafetyDepositTooSmall);
        }

        // If a resolver registry is configured, require the sender to be
        // an active resolver. The registry contract owns the membership
        // policy (stake, slash, activation). The HTLC remains correct
        // even without this check — funds are still gated by hashlock +
        // timelock — but enforcing it here keeps the off-chain order
        // book sybil-resistant. Claim and refund stay permissionless
        // regardless of registry state.
        if let Some(registry) = env
            .storage()
            .instance()
            .get::<DataKey, Address>(&DataKey::ResolverRegistry)
        {
            let active: bool = env.invoke_contract(
                &registry,
                &Symbol::new(&env, "is_active"),
                vec![&env, sender.into_val(&env)],
            );
            if !active {
                panic_with_error!(&env, Error::ResolverNotAuthorised);
            }
        }

        let now = env.ledger().timestamp();
        let timelock = now
            .checked_add(timelock_seconds)
            .unwrap_or_else(|| panic_with_error!(&env, Error::Overflow));

        let order_id: u64 = env
            .storage()
            .instance()
            .get(&DataKey::NextOrderId)
            .unwrap_or(1);
        env.storage()
            .instance()
            .set(&DataKey::NextOrderId, &(order_id + 1));

        // Pull the locked amount + safety deposit from sender to the
        // contract address. token::Client honours sender.require_auth().
        let token_client = token::Client::new(&env, &asset);
        let total = amount
            .checked_add(safety_deposit)
            .unwrap_or_else(|| panic_with_error!(&env, Error::Overflow));
        token_client.transfer(&sender, &env.current_contract_address(), &total);

        let order = Order {
            id: order_id,
            sender: sender.clone(),
            beneficiary: beneficiary.clone(),
            refund_address: refund_address.clone(),
            asset: asset.clone(),
            amount,
            safety_deposit,
            hashlock: hashlock.clone(),
            timelock,
            status: OrderStatus::Funded,
            preimage: Bytes::new(&env),
            created_at: now,
            finalised_at: 0,
        };

        env.storage().persistent().set(&DataKey::Order(order_id), &order);
        // Size the entry's TTL to the order's actual lifetime (timelock
        // plus margin) rather than a fixed constant, so the entry cannot
        // be archived while claim or refund is still actionable.
        let order_ttl = Self::order_ttl_ledgers(timelock_seconds);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Order(order_id), order_ttl, order_ttl);
        Self::extend_instance_ttl(&env);

        env.events().publish(
            (topic_created(), sender, beneficiary, hashlock),
            (order_id, asset, amount, safety_deposit, timelock),
        );

        order_id
    }

    /// Reveal the preimage and transfer the locked amount to
    /// `beneficiary`. The safety deposit is paid to the caller (which
    /// is typically the beneficiary, but can be any address — this
    /// incentivises permissionless secret-reveal relays).
    pub fn claim_order(env: Env, order_id: u64, preimage: Bytes, caller: Address) {
        Self::require_initialised(&env);
        caller.require_auth();

        let mut order: Order = env
            .storage()
            .persistent()
            .get(&DataKey::Order(order_id))
            .unwrap_or_else(|| panic_with_error!(&env, Error::OrderNotFound));

        if order.status != OrderStatus::Funded {
            panic_with_error!(&env, Error::OrderNotClaimable);
        }
        if env.ledger().timestamp() > order.timelock {
            panic_with_error!(&env, Error::Expired);
        }

        // Hashlock check: sha256(preimage) MUST equal the stored hash.
        let computed = env.crypto().sha256(&preimage);
        if BytesN::<32>::from(computed) != order.hashlock {
            panic_with_error!(&env, Error::InvalidPreimage);
        }

        let token_client = token::Client::new(&env, &order.asset);
        // Locked amount goes to beneficiary.
        token_client.transfer(
            &env.current_contract_address(),
            &order.beneficiary,
            &order.amount,
        );
        // Safety deposit goes to whoever submitted the claim tx.
        if order.safety_deposit > 0 {
            token_client.transfer(
                &env.current_contract_address(),
                &caller,
                &order.safety_deposit,
            );
        }

        order.status = OrderStatus::Claimed;
        order.preimage = preimage.clone();
        order.finalised_at = env.ledger().timestamp();
        env.storage().persistent().set(&DataKey::Order(order_id), &order);
        // Keep the terminal record alive for indexers/reconciliation.
        env.storage().persistent().extend_ttl(
            &DataKey::Order(order_id),
            FINALISED_ORDER_TTL_LEDGERS,
            FINALISED_ORDER_TTL_LEDGERS,
        );
        Self::extend_instance_ttl(&env);

        env.events().publish(
            (topic_claimed(), order.beneficiary.clone(), order.hashlock.clone()),
            (order_id, caller, preimage, order.amount, order.safety_deposit),
        );
    }

    /// Permissionless refund after the timelock has expired. The locked
    /// amount goes back to `refund_address`; the safety deposit is paid
    /// to the caller (incentivising anyone to clean up expired orders).
    pub fn refund_order(env: Env, order_id: u64, caller: Address) {
        Self::require_initialised(&env);
        caller.require_auth();

        let mut order: Order = env
            .storage()
            .persistent()
            .get(&DataKey::Order(order_id))
            .unwrap_or_else(|| panic_with_error!(&env, Error::OrderNotFound));

        if order.status != OrderStatus::Funded {
            panic_with_error!(&env, Error::OrderNotRefundable);
        }
        if env.ledger().timestamp() <= order.timelock {
            panic_with_error!(&env, Error::NotExpired);
        }

        let token_client = token::Client::new(&env, &order.asset);
        token_client.transfer(
            &env.current_contract_address(),
            &order.refund_address,
            &order.amount,
        );
        if order.safety_deposit > 0 {
            token_client.transfer(
                &env.current_contract_address(),
                &caller,
                &order.safety_deposit,
            );
        }

        order.status = OrderStatus::Refunded;
        order.finalised_at = env.ledger().timestamp();
        env.storage().persistent().set(&DataKey::Order(order_id), &order);
        // Keep the terminal record alive for indexers/reconciliation.
        env.storage().persistent().extend_ttl(
            &DataKey::Order(order_id),
            FINALISED_ORDER_TTL_LEDGERS,
            FINALISED_ORDER_TTL_LEDGERS,
        );
        Self::extend_instance_ttl(&env);

        env.events().publish(
            (topic_refunded(), order.refund_address.clone(), order.hashlock.clone()),
            (order_id, caller, order.amount, order.safety_deposit),
        );
    }

    /// Permissionless keep-alive for an order's ledger entry.
    ///
    /// Anyone can call this to re-extend an order entry's TTL so it
    /// cannot be archived while the order is still actionable — e.g.
    /// when a claim window straddles an archival boundary. A funded
    /// order is extended to cover its remaining timelock plus the
    /// standard margin; a finalised order is extended by the terminal
    /// retention period. Panics with [`Error::OrderNotFound`] if no
    /// live entry exists for `order_id`.
    pub fn extend_order_ttl(env: Env, order_id: u64) {
        Self::require_initialised(&env);

        let key = DataKey::Order(order_id);
        let order: Order = env
            .storage()
            .persistent()
            .get(&key)
            .unwrap_or_else(|| panic_with_error!(&env, Error::OrderNotFound));

        let extend_to = match order.status {
            OrderStatus::Funded => {
                let remaining_seconds = order
                    .timelock
                    .saturating_sub(env.ledger().timestamp());
                Self::order_ttl_ledgers(remaining_seconds)
            }
            OrderStatus::Claimed | OrderStatus::Refunded => FINALISED_ORDER_TTL_LEDGERS,
        };
        env.storage().persistent().extend_ttl(&key, extend_to, extend_to);
        Self::extend_instance_ttl(&env);
    }

    // ---------------------------------------------------------------------
    // Read-only helpers
    // ---------------------------------------------------------------------

    pub fn get_order(env: Env, order_id: u64) -> Option<Order> {
        env.storage().persistent().get(&DataKey::Order(order_id))
    }

    pub fn next_order_id(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::NextOrderId)
            .unwrap_or(1)
    }

    pub fn admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialised))
    }

    pub fn min_safety_deposit(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::MinSafetyDeposit)
            .unwrap_or(0)
    }

    pub fn resolver_registry(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::ResolverRegistry)
    }

    pub fn pending_admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::PendingAdmin)
    }

    // ---------------------------------------------------------------------
    // Internal helpers
    // ---------------------------------------------------------------------

    fn require_initialised(env: &Env) {
        if !env.storage().instance().has(&DataKey::Admin) {
            panic_with_error!(env, Error::NotInitialised);
        }
    }

    /// Re-extend the instance TTL (admin, order-id counter, config).
    /// Called from every state-mutating entry point so that ongoing
    /// activity keeps the contract alive indefinitely.
    fn extend_instance_ttl(env: &Env) {
        env.storage()
            .instance()
            .extend_ttl(INSTANCE_TTL_THRESHOLD, INSTANCE_TTL_EXTEND_TO);
    }

    /// TTL, in ledgers, that covers `timelock_seconds` of wall-clock
    /// time (converted at the conservative
    /// [`ASSUMED_MIN_LEDGER_TIME_SECS`] close time, rounded up) plus
    /// [`ORDER_TTL_MARGIN_LEDGERS`].
    fn order_ttl_ledgers(timelock_seconds: u64) -> u32 {
        // timelock_seconds is bounded by MAX_TIMELOCK_SECONDS (86,400),
        // so the conversion cannot overflow u32.
        let timelock_ledgers =
            timelock_seconds.div_ceil(ASSUMED_MIN_LEDGER_TIME_SECS) as u32;
        timelock_ledgers + ORDER_TTL_MARGIN_LEDGERS
    }

    fn require_admin(env: &Env) {
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(env, Error::NotInitialised));
        admin.require_auth();
    }
}

