#![no_std]
//! Open resolver registry for the WaffleFinance bridge.
//!
//! Resolvers stake a configurable amount of a chosen token to become
//! eligible to fill swap orders. Misbehaving resolvers can be slashed
//! by the registry admin (a contract role intended to be moved to a
//! DAO / multisig). Slashed funds go to a configurable beneficiary
//! (typically a community treasury).
//!
//! This contract intentionally does NOT make access-control decisions
//! for the HTLC itself — the HTLC is correct without the registry
//! (funds are always locked by hashlock + timelock). The registry is
//! a coordination layer: it lets the off-chain order book know which
//! resolvers have skin in the game.
//!
//! # Exit (unbonding) flow
//!
//! To prevent a misbehaving resolver from front-running a slash by
//! immediately unregistering, exits are two-phase:
//!
//! 1. **`request_unregister(resolver)`** — marks the resolver inactive
//!    immediately (`is_active` → false, so the HTLC registry gate
//!    rejects them) and records `unbond_ready_at = now + unbonding_period`.
//! 2. **`withdraw_stake(resolver)`** — only callable after
//!    `unbond_ready_at`; transfers remaining stake, removes the entry
//!    and list membership.
//!
//! The admin can update `unbonding_period` (lower-bounded at
//! `MIN_UNBONDING_PERIOD_SECS`, ≥ the 24 h max HTLC timelock).
//! Slashing remains fully effective during the unbonding window and
//! reduces the pending withdrawal amount.
//!
//! # Governance
//!
//! Configuration (admin, stake asset, minimum stake, slash
//! beneficiary, unbonding period) is set atomically at deploy time via
//! the constructor, so adminship of a fresh deployment cannot be
//! front-run. Admin handover is two-step (`transfer_admin` +
//! `accept_admin`, with `revoke_pending_admin` as an escape hatch) and
//! every admin/config mutation emits an event (`adm_xfer` / `cfg`
//! topics) carrying the old and new values.
//!
//! # Storage migration
//!
//! Existing `ResolverInfo` entries (deployed before this version) do
//! not carry `unbonding_at`. Such entries will deserialise as
//! `unbonding_at = 0` (Option<u64> = None), which is safe: both
//! `request_unregister` and `withdraw_stake` guard against the wrong
//! unbonding state. The `UnbondingPeriod` instance key is new; on a
//! first access it falls back to `DEFAULT_UNBONDING_PERIOD_SECS`.

use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, panic_with_error,
    symbol_short, token, Address, Env, Symbol, Vec,
};

#[cfg(test)]
mod test;

/// Minimum allowed unbonding period (seconds). Equal to the HTLC's
/// maximum timelock (86 400 s = 24 h), so a resolver's stake always
/// outlives any order it could have created.
pub const MIN_UNBONDING_PERIOD_SECS: u64 = 86_400;

/// Default unbonding period used when no value has been stored yet.
/// Set equal to the minimum so existing deployments behave
/// conservatively out of the box.
pub const DEFAULT_UNBONDING_PERIOD_SECS: u64 = MIN_UNBONDING_PERIOD_SECS;

#[contracterror]
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
#[repr(u32)]
pub enum Error {
    /// Retained for ABI stability; unreachable now that configuration
    /// happens in the constructor.
    AlreadyInitialised = 1,
    NotInitialised = 2,
    Unauthorized = 3,
    ResolverNotFound = 4,
    StakeBelowMinimum = 5,
    InvalidAmount = 6,
    AlreadyRegistered = 7,
    Overflow = 8,
    /// No admin transfer is pending.
    NoPendingTransfer = 9,
    /// `withdraw_stake` was called before `unbond_ready_at`.
    UnbondingNotFinished = 10,
    /// `withdraw_stake` was called without a prior `request_unregister`.
    UnbondingNotRequested = 11,
    /// `request_unregister` was called on a resolver that is already
    /// in the unbonding window.
    AlreadyUnbonding = 12,
    /// Proposed unbonding period is below the minimum (86 400 s).
    UnbondingPeriodTooShort = 13,
}

#[contracttype]
#[derive(Clone, Debug)]
pub struct ResolverInfo {
    pub address: Address,
    pub stake: i128,
    pub registered_at: u64,
    pub last_slash_at: u64,
    pub total_slashed: i128,
    pub active: bool,
    /// Unix timestamp after which `withdraw_stake` becomes valid.
    /// `None` means no unbonding is in progress (normal active state).
    pub unbonding_at: Option<u64>,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    /// Address proposed by the admin to take over the role. The
    /// transfer only completes when this address calls `accept_admin`.
    PendingAdmin,
    StakeAsset,
    MinStake,
    SlashBeneficiary,
    /// Unbonding window duration in seconds.
    UnbondingPeriod,
    Resolver(Address),
    ResolverList,
}

fn topic_registered() -> Symbol { symbol_short!("register") }
fn topic_increased() -> Symbol { symbol_short!("increase") }
/// Emitted by `request_unregister` — resolver is now inactive and
/// entering the unbonding window.
fn topic_unbond_requested() -> Symbol { symbol_short!("unbnd_req") }
/// Emitted by `withdraw_stake` — unbonding finished, stake returned.
fn topic_unbond_done() -> Symbol { symbol_short!("unbnd_ok") }
fn topic_slashed() -> Symbol { symbol_short!("slashed") }
/// Admin-transfer lifecycle: paired with "proposed" / "accepted" /
/// "revoked" and (old, new) address data.
fn topic_admin_transfer() -> Symbol { symbol_short!("adm_xfer") }
/// Config mutations: paired with a per-setting symbol and (old, new)
/// value data.
fn topic_config() -> Symbol { symbol_short!("cfg") }

#[contract]
pub struct ResolverRegistry;

#[contractimpl]
impl ResolverRegistry {
    /// Configure the contract atomically at deploy time. Running this
    /// as a constructor (instead of a separate post-deploy `initialize`
    /// transaction) closes the front-running window in which a third
    /// party could claim adminship of a freshly deployed contract.
    ///
    /// `unbonding_period` must be ≥ [`MIN_UNBONDING_PERIOD_SECS`]
    /// (86 400 s). Pass `MIN_UNBONDING_PERIOD_SECS` for the minimum.
    pub fn __constructor(
        env: Env,
        admin: Address,
        stake_asset: Address,
        min_stake: i128,
        slash_beneficiary: Address,
        unbonding_period: u64,
    ) {
        // The host only runs the constructor once, at deploy; this
        // guard is defense-in-depth against any re-invocation path.
        if env.storage().instance().has(&DataKey::Admin) {
            panic_with_error!(&env, Error::AlreadyInitialised);
        }
        if min_stake < 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        if unbonding_period < MIN_UNBONDING_PERIOD_SECS {
            panic_with_error!(&env, Error::UnbondingPeriodTooShort);
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::StakeAsset, &stake_asset);
        env.storage().instance().set(&DataKey::MinStake, &min_stake);
        env.storage().instance().set(&DataKey::SlashBeneficiary, &slash_beneficiary);
        env.storage().instance().set(&DataKey::UnbondingPeriod, &unbonding_period);
        env.storage()
            .instance()
            .set(&DataKey::ResolverList, &Vec::<Address>::new(&env));
        env.storage().instance().extend_ttl(50_000, 100_000);
    }

    /// Register `resolver` by transferring `stake` from `resolver` into
    /// the contract. The resolver must `require_auth` on the call.
    pub fn register(env: Env, resolver: Address, stake: i128) {
        Self::require_initialised(&env);
        resolver.require_auth();
        let min_stake: i128 = env.storage().instance().get(&DataKey::MinStake).unwrap_or(0);
        if stake < min_stake {
            panic_with_error!(&env, Error::StakeBelowMinimum);
        }
        if env
            .storage()
            .persistent()
            .has(&DataKey::Resolver(resolver.clone()))
        {
            panic_with_error!(&env, Error::AlreadyRegistered);
        }
        let asset: Address = env.storage().instance().get(&DataKey::StakeAsset).unwrap();
        token::Client::new(&env, &asset).transfer(
            &resolver,
            &env.current_contract_address(),
            &stake,
        );
        let info = ResolverInfo {
            address: resolver.clone(),
            stake,
            registered_at: env.ledger().timestamp(),
            last_slash_at: 0,
            total_slashed: 0,
            active: true,
            unbonding_at: None,
        };
        env.storage()
            .persistent()
            .set(&DataKey::Resolver(resolver.clone()), &info);
        env.storage()
            .persistent()
            .extend_ttl(&DataKey::Resolver(resolver.clone()), 50_000, 100_000);

        let mut list: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::ResolverList)
            .unwrap_or_else(|| Vec::new(&env));
        list.push_back(resolver.clone());
        env.storage().instance().set(&DataKey::ResolverList, &list);

        env.events()
            .publish((topic_registered(), resolver), (stake,));
    }

    /// Add more stake to an existing resolver.
    ///
    /// Note: this does NOT reactivate a deactivated resolver
    /// (including one that is unbonding). Use `register` after a
    /// completed `withdraw_stake` cycle to re-enter the system.
    pub fn increase_stake(env: Env, resolver: Address, additional: i128) {
        Self::require_initialised(&env);
        resolver.require_auth();
        if additional <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        let mut info: ResolverInfo = env
            .storage()
            .persistent()
            .get(&DataKey::Resolver(resolver.clone()))
            .unwrap_or_else(|| panic_with_error!(&env, Error::ResolverNotFound));
        let asset: Address = env.storage().instance().get(&DataKey::StakeAsset).unwrap();
        token::Client::new(&env, &asset).transfer(
            &resolver,
            &env.current_contract_address(),
            &additional,
        );
        info.stake = info
            .stake
            .checked_add(additional)
            .unwrap_or_else(|| panic_with_error!(&env, Error::Overflow));
        env.storage()
            .persistent()
            .set(&DataKey::Resolver(resolver.clone()), &info);
        env.events()
            .publish((topic_increased(), resolver), (additional,));
    }

    // ------------------------------------------------------------------
    // Two-phase exit
    // ------------------------------------------------------------------

    /// Phase 1: request exit.
    ///
    /// Marks the resolver **inactive immediately** (so `is_active`
    /// returns false and the HTLC registry gate rejects them) and
    /// records `unbond_ready_at = now + unbonding_period`.
    ///
    /// The resolver's stake remains in the contract and is fully
    /// slashable during the unbonding window.
    ///
    /// Emits `(unbnd_req, resolver) → (unbond_ready_at,)`.
    pub fn request_unregister(env: Env, resolver: Address) {
        Self::require_initialised(&env);
        resolver.require_auth();

        let mut info: ResolverInfo = env
            .storage()
            .persistent()
            .get(&DataKey::Resolver(resolver.clone()))
            .unwrap_or_else(|| panic_with_error!(&env, Error::ResolverNotFound));

        // Reject if already waiting for the unbonding window.
        if info.unbonding_at.is_some() {
            panic_with_error!(&env, Error::AlreadyUnbonding);
        }

        let period: u64 = env
            .storage()
            .instance()
            .get(&DataKey::UnbondingPeriod)
            .unwrap_or(DEFAULT_UNBONDING_PERIOD_SECS);

        let now = env.ledger().timestamp();
        let unbond_ready_at = now
            .checked_add(period)
            .unwrap_or_else(|| panic_with_error!(&env, Error::Overflow));

        // Deactivate immediately so no new HTLC orders can be routed
        // to this resolver.
        info.active = false;
        info.unbonding_at = Some(unbond_ready_at);

        env.storage()
            .persistent()
            .set(&DataKey::Resolver(resolver.clone()), &info);

        env.events()
            .publish((topic_unbond_requested(), resolver), (unbond_ready_at,));
    }

    /// Phase 2: withdraw stake after the unbonding window has elapsed.
    ///
    /// Transfers the **remaining** stake (possibly reduced by slashes
    /// during the window) back to the resolver, then removes the entry
    /// and list membership so the address can re-register cleanly.
    ///
    /// Emits `(unbnd_ok, resolver) → (returned_stake,)`.
    pub fn withdraw_stake(env: Env, resolver: Address) {
        Self::require_initialised(&env);
        resolver.require_auth();

        let info: ResolverInfo = env
            .storage()
            .persistent()
            .get(&DataKey::Resolver(resolver.clone()))
            .unwrap_or_else(|| panic_with_error!(&env, Error::ResolverNotFound));

        // Must have gone through request_unregister first.
        let unbond_ready_at = match info.unbonding_at {
            Some(t) => t,
            None => panic_with_error!(&env, Error::UnbondingNotRequested),
        };

        // Enforce the time lock.
        if env.ledger().timestamp() < unbond_ready_at {
            panic_with_error!(&env, Error::UnbondingNotFinished);
        }

        let returned = info.stake;

        // Transfer remaining stake (may be zero if fully slashed).
        if returned > 0 {
            let asset: Address = env.storage().instance().get(&DataKey::StakeAsset).unwrap();
            token::Client::new(&env, &asset).transfer(
                &env.current_contract_address(),
                &resolver,
                &returned,
            );
        }

        // Remove persistent entry.
        env.storage()
            .persistent()
            .remove(&DataKey::Resolver(resolver.clone()));

        // Remove from the list.
        let list: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::ResolverList)
            .unwrap_or_else(|| Vec::new(&env));
        let mut new_list = Vec::new(&env);
        for addr in list.iter() {
            if addr != resolver {
                new_list.push_back(addr);
            }
        }
        env.storage().instance().set(&DataKey::ResolverList, &new_list);

        env.events()
            .publish((topic_unbond_done(), resolver), (returned,));
    }

    /// Slash a misbehaving resolver. `amount` is taken from their stake
    /// and transferred to the configured `slash_beneficiary`.
    ///
    /// Slash is fully effective during the unbonding window: it reduces
    /// the amount the resolver will receive on `withdraw_stake`.
    pub fn slash(env: Env, resolver: Address, amount: i128) {
        Self::require_admin(&env);
        if amount <= 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        let mut info: ResolverInfo = env
            .storage()
            .persistent()
            .get(&DataKey::Resolver(resolver.clone()))
            .unwrap_or_else(|| panic_with_error!(&env, Error::ResolverNotFound));
        let take = amount.min(info.stake);
        let asset: Address = env.storage().instance().get(&DataKey::StakeAsset).unwrap();
        let beneficiary: Address = env
            .storage()
            .instance()
            .get(&DataKey::SlashBeneficiary)
            .unwrap();
        token::Client::new(&env, &asset).transfer(
            &env.current_contract_address(),
            &beneficiary,
            &take,
        );
        info.stake -= take;
        info.total_slashed = info
            .total_slashed
            .checked_add(take)
            .unwrap_or_else(|| panic_with_error!(&env, Error::Overflow));
        info.last_slash_at = env.ledger().timestamp();
        // Only deactivate by slash if not already inactive / unbonding.
        // (An unbonding resolver is already inactive; we must not
        //  accidentally flip active back to true here.)
        let min_stake: i128 = env.storage().instance().get(&DataKey::MinStake).unwrap_or(0);
        if info.active && info.stake < min_stake {
            info.active = false;
        }
        env.storage()
            .persistent()
            .set(&DataKey::Resolver(resolver.clone()), &info);
        env.events()
            .publish((topic_slashed(), resolver), (take,));
    }

    pub fn is_active(env: Env, resolver: Address) -> bool {
        env.storage()
            .persistent()
            .get::<DataKey, ResolverInfo>(&DataKey::Resolver(resolver))
            .map(|info| info.active)
            .unwrap_or(false)
    }

    pub fn get(env: Env, resolver: Address) -> Option<ResolverInfo> {
        env.storage()
            .persistent()
            .get(&DataKey::Resolver(resolver))
    }

    pub fn list(env: Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&DataKey::ResolverList)
            .unwrap_or_else(|| Vec::new(&env))
    }

    pub fn min_stake(env: Env) -> i128 {
        env.storage().instance().get(&DataKey::MinStake).unwrap_or(0)
    }

    pub fn set_min_stake(env: Env, new_minimum: i128) {
        Self::require_admin(&env);
        if new_minimum < 0 {
            panic_with_error!(&env, Error::InvalidAmount);
        }
        let old: i128 = env.storage().instance().get(&DataKey::MinStake).unwrap_or(0);
        env.storage().instance().set(&DataKey::MinStake, &new_minimum);
        env.events().publish(
            (topic_config(), symbol_short!("min_stake")),
            (old, new_minimum),
        );
    }

    pub fn set_slash_beneficiary(env: Env, new_beneficiary: Address) {
        Self::require_admin(&env);
        let old: Address = env
            .storage()
            .instance()
            .get(&DataKey::SlashBeneficiary)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialised));
        env.storage()
            .instance()
            .set(&DataKey::SlashBeneficiary, &new_beneficiary);
        env.events().publish(
            (topic_config(), symbol_short!("slash_ben")),
            (old, new_beneficiary),
        );
    }

    /// Update the unbonding period. Must be ≥ [`MIN_UNBONDING_PERIOD_SECS`]
    /// (86 400 s). Takes effect for all future `request_unregister`
    /// calls; in-flight unbonding entries are not affected.
    pub fn set_unbonding_period(env: Env, new_period: u64) {
        Self::require_admin(&env);
        if new_period < MIN_UNBONDING_PERIOD_SECS {
            panic_with_error!(&env, Error::UnbondingPeriodTooShort);
        }
        let old: u64 = env
            .storage()
            .instance()
            .get(&DataKey::UnbondingPeriod)
            .unwrap_or(DEFAULT_UNBONDING_PERIOD_SECS);
        env.storage().instance().set(&DataKey::UnbondingPeriod, &new_period);
        env.events().publish(
            (topic_config(), symbol_short!("unbnd_per")),
            (old, new_period),
        );
    }

    pub fn unbonding_period(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::UnbondingPeriod)
            .unwrap_or(DEFAULT_UNBONDING_PERIOD_SECS)
    }

    /// Propose a new admin. The role only changes hands once
    /// `new_admin` calls `accept_admin`, so a typo'd address cannot
    /// permanently brick `slash` and the config setters — the current
    /// admin stays in control (and can `revoke_pending_admin`) until
    /// acceptance.
    pub fn transfer_admin(env: Env, new_admin: Address) {
        Self::require_admin(&env);
        let current = Self::admin(env.clone());
        env.storage().instance().set(&DataKey::PendingAdmin, &new_admin);
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
        env.events().publish(
            (topic_admin_transfer(), symbol_short!("revoked")),
            (Self::admin(env.clone()), pending),
        );
    }

    pub fn admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .unwrap_or_else(|| panic_with_error!(&env, Error::NotInitialised))
    }

    pub fn pending_admin(env: Env) -> Option<Address> {
        env.storage().instance().get(&DataKey::PendingAdmin)
    }

    fn require_initialised(env: &Env) {
        if !env.storage().instance().has(&DataKey::Admin) {
            panic_with_error!(env, Error::NotInitialised);
        }
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
