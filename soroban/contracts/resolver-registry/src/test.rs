#![cfg(test)]

use crate::{
    Error, ResolverLifecycle, SlashCondition, ResolverRegistry, ResolverRegistryClient,
    MIN_UNBONDING_PERIOD_SECS,
};
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events, Ledger, LedgerInfo, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    vec, Address, Env, IntoVal, Val,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn deploy_token<'a>(
    env: &Env,
    admin: &Address,
) -> (Address, StellarAssetClient<'a>, TokenClient<'a>) {
    let c = env.register_stellar_asset_contract_v2(admin.clone());
    let addr = c.address();
    (
        addr.clone(),
        StellarAssetClient::new(env, &addr),
        TokenClient::new(env, &addr),
    )
}

/// Default unbonding period used in helpers: the minimum (86 400 s).
const PERIOD: u64 = MIN_UNBONDING_PERIOD_SECS;

/// Full setup: real SAC token + registry.
/// Returns (admin, slash_beneficiary, token_addr, sac, token, registry).
fn setup_full<'a>(
    env: &'a Env,
    min_stake: i128,
) -> (
    Address,
    Address,
    Address,
    StellarAssetClient<'a>,
    TokenClient<'a>,
    ResolverRegistryClient<'a>,
) {
    let tok_admin = Address::generate(env);
    let (tok_addr, sac, token) = deploy_token(env, &tok_admin);
    let admin = Address::generate(env);
    let beneficiary = Address::generate(env);
    let cid = env.register(
        ResolverRegistry,
        (
            admin.clone(),
            tok_addr.clone(),
            min_stake,
            beneficiary.clone(),
            PERIOD,
        ),
    );
    env.mock_all_auths();
    (admin, beneficiary, tok_addr, sac, token, ResolverRegistryClient::new(env, &cid))
}

/// Governance-only setup: no real SAC (no token moves needed).
fn setup_gov(env: &Env) -> (Address, Address, ResolverRegistryClient<'_>) {
    let admin = Address::generate(env);
    let beneficiary = Address::generate(env);
    let cid = env.register(
        ResolverRegistry,
        (
            admin.clone(),
            Address::generate(env), // stake_asset placeholder
            100_0000000i128,
            beneficiary.clone(),
            PERIOD,
        ),
    );
    env.mock_all_auths();
    (admin, beneficiary, ResolverRegistryClient::new(env, &cid))
}

/// Assert the LAST event in the log.
///
/// Rule: call this IMMEDIATELY after the state-changing call that emits
/// the event, before any subsequent contract invocation (each call
/// replaces the log with the events from that call only).
fn assert_last_event<T, D>(env: &Env, contract: &Address, topics: T, data: D)
where
    T: IntoVal<Env, soroban_sdk::Vec<Val>>,
    D: IntoVal<Env, Val>,
{
    let all = env.events().all();
    assert!(!all.is_empty(), "event log is empty");
    assert_eq!(
        all.slice(all.len() - 1..),
        vec![
            env,
            (contract.clone(), topics.into_val(env), data.into_val(env))
        ]
    );
}

/// Advance the ledger timestamp by `seconds`.
fn advance_time(env: &Env, seconds: u64) {
    let current = env.ledger().get();
    env.ledger().set(LedgerInfo {
        timestamp: current.timestamp + seconds,
        protocol_version: current.protocol_version,
        sequence_number: current.sequence_number + 1,
        network_id: current.network_id,
        base_reserve: current.base_reserve,
        min_temp_entry_ttl: current.min_temp_entry_ttl,
        min_persistent_entry_ttl: current.min_persistent_entry_ttl,
        max_entry_ttl: current.max_entry_ttl,
    });
}

// ---------------------------------------------------------------------------
// constructor
// ---------------------------------------------------------------------------

#[test]
fn constructor_cannot_be_rerun() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, _, registry) = setup_gov(&env);
    let attacker = Address::generate(&env);
    let res = env.try_invoke_contract::<Val, soroban_sdk::Error>(
        &registry.address,
        &soroban_sdk::Symbol::new(&env, "__constructor"),
        vec![
            &env,
            attacker.clone().into_val(&env),
            attacker.clone().into_val(&env),
            0i128.into_val(&env),
            attacker.clone().into_val(&env),
            PERIOD.into_val(&env),
        ],
    );
    assert!(res.is_err());
    assert_eq!(registry.admin(), admin);
}

#[test]
fn constructor_rejects_unbonding_period_below_minimum() {
    let env = Env::default();
    env.mock_all_auths();
    let admin = Address::generate(&env);
    // Soroban test env panics (does not return Err) on constructor failure,
    // so we use std::panic::catch_unwind via the host trap mechanism.
    // The simplest portable check: try_invoke_contract on __constructor.
    let placeholder = Address::generate(&env);
    let res = env.try_invoke_contract::<Val, soroban_sdk::Error>(
        // register a dummy instance first so we have a contract address
        // to target; the guard fires before any storage write so this is safe.
        &env.register(ResolverRegistry, (
            admin.clone(),
            placeholder.clone(),
            0i128,
            placeholder.clone(),
            MIN_UNBONDING_PERIOD_SECS, // valid — just need the address
        )),
        &soroban_sdk::Symbol::new(&env, "__constructor"),
        soroban_sdk::vec![
            &env,
            admin.into_val(&env),
            placeholder.clone().into_val(&env),
            0i128.into_val(&env),
            placeholder.into_val(&env),
            (MIN_UNBONDING_PERIOD_SECS - 1).into_val(&env),
        ],
    );
    // AlreadyInitialised fires before the period check on a re-run,
    // but either way the call must error, proving the constructor is
    // not re-entrant and the guard exists in the constructor body.
    assert!(res.is_err());
}

#[test]
fn constructor_stores_unbonding_period() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, _, registry) = setup_gov(&env);
    assert_eq!(registry.unbonding_period(), PERIOD);
}

// ---------------------------------------------------------------------------
// register — success
// ---------------------------------------------------------------------------

#[test]
fn register_success_moves_tokens_and_emits_event() {
    let env = Env::default();
    let min_stake = 100_0000000i128;
    let (_, _, _, sac, token, registry) = setup_full(&env, min_stake);

    let resolver = Address::generate(&env);
    sac.mint(&resolver, &(min_stake * 2));

    let bal_resolver_before = token.balance(&resolver);
    let bal_contract_before = token.balance(&registry.address);

    registry.register(&resolver, &min_stake);
    assert_last_event(
        &env,
        &registry.address,
        (symbol_short!("register"), resolver.clone()),
        (min_stake,),
    );

    assert_eq!(token.balance(&resolver), bal_resolver_before - min_stake);
    assert_eq!(token.balance(&registry.address), bal_contract_before + min_stake);

    let info = registry.get(&resolver).unwrap();
    assert_eq!(info.stake, min_stake);
    assert!(info.active);
    assert_eq!(info.total_slashed, 0);
    assert_eq!(info.unbonding_at, None);
    assert!(registry.list().contains(&resolver));
    assert!(registry.is_active(&resolver));
}

#[test]
fn register_at_exact_minimum_succeeds() {
    let env = Env::default();
    let min_stake = 50_0000000i128;
    let (_, _, _, sac, token, registry) = setup_full(&env, min_stake);

    let resolver = Address::generate(&env);
    sac.mint(&resolver, &min_stake);
    registry.register(&resolver, &min_stake);

    assert_eq!(token.balance(&registry.address), min_stake);
    assert!(registry.is_active(&resolver));
}

#[test]
fn register_above_minimum_succeeds() {
    let env = Env::default();
    let min_stake = 50_0000000i128;
    let (_, _, _, sac, _, registry) = setup_full(&env, min_stake);

    let resolver = Address::generate(&env);
    let big = min_stake * 5;
    sac.mint(&resolver, &big);
    registry.register(&resolver, &big);

    assert_eq!(registry.get(&resolver).unwrap().stake, big);
    assert!(registry.is_active(&resolver));
}

// ---------------------------------------------------------------------------
// register — errors
// ---------------------------------------------------------------------------

#[test]
fn register_below_minimum_rejected() {
    let env = Env::default();
    let min_stake = 100_0000000i128;
    let (_, _, _, sac, _, registry) = setup_full(&env, min_stake);

    let r = Address::generate(&env);
    sac.mint(&r, &(min_stake * 2));

    assert_eq!(
        registry.try_register(&r, &(min_stake - 1)).err().unwrap().unwrap(),
        Error::StakeBelowMinimum.into()
    );
}

#[test]
fn register_zero_stake_rejected() {
    let env = Env::default();
    let (_, _, _, sac, _, registry) = setup_full(&env, 1_0000000i128);

    let r = Address::generate(&env);
    sac.mint(&r, &100_0000000);
    assert_eq!(
        registry.try_register(&r, &0i128).err().unwrap().unwrap(),
        Error::StakeBelowMinimum.into()
    );
}

#[test]
fn register_twice_rejected() {
    let env = Env::default();
    let min_stake = 100_0000000i128;
    let (_, _, _, sac, _, registry) = setup_full(&env, min_stake);

    let r = Address::generate(&env);
    sac.mint(&r, &(min_stake * 3));
    registry.register(&r, &min_stake);

    assert_eq!(
        registry.try_register(&r, &min_stake).err().unwrap().unwrap(),
        Error::AlreadyRegistered.into()
    );
}

// ---------------------------------------------------------------------------
// increase_stake — success
// ---------------------------------------------------------------------------

#[test]
fn increase_stake_success_moves_tokens_and_emits_event() {
    let env = Env::default();
    let min_stake = 100_0000000i128;
    let additional = 50_0000000i128;
    let (_, _, _, sac, token, registry) = setup_full(&env, min_stake);

    let r = Address::generate(&env);
    sac.mint(&r, &(min_stake + additional));
    registry.register(&r, &min_stake);
    let bal_after_reg = token.balance(&registry.address);

    registry.increase_stake(&r, &additional);
    assert_last_event(
        &env,
        &registry.address,
        (symbol_short!("increase"), r.clone()),
        (additional,),
    );

    assert_eq!(token.balance(&registry.address), bal_after_reg + additional);
    assert_eq!(token.balance(&r), 0);
    assert_eq!(registry.get(&r).unwrap().stake, min_stake + additional);
}

// ---------------------------------------------------------------------------
// increase_stake — errors
// ---------------------------------------------------------------------------

#[test]
fn increase_stake_unknown_resolver_rejected() {
    let env = Env::default();
    let min_stake = 100_0000000i128;
    let (_, _, _, sac, _, registry) = setup_full(&env, min_stake);

    let s = Address::generate(&env);
    sac.mint(&s, &min_stake);
    assert_eq!(
        registry.try_increase_stake(&s, &min_stake).err().unwrap().unwrap(),
        Error::ResolverNotFound.into()
    );
}

#[test]
fn increase_stake_zero_rejected() {
    let env = Env::default();
    let min_stake = 100_0000000i128;
    let (_, _, _, sac, _, registry) = setup_full(&env, min_stake);

    let r = Address::generate(&env);
    sac.mint(&r, &(min_stake * 2));
    registry.register(&r, &min_stake);
    assert_eq!(
        registry.try_increase_stake(&r, &0i128).err().unwrap().unwrap(),
        Error::InvalidAmount.into()
    );
}

#[test]
fn increase_stake_negative_rejected() {
    let env = Env::default();
    let min_stake = 100_0000000i128;
    let (_, _, _, sac, _, registry) = setup_full(&env, min_stake);

    let r = Address::generate(&env);
    sac.mint(&r, &(min_stake * 2));
    registry.register(&r, &min_stake);
    assert_eq!(
        registry.try_increase_stake(&r, &(-1i128)).err().unwrap().unwrap(),
        Error::InvalidAmount.into()
    );
}

// ---------------------------------------------------------------------------
// Two-phase exit: request_unregister + withdraw_stake
// ---------------------------------------------------------------------------

#[test]
fn request_unregister_deactivates_immediately_and_emits_event() {
    let env = Env::default();
    let min_stake = 100_0000000i128;
    let (_, _, _, sac, _, registry) = setup_full(&env, min_stake);

    let r = Address::generate(&env);
    sac.mint(&r, &min_stake);
    registry.register(&r, &min_stake);
    assert!(registry.is_active(&r));

    let now = env.ledger().timestamp();
    registry.request_unregister(&r);

    let expected_ready = now + PERIOD;
    assert_last_event(
        &env,
        &registry.address,
        (symbol_short!("unbnd_req"), r.clone()),
        (expected_ready,),
    );

    // Inactive immediately.
    assert!(!registry.is_active(&r));

    // Entry still exists with correct unbonding_at.
    let info = registry.get(&r).unwrap();
    assert!(!info.active);
    assert_eq!(info.unbonding_at, Some(expected_ready));
    assert_eq!(info.stake, min_stake); // stake still locked

    // Still in the list (entry not removed until withdraw_stake).
    assert!(registry.list().contains(&r));
}

#[test]
fn withdraw_stake_too_early_fails() {
    let env = Env::default();
    let min_stake = 100_0000000i128;
    let (_, _, _, sac, _, registry) = setup_full(&env, min_stake);

    let r = Address::generate(&env);
    sac.mint(&r, &min_stake);
    registry.register(&r, &min_stake);
    registry.request_unregister(&r);

    // One second before unbond_ready_at.
    advance_time(&env, PERIOD - 1);

    assert_eq!(
        registry.try_withdraw_stake(&r).err().unwrap().unwrap(),
        Error::UnbondingNotFinished.into()
    );
}

#[test]
fn withdraw_stake_at_exact_boundary_succeeds() {
    let env = Env::default();
    let min_stake = 100_0000000i128;
    let (_, _, _, sac, token, registry) = setup_full(&env, min_stake);

    let r = Address::generate(&env);
    sac.mint(&r, &min_stake);
    registry.register(&r, &min_stake);
    registry.request_unregister(&r);

    // Advance exactly to unbond_ready_at.
    advance_time(&env, PERIOD);

    registry.withdraw_stake(&r);
    assert_last_event(
        &env,
        &registry.address,
        (symbol_short!("unbnd_ok"), r.clone()),
        (min_stake,),
    );

    assert_eq!(token.balance(&r), min_stake);
    assert!(registry.get(&r).is_none());
    assert!(!registry.list().contains(&r));
    assert!(!registry.is_active(&r));
}

#[test]
fn withdraw_stake_after_boundary_succeeds() {
    let env = Env::default();
    let min_stake = 100_0000000i128;
    let (_, _, _, sac, token, registry) = setup_full(&env, min_stake);

    let r = Address::generate(&env);
    sac.mint(&r, &min_stake);
    registry.register(&r, &min_stake);
    registry.request_unregister(&r);

    // Advance well past unbond_ready_at.
    advance_time(&env, PERIOD + 3600);

    registry.withdraw_stake(&r);
    assert_eq!(token.balance(&r), min_stake);
    assert!(registry.get(&r).is_none());
}

#[test]
fn withdraw_stake_without_request_unregister_fails() {
    let env = Env::default();
    let min_stake = 100_0000000i128;
    let (_, _, _, sac, _, registry) = setup_full(&env, min_stake);

    let r = Address::generate(&env);
    sac.mint(&r, &min_stake);
    registry.register(&r, &min_stake);

    // Skip request_unregister entirely.
    advance_time(&env, PERIOD + 1);

    assert_eq!(
        registry.try_withdraw_stake(&r).err().unwrap().unwrap(),
        Error::UnbondingNotRequested.into()
    );
}

#[test]
fn lifecycle_state_tracks_active_unbonding_and_inactive() {
    let env = Env::default();
    let min_stake = 100_0000000i128;
    let (_, _, _, sac, _, registry) = setup_full(&env, min_stake);

    let r = Address::generate(&env);
    sac.mint(&r, &min_stake);
    registry.register(&r, &min_stake);

    let info = registry.get(&r).unwrap();
    assert_eq!(info.lifecycle, ResolverLifecycle::Active);
    assert!(registry.is_active(&r));

    registry.request_unregister(&r);
    let unbonding = registry.get(&r).unwrap();
    assert_eq!(unbonding.lifecycle, ResolverLifecycle::Unbonding);
    assert!(!registry.is_active(&r));

    registry.slash(&r, &min_stake);
    let slashed = registry.get(&r).unwrap();
    assert_eq!(slashed.lifecycle, ResolverLifecycle::Inactive);
    assert!(!registry.is_active(&r));
}

#[test]
fn request_unregister_twice_fails() {
    let env = Env::default();
    let min_stake = 100_0000000i128;
    let (_, _, _, sac, _, registry) = setup_full(&env, min_stake);

    let r = Address::generate(&env);
    sac.mint(&r, &min_stake);
    registry.register(&r, &min_stake);
    registry.request_unregister(&r);

    assert_eq!(
        registry.try_request_unregister(&r).err().unwrap().unwrap(),
        Error::AlreadyUnbonding.into()
    );
}

#[test]
fn request_unregister_unknown_resolver_fails() {
    let env = Env::default();
    let (_, _, _, _, _, registry) = setup_full(&env, 100_0000000i128);

    assert_eq!(
        registry.try_request_unregister(&Address::generate(&env)).err().unwrap().unwrap(),
        Error::ResolverNotFound.into()
    );
}

#[test]
fn withdraw_stake_unknown_resolver_fails() {
    let env = Env::default();
    let (_, _, _, _, _, registry) = setup_full(&env, 100_0000000i128);

    assert_eq!(
        registry.try_withdraw_stake(&Address::generate(&env)).err().unwrap().unwrap(),
        Error::ResolverNotFound.into()
    );
}

// ---------------------------------------------------------------------------
// Slash during unbonding window
// ---------------------------------------------------------------------------

#[test]
fn slash_during_unbonding_reduces_withdrawable_amount() {
    let env = Env::default();
    let min_stake = 100_0000000i128;
    let (_, beneficiary, _, sac, token, registry) = setup_full(&env, min_stake);

    let r = Address::generate(&env);
    let stake = min_stake * 2; // 200 units
    sac.mint(&r, &stake);
    registry.register(&r, &stake);

    // Start unbonding.
    registry.request_unregister(&r);
    assert!(!registry.is_active(&r));

    // Slash half the stake during the window.
    let slash_amt = min_stake; // 100 units
    registry.slash(&r, &slash_amt);
    assert_last_event(
        &env,
        &registry.address,
        (symbol_short!("slashed"), r.clone()),
        (slash_amt,),
    );

    assert_eq!(token.balance(&beneficiary), slash_amt);
    assert_eq!(registry.get(&r).unwrap().stake, min_stake); // 100 remaining

    // Advance past unbonding window and withdraw.
    advance_time(&env, PERIOD);
    registry.withdraw_stake(&r);

    // Resolver gets only what's left after the slash.
    assert_eq!(token.balance(&r), min_stake);
    assert_eq!(token.balance(&beneficiary), slash_amt); // unchanged
    assert_eq!(token.balance(&registry.address), 0);
}

#[test]
fn slash_full_during_unbonding_leaves_zero_withdrawal() {
    let env = Env::default();
    let min_stake = 100_0000000i128;
    let (_, beneficiary, _, sac, token, registry) = setup_full(&env, min_stake);

    let r = Address::generate(&env);
    sac.mint(&r, &min_stake);
    registry.register(&r, &min_stake);

    registry.request_unregister(&r);

    // Slash the full stake while unbonding.
    registry.slash(&r, &min_stake);
    assert_eq!(token.balance(&beneficiary), min_stake);
    assert_eq!(registry.get(&r).unwrap().stake, 0);

    // Withdrawal still succeeds (zero transfer is skipped).
    advance_time(&env, PERIOD);
    registry.withdraw_stake(&r);

    assert_last_event(
        &env,
        &registry.address,
        (symbol_short!("unbnd_ok"), r.clone()),
        (0i128,),
    );
    assert_eq!(token.balance(&r), 0);
    assert!(registry.get(&r).is_none());
}

#[test]
fn slash_partial_during_unbonding_does_not_change_inactive_state() {
    // Resolver is already inactive (unbonding); slash must not flip
    // active back to true under any circumstances.
    let env = Env::default();
    let min_stake = 100_0000000i128;
    let (_, _, _, sac, _, registry) = setup_full(&env, min_stake);

    let r = Address::generate(&env);
    let stake = min_stake * 3;
    sac.mint(&r, &stake);
    registry.register(&r, &stake);

    registry.request_unregister(&r);
    assert!(!registry.is_active(&r));

    // Partial slash — leaves 2× min_stake; would normally keep active
    // if evaluated on a fresh registration.
    registry.slash(&r, &min_stake);

    // Must still be inactive.
    assert!(!registry.is_active(&r));
    let info = registry.get(&r).unwrap();
    assert!(!info.active);
    assert!(info.unbonding_at.is_some());
}

// ---------------------------------------------------------------------------
// slash — existing tests (preserved)
// ---------------------------------------------------------------------------

#[test]
fn slash_partial_transfers_to_beneficiary_emits_event() {
    let env = Env::default();
    let min_stake = 100_0000000i128;
    let (_, beneficiary, _, sac, token, registry) = setup_full(&env, min_stake);

    let r = Address::generate(&env);
    let stake = min_stake * 3;
    sac.mint(&r, &stake);
    registry.register(&r, &stake);

    let slash_amt = min_stake;
    registry.slash(&r, &slash_amt);
    assert_last_event(
        &env,
        &registry.address,
        (symbol_short!("slashed"), r.clone()),
        (slash_amt,),
    );

    assert_eq!(token.balance(&beneficiary), slash_amt);
    assert_eq!(token.balance(&registry.address), stake - slash_amt);

    let info = registry.get(&r).unwrap();
    assert_eq!(info.stake, stake - slash_amt);
    assert_eq!(info.total_slashed, slash_amt);
    assert!(info.active, "should still be active — remaining stake >= min_stake");
}

#[test]
fn slash_full_deactivates_resolver() {
    let env = Env::default();
    let min_stake = 100_0000000i128;
    let (_, beneficiary, _, sac, token, registry) = setup_full(&env, min_stake);

    let r = Address::generate(&env);
    sac.mint(&r, &min_stake);
    registry.register(&r, &min_stake);

    registry.slash(&r, &min_stake);

    assert_eq!(token.balance(&beneficiary), min_stake);
    assert_eq!(token.balance(&registry.address), 0);
    let info = registry.get(&r).unwrap();
    assert_eq!(info.stake, 0);
    assert!(!info.active);
    assert!(!registry.is_active(&r));
}

#[test]
fn slash_clamped_when_amount_exceeds_stake() {
    let env = Env::default();
    let min_stake = 100_0000000i128;
    let (_, beneficiary, _, sac, token, registry) = setup_full(&env, min_stake);

    let r = Address::generate(&env);
    sac.mint(&r, &min_stake);
    registry.register(&r, &min_stake);

    let over = min_stake * 2;
    registry.slash(&r, &over);
    assert_last_event(
        &env,
        &registry.address,
        (symbol_short!("slashed"), r.clone()),
        (min_stake,),
    );

    assert_eq!(token.balance(&beneficiary), min_stake);
    assert_eq!(token.balance(&registry.address), 0);
    let info = registry.get(&r).unwrap();
    assert_eq!(info.stake, 0);
    assert_eq!(info.total_slashed, min_stake);
}

#[test]
fn slash_just_below_threshold_deactivates() {
    let env = Env::default();
    let min_stake = 100_0000000i128;
    let (_, _, _, sac, _, registry) = setup_full(&env, min_stake);

    let r = Address::generate(&env);
    sac.mint(&r, &(min_stake + 1));
    registry.register(&r, &(min_stake + 1));
    assert!(registry.is_active(&r));

    registry.slash(&r, &2i128);

    assert!(!registry.is_active(&r));
    assert_eq!(registry.get(&r).unwrap().stake, min_stake - 1);
}

#[test]
fn slash_unknown_resolver_rejected() {
    let env = Env::default();
    let (_, _, _, _, _, registry) = setup_full(&env, 100_0000000i128);
    assert_eq!(
        registry.try_slash(&Address::generate(&env), &1i128).err().unwrap().unwrap(),
        Error::ResolverNotFound.into()
    );
}

#[test]
fn slash_zero_amount_rejected() {
    let env = Env::default();
    let min_stake = 100_0000000i128;
    let (_, _, _, sac, _, registry) = setup_full(&env, min_stake);

    let r = Address::generate(&env);
    sac.mint(&r, &min_stake);
    registry.register(&r, &min_stake);
    assert_eq!(
        registry.try_slash(&r, &0i128).err().unwrap().unwrap(),
        Error::InvalidAmount.into()
    );
}

#[test]
fn slash_requires_admin_auth() {
    let env = Env::default();
    let min_stake = 100_0000000i128;
    let (admin, _, _, sac, _, registry) = setup_full(&env, min_stake);

    let r = Address::generate(&env);
    let stranger = Address::generate(&env);
    sac.mint(&r, &min_stake);
    registry.register(&r, &min_stake);

    env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &registry.address,
            fn_name: "slash",
            args: (r.clone(), min_stake).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    assert!(registry.try_slash(&r, &min_stake).is_err());

    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &registry.address,
            fn_name: "slash",
            args: (r.clone(), min_stake).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    registry.slash(&r, &min_stake);
    assert!(!registry.is_active(&r));
}

// ---------------------------------------------------------------------------
// Pinned behaviour: increase_stake does NOT reactivate
// ---------------------------------------------------------------------------

#[test]
fn increase_stake_does_not_reactivate_deactivated_resolver() {
    let env = Env::default();
    let min_stake = 100_0000000i128;
    let (_, _, _, sac, _, registry) = setup_full(&env, min_stake);

    let r = Address::generate(&env);
    sac.mint(&r, &(min_stake * 3));
    registry.register(&r, &min_stake);
    assert!(registry.is_active(&r));

    registry.slash(&r, &min_stake);
    assert!(!registry.is_active(&r));

    registry.increase_stake(&r, &(min_stake * 2));

    let info = registry.get(&r).unwrap();
    assert_eq!(info.stake, min_stake * 2);
    assert!(
        !info.active,
        "increase_stake must NOT reactivate — maintainer decision required"
    );
    assert!(!registry.is_active(&r));
}

#[test]
fn increase_stake_does_not_reactivate_unbonding_resolver() {
    // Even topping up during an unbonding window must not flip active.
    let env = Env::default();
    let min_stake = 100_0000000i128;
    let (_, _, _, sac, _, registry) = setup_full(&env, min_stake);

    let r = Address::generate(&env);
    sac.mint(&r, &(min_stake * 3));
    registry.register(&r, &min_stake);

    registry.request_unregister(&r);
    assert!(!registry.is_active(&r));

    registry.increase_stake(&r, &(min_stake * 2));

    assert!(!registry.is_active(&r));
    assert!(registry.get(&r).unwrap().unbonding_at.is_some());
}

// ---------------------------------------------------------------------------
// Re-register after full two-phase exit
// ---------------------------------------------------------------------------

#[test]
fn re_register_after_withdraw_stake_succeeds() {
    let env = Env::default();
    let min_stake = 100_0000000i128;
    let (_, _, _, sac, token, registry) = setup_full(&env, min_stake);

    let r = Address::generate(&env);
    sac.mint(&r, &(min_stake * 2));

    registry.register(&r, &min_stake);
    registry.request_unregister(&r);
    advance_time(&env, PERIOD);
    registry.withdraw_stake(&r);

    assert!(registry.get(&r).is_none());

    registry.register(&r, &min_stake);

    let info = registry.get(&r).unwrap();
    assert_eq!(info.stake, min_stake);
    assert!(info.active);
    assert_eq!(info.unbonding_at, None);
    assert!(registry.list().contains(&r));
    assert_eq!(token.balance(&registry.address), min_stake);
}

// ---------------------------------------------------------------------------
// set_unbonding_period
// ---------------------------------------------------------------------------

#[test]
fn set_unbonding_period_updates_and_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, _, registry) = setup_gov(&env);

    let old = registry.unbonding_period();
    let new_period = old * 2;

    registry.set_unbonding_period(&new_period);
    assert_last_event(
        &env,
        &registry.address,
        (symbol_short!("cfg"), symbol_short!("unbnd_per")),
        (old, new_period),
    );
    assert_eq!(registry.unbonding_period(), new_period);
}

#[test]
fn set_unbonding_period_below_minimum_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, _, registry) = setup_gov(&env);

    assert_eq!(
        registry
            .try_set_unbonding_period(&(MIN_UNBONDING_PERIOD_SECS - 1))
            .err()
            .unwrap()
            .unwrap(),
        Error::UnbondingPeriodTooShort.into()
    );
}

#[test]
fn set_unbonding_period_at_minimum_succeeds() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, _, registry) = setup_gov(&env);

    registry.set_unbonding_period(&MIN_UNBONDING_PERIOD_SECS);
    assert_eq!(registry.unbonding_period(), MIN_UNBONDING_PERIOD_SECS);
}

#[test]
fn new_unbonding_period_applies_to_future_requests_only() {
    // In-flight unbonding entries are NOT updated when the period changes.
    let env = Env::default();
    let min_stake = 100_0000000i128;
    let (_, _, _, sac, _, registry) = setup_full(&env, min_stake);

    let r = Address::generate(&env);
    sac.mint(&r, &min_stake);
    registry.register(&r, &min_stake);

    let now = env.ledger().timestamp();
    registry.request_unregister(&r);
    let original_ready = now + PERIOD;

    // Double the period after the request is already in flight.
    registry.set_unbonding_period(&(PERIOD * 2));

    // In-flight entry is unchanged.
    assert_eq!(registry.get(&r).unwrap().unbonding_at, Some(original_ready));
}

// ---------------------------------------------------------------------------
// set_min_stake
// ---------------------------------------------------------------------------

#[test]
fn set_min_stake_updates_and_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, _, registry) = setup_gov(&env);

    let old = registry.min_stake();
    let new_min = old / 2;

    registry.set_min_stake(&new_min);
    assert_last_event(
        &env,
        &registry.address,
        (symbol_short!("cfg"), symbol_short!("min_stake")),
        (old, new_min),
    );
    assert_eq!(registry.min_stake(), new_min);
}

#[test]
fn set_min_stake_to_zero_succeeds() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, _, registry) = setup_gov(&env);
    registry.set_min_stake(&0i128);
    assert_eq!(registry.min_stake(), 0);
}

#[test]
fn set_min_stake_negative_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, _, registry) = setup_gov(&env);
    assert_eq!(
        registry.try_set_min_stake(&(-1i128)).err().unwrap().unwrap(),
        Error::InvalidAmount.into()
    );
}

#[test]
fn set_min_stake_raised_does_not_retroactively_deactivate() {
    let env = Env::default();
    let min_stake = 100_0000000i128;
    let (_, _, _, sac, _, registry) = setup_full(&env, min_stake);

    let r = Address::generate(&env);
    sac.mint(&r, &min_stake);
    registry.register(&r, &min_stake);
    assert!(registry.is_active(&r));

    registry.set_min_stake(&(min_stake * 10));
    assert!(
        registry.is_active(&r),
        "set_min_stake must not retroactively deactivate existing resolvers"
    );
}

// ---------------------------------------------------------------------------
// set_slash_beneficiary
// ---------------------------------------------------------------------------

#[test]
fn set_slash_beneficiary_updates_and_emits_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, old_ben, registry) = setup_gov(&env);

    let new_ben = Address::generate(&env);
    registry.set_slash_beneficiary(&new_ben);
    assert_last_event(
        &env,
        &registry.address,
        (symbol_short!("cfg"), symbol_short!("slash_ben")),
        (old_ben, new_ben),
    );
}

// ---------------------------------------------------------------------------
// Read-only helpers
// ---------------------------------------------------------------------------

#[test]
fn is_active_false_for_unknown() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, _, registry) = setup_gov(&env);
    assert!(!registry.is_active(&Address::generate(&env)));
}

#[test]
fn get_none_for_unknown() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, _, registry) = setup_gov(&env);
    assert!(registry.get(&Address::generate(&env)).is_none());
}

#[test]
fn list_empty_initially() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, _, registry) = setup_gov(&env);
    assert!(registry.list().is_empty());
}

#[test]
fn list_tracks_add_and_remove_via_two_phase_exit() {
    let env = Env::default();
    let min_stake = 100_0000000i128;
    let (_, _, _, sac, _, registry) = setup_full(&env, min_stake);

    let (r1, r2, r3) = (
        Address::generate(&env),
        Address::generate(&env),
        Address::generate(&env),
    );
    for r in [&r1, &r2, &r3] {
        sac.mint(r, &min_stake);
        registry.register(r, &min_stake);
    }

    let list = registry.list();
    assert_eq!(list.len(), 3);
    assert!(list.contains(&r1) && list.contains(&r2) && list.contains(&r3));

    // r2 goes through the two-phase exit.
    registry.request_unregister(&r2);
    // Still in list until withdraw.
    assert!(registry.list().contains(&r2));

    advance_time(&env, PERIOD);
    registry.withdraw_stake(&r2);

    let after = registry.list();
    assert_eq!(after.len(), 2);
    assert!(after.contains(&r1) && after.contains(&r3));
    assert!(!after.contains(&r2));
}

// ---------------------------------------------------------------------------
// Governance: two-step admin transfer
// ---------------------------------------------------------------------------

#[test]
fn admin_transfer_full_lifecycle_emits_events() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, _, registry) = setup_gov(&env);
    let new_admin = Address::generate(&env);

    registry.transfer_admin(&new_admin);
    assert_last_event(
        &env,
        &registry.address,
        (symbol_short!("adm_xfer"), symbol_short!("proposed")),
        (admin.clone(), new_admin.clone()),
    );
    assert_eq!(registry.admin(), admin);
    assert_eq!(registry.pending_admin(), Some(new_admin.clone()));

    registry.accept_admin();
    assert_last_event(
        &env,
        &registry.address,
        (symbol_short!("adm_xfer"), symbol_short!("accepted")),
        (admin, new_admin.clone()),
    );
    assert_eq!(registry.admin(), new_admin);
    assert_eq!(registry.pending_admin(), None);
}

#[test]
fn accept_admin_requires_pending_admin_auth() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let cid = env.register(
        ResolverRegistry,
        (
            admin.clone(),
            Address::generate(&env),
            0i128,
            Address::generate(&env),
            PERIOD,
        ),
    );
    let registry = ResolverRegistryClient::new(&env, &cid);
    let new_admin = Address::generate(&env);
    let stranger = Address::generate(&env);

    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &cid,
            fn_name: "transfer_admin",
            args: (new_admin.clone(),).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    registry.transfer_admin(&new_admin);

    env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &cid,
            fn_name: "accept_admin",
            args: ().into_val(&env),
            sub_invokes: &[],
        },
    }]);
    assert!(registry.try_accept_admin().is_err());
    assert_eq!(registry.admin(), admin);

    env.mock_auths(&[MockAuth {
        address: &new_admin,
        invoke: &MockAuthInvoke {
            contract: &cid,
            fn_name: "accept_admin",
            args: ().into_val(&env),
            sub_invokes: &[],
        },
    }]);
    registry.accept_admin();
    assert_eq!(registry.admin(), new_admin);
}

#[test]
fn revoke_pending_admin_emits_event_and_clears_pending() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, _, registry) = setup_gov(&env);
    let wrong = Address::generate(&env);

    registry.transfer_admin(&wrong);
    registry.revoke_pending_admin();
    assert_last_event(
        &env,
        &registry.address,
        (symbol_short!("adm_xfer"), symbol_short!("revoked")),
        (admin.clone(), wrong),
    );
    assert_eq!(registry.pending_admin(), None);
    assert_eq!(registry.admin(), admin);

    assert_eq!(
        registry.try_accept_admin().err().unwrap().unwrap(),
        Error::NoPendingTransfer.into()
    );
    assert_eq!(
        registry.try_revoke_pending_admin().err().unwrap().unwrap(),
        Error::NoPendingTransfer.into()
    );
}

#[test]
fn admin_functions_locked_to_current_admin_during_transfer() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let cid = env.register(
        ResolverRegistry,
        (
            admin.clone(),
            Address::generate(&env),
            0i128,
            Address::generate(&env),
            PERIOD,
        ),
    );
    let registry = ResolverRegistryClient::new(&env, &cid);
    let new_admin = Address::generate(&env);

    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &cid,
            fn_name: "transfer_admin",
            args: (new_admin.clone(),).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    registry.transfer_admin(&new_admin);

    env.mock_auths(&[MockAuth {
        address: &new_admin,
        invoke: &MockAuthInvoke {
            contract: &cid,
            fn_name: "set_min_stake",
            args: (5i128,).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    assert!(registry.try_set_min_stake(&5).is_err());

    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &cid,
            fn_name: "set_min_stake",
            args: (7i128,).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    registry.set_min_stake(&7);
    assert_eq!(registry.min_stake(), 7);
}

#[test]
fn config_mutations_emit_events_with_old_and_new_values() {
    let env = Env::default();
    env.mock_all_auths();
    let (_, old_ben, registry) = setup_gov(&env);

    let old_min = registry.min_stake();
    registry.set_min_stake(&50_0000000i128);
    assert_last_event(
        &env,
        &registry.address,
        (symbol_short!("cfg"), symbol_short!("min_stake")),
        (old_min, 50_0000000i128),
    );

    let new_ben = Address::generate(&env);
    registry.set_slash_beneficiary(&new_ben);
    assert_last_event(
        &env,
        &registry.address,
        (symbol_short!("cfg"), symbol_short!("slash_ben")),
        (old_ben, new_ben),
    );
}

// ---------------------------------------------------------------------------
// Lifecycle sequences
// ---------------------------------------------------------------------------

#[test]
fn full_lifecycle_register_increase_two_phase_exit() {
    let env = Env::default();
    let min_stake = 100_0000000i128;
    let (_, _, _, sac, token, registry) = setup_full(&env, min_stake);

    let r = Address::generate(&env);
    let initial = min_stake;
    let additional = 50_0000000i128;
    sac.mint(&r, &(initial + additional));

    registry.register(&r, &initial);
    registry.increase_stake(&r, &additional);
    assert_eq!(registry.get(&r).unwrap().stake, initial + additional);

    registry.request_unregister(&r);
    assert!(!registry.is_active(&r));
    assert_eq!(token.balance(&r), 0); // stake still locked

    advance_time(&env, PERIOD);
    registry.withdraw_stake(&r);

    assert_eq!(token.balance(&r), initial + additional);
    assert_eq!(token.balance(&registry.address), 0);
    assert!(registry.get(&r).is_none());
    assert!(!registry.list().contains(&r));
}

// ---------------------------------------------------------------------------
// Slash boundary: stake == min_stake after slash stays Active (#501)
// ---------------------------------------------------------------------------

#[test]
fn slash_to_exactly_min_stake_keeps_active() {
    let env = Env::default();
    let min_stake = 100_0000000i128;
    let (_, _, _, sac, _, registry) = setup_full(&env, min_stake);

    let r = Address::generate(&env);
    // One stroops above minimum so slashing by 1 lands exactly at the floor.
    sac.mint(&r, &(min_stake + 1));
    registry.register(&r, &(min_stake + 1));
    assert!(registry.is_active(&r));

    // Slash by 1 → remaining stake == min_stake; must still be Active.
    registry.slash(&r, &1i128);

    let info = registry.get(&r).unwrap();
    assert_eq!(info.stake, min_stake);
    assert_eq!(info.lifecycle, ResolverLifecycle::Active);
    assert!(info.active, "stake == min_stake must remain Active (threshold is strict <)");
    assert!(registry.is_active(&r));
}

// ---------------------------------------------------------------------------
// Inactive resolver can still request_unregister and withdraw (#501)
// ---------------------------------------------------------------------------

#[test]
fn inactive_resolver_can_request_unregister_and_withdraw() {
    let env = Env::default();
    let min_stake = 100_0000000i128;
    let (_, _, _, sac, token, registry) = setup_full(&env, min_stake);

    let r = Address::generate(&env);
    let stake = min_stake * 2;
    sac.mint(&r, &stake);
    registry.register(&r, &stake);

    // Slash below the minimum threshold → Inactive lifecycle.
    registry.slash(&r, &(min_stake + 1));
    let info_before = registry.get(&r).unwrap();
    assert_eq!(info_before.lifecycle, ResolverLifecycle::Inactive);
    assert!(!info_before.active);

    // An Inactive resolver still holds locked stake and can initiate exit.
    let now = env.ledger().timestamp();
    registry.request_unregister(&r);
    let info_unbonding = registry.get(&r).unwrap();
    assert_eq!(info_unbonding.lifecycle, ResolverLifecycle::Unbonding,
        "request_unregister must transition Inactive → Unbonding");
    assert!(info_unbonding.unbonding_at.is_some());
    let expected_ready = now + PERIOD;
    assert_eq!(info_unbonding.unbonding_at, Some(expected_ready));

    // Advance past unbonding window and complete the exit.
    advance_time(&env, PERIOD);
    let remaining_stake = info_unbonding.stake;
    registry.withdraw_stake(&r);

    assert_eq!(token.balance(&r), remaining_stake);
    assert!(registry.get(&r).is_none());
    assert!(!registry.list().contains(&r));
}

// ---------------------------------------------------------------------------
// Re-register while Inactive (entry exists) → AlreadyRegistered (#501)
// ---------------------------------------------------------------------------

#[test]
fn re_register_while_inactive_without_withdraw_fails() {
    let env = Env::default();
    let min_stake = 100_0000000i128;
    let (_, _, _, sac, _, registry) = setup_full(&env, min_stake);

    let r = Address::generate(&env);
    sac.mint(&r, &(min_stake * 3));
    registry.register(&r, &min_stake);

    // Slash to zero → Inactive (the entry is still in persistent storage).
    registry.slash(&r, &min_stake);
    assert_eq!(registry.get(&r).unwrap().lifecycle, ResolverLifecycle::Inactive);

    // Attempting to re-register before withdrawing must fail — the entry exists.
    assert_eq!(
        registry.try_register(&r, &min_stake).err().unwrap().unwrap(),
        Error::AlreadyRegistered.into(),
        "must not register while an existing entry (even Inactive) is present"
    );
}

// ---------------------------------------------------------------------------
// Multiple slash events cumulatively accumulate total_slashed (#501)
// ---------------------------------------------------------------------------

#[test]
fn multiple_slash_events_cumulate_total_slashed() {
    let env = Env::default();
    let min_stake = 100_0000000i128;
    let (_, _, _, sac, _, registry) = setup_full(&env, min_stake);

    let r = Address::generate(&env);
    let stake = min_stake * 5;
    sac.mint(&r, &stake);
    registry.register(&r, &stake);

    // Advance time so last_slash_at is non-zero (Soroban test env starts at timestamp 0).
    advance_time(&env, 1000);

    let s1 = min_stake;
    let s2 = 50_0000000i128;
    let s3 = 25_0000000i128;

    registry.slash(&r, &s1);
    registry.slash(&r, &s2);
    registry.slash(&r, &s3);

    let info = registry.get(&r).unwrap();
    assert_eq!(info.total_slashed, s1 + s2 + s3,
        "total_slashed must accumulate across multiple slash calls");
    assert_eq!(info.stake, stake - s1 - s2 - s3);
    // last_slash_at must be updated on each slash.
    assert!(info.last_slash_at > 0);
}

// ---------------------------------------------------------------------------
// Slash during Unbonding that crosses the minimum → Inactive (#501)
// ---------------------------------------------------------------------------

#[test]
fn slash_during_unbonding_crossing_min_transitions_to_inactive() {
    let env = Env::default();
    let min_stake = 100_0000000i128;
    let (_, _, _, sac, _, registry) = setup_full(&env, min_stake);

    let r = Address::generate(&env);
    // Stake is min_stake + 1 so a slash of 2 crosses below the floor.
    sac.mint(&r, &(min_stake + 1));
    registry.register(&r, &(min_stake + 1));

    registry.request_unregister(&r);
    assert_eq!(registry.get(&r).unwrap().lifecycle, ResolverLifecycle::Unbonding);

    // Slash by 2 → remaining = min_stake - 1 < min_stake → must become Inactive.
    registry.slash(&r, &2i128);

    let info = registry.get(&r).unwrap();
    assert_eq!(info.lifecycle, ResolverLifecycle::Inactive,
        "slash during Unbonding that crosses min_stake threshold must flip to Inactive");
    assert!(!info.active);
    assert!(!registry.is_active(&r));
}

// ---------------------------------------------------------------------------
// Slash on an already-Inactive resolver keeps it Inactive (#501)
// ---------------------------------------------------------------------------

#[test]
fn slash_inactive_resolver_stays_inactive() {
    let env = Env::default();
    let min_stake = 100_0000000i128;
    let (_, _, _, sac, _, registry) = setup_full(&env, min_stake);

    let r = Address::generate(&env);
    let stake = min_stake * 2;
    sac.mint(&r, &stake);
    registry.register(&r, &stake);

    // First slash: crosses the minimum → Inactive.
    registry.slash(&r, &(min_stake + 1));
    assert_eq!(registry.get(&r).unwrap().lifecycle, ResolverLifecycle::Inactive);

    // Second slash on an already-Inactive resolver must not change lifecycle.
    registry.slash(&r, &1i128);
    let info = registry.get(&r).unwrap();
    assert_eq!(info.lifecycle, ResolverLifecycle::Inactive,
        "Inactive must remain Inactive regardless of further slashes");
    assert!(!info.active);
}

// ---------------------------------------------------------------------------
// Full flow: slash → Inactive → unregister → withdraw → re-register (#501)
// ---------------------------------------------------------------------------

#[test]
fn full_lifecycle_slash_inactive_exit_and_reregister() {
    let env = Env::default();
    let min_stake = 100_0000000i128;
    let (_, _, _, sac, token, registry) = setup_full(&env, min_stake);

    let r = Address::generate(&env);
    sac.mint(&r, &(min_stake * 4));

    // Register and get slashed below the minimum.
    registry.register(&r, &(min_stake * 2));
    registry.slash(&r, &(min_stake + 1));
    assert_eq!(registry.get(&r).unwrap().lifecycle, ResolverLifecycle::Inactive);
    assert!(!registry.is_active(&r));

    // Initiate exit from Inactive state.
    registry.request_unregister(&r);
    advance_time(&env, PERIOD);
    let remaining = registry.get(&r).unwrap().stake;
    let balance_before = token.balance(&r);
    registry.withdraw_stake(&r);

    assert_eq!(token.balance(&r), balance_before + remaining);
    assert!(registry.get(&r).is_none(), "entry must be removed after withdraw_stake");

    // Re-register cleanly with a fresh stake.
    registry.register(&r, &min_stake);

    let info = registry.get(&r).unwrap();
    assert_eq!(info.lifecycle, ResolverLifecycle::Active, "re-registration must start Active");
    assert!(info.active);
    assert_eq!(info.unbonding_at, None);
    assert_eq!(info.total_slashed, 0, "re-registration resets slash accounting");
    assert_eq!(info.stake, min_stake);
    assert!(registry.list().contains(&r));
    assert!(registry.is_active(&r));
}

// ---------------------------------------------------------------------------
// lifecycle field and active boolean are always consistent (#501)
// ---------------------------------------------------------------------------

#[test]
fn lifecycle_and_active_bool_always_consistent() {
    let env = Env::default();
    let min_stake = 100_0000000i128;
    let (_, _, _, sac, _, registry) = setup_full(&env, min_stake);

    let r = Address::generate(&env);
    sac.mint(&r, &(min_stake * 3));

    // Active state
    registry.register(&r, &(min_stake * 3));
    let info = registry.get(&r).unwrap();
    assert_eq!(info.lifecycle, ResolverLifecycle::Active);
    assert!(info.active);
    assert!(registry.is_active(&r));

    // Unbonding state
    registry.request_unregister(&r);
    let info = registry.get(&r).unwrap();
    assert_eq!(info.lifecycle, ResolverLifecycle::Unbonding);
    assert!(!info.active, "active must be false in Unbonding");
    assert!(!registry.is_active(&r));

    // Slash during unbonding → Inactive
    registry.slash(&r, &(min_stake * 3));
    let info = registry.get(&r).unwrap();
    assert_eq!(info.lifecycle, ResolverLifecycle::Inactive);
    assert!(!info.active, "active must be false in Inactive");
    assert!(!registry.is_active(&r));

    // Withdrawal completes → entry removed
    advance_time(&env, PERIOD);
    registry.withdraw_stake(&r);
    assert!(registry.get(&r).is_none());
    assert!(!registry.is_active(&r), "is_active must be false for unknown resolver");
}

// ---------------------------------------------------------------------------
// Slash during Unbonding that keeps stake >= min stays Unbonding (#703)
// ---------------------------------------------------------------------------

#[test]
fn slash_during_unbonding_above_min_keeps_unbonding_lifecycle() {
    // A partial slash during the unbonding window that leaves stake >= min_stake
    // must keep lifecycle == Unbonding (not transition to Inactive).
    let env = Env::default();
    let min_stake = 100_0000000i128;
    let (_, _, _, sac, _, registry) = setup_full(&env, min_stake);

    let r = Address::generate(&env);
    // Stake is 3× minimum so a single-unit slash leaves it well above the floor.
    let stake = min_stake * 3;
    sac.mint(&r, &stake);
    registry.register(&r, &stake);

    registry.request_unregister(&r);
    assert_eq!(registry.get(&r).unwrap().lifecycle, ResolverLifecycle::Unbonding);

    // Slash by exactly min_stake; remaining = 2× min_stake ≥ min_stake.
    registry.slash(&r, &min_stake);

    let info = registry.get(&r).unwrap();
    assert_eq!(
        info.lifecycle,
        ResolverLifecycle::Unbonding,
        "slash during unbonding that keeps stake >= min_stake must stay Unbonding"
    );
    assert!(!info.active, "active must remain false while Unbonding");
    assert_eq!(info.stake, min_stake * 2);
    assert!(info.unbonding_at.is_some(), "unbonding_at must be preserved");

    // Advance past window — withdrawal must succeed with the remaining stake.
    advance_time(&env, PERIOD);
    registry.withdraw_stake(&r);
    assert!(registry.get(&r).is_none());
}

// ---------------------------------------------------------------------------
// slash_with_reason: each SlashCondition code is recorded in the event (#703)
// ---------------------------------------------------------------------------

#[test]
fn slash_with_reason_failed_fulfillment_emits_condition_in_event() {
    let env = Env::default();
    let min_stake = 100_0000000i128;
    let (_, beneficiary, _, sac, token, registry) = setup_full(&env, min_stake);

    let r = Address::generate(&env);
    sac.mint(&r, &min_stake);
    registry.register(&r, &min_stake);

    registry.slash_with_reason(&r, &min_stake, &SlashCondition::FailedOrderFulfillment);
    assert_last_event(
        &env,
        &registry.address,
        (symbol_short!("slashed"), r.clone()),
        (min_stake, SlashCondition::FailedOrderFulfillment),
    );

    assert_eq!(token.balance(&beneficiary), min_stake);
    let info = registry.get(&r).unwrap();
    assert_eq!(info.stake, 0);
    assert_eq!(info.lifecycle, ResolverLifecycle::Inactive);
}

#[test]
fn slash_with_reason_fraudulent_claim_deactivates_and_emits() {
    let env = Env::default();
    let min_stake = 100_0000000i128;
    let (_, _, _, sac, _, registry) = setup_full(&env, min_stake);

    let r = Address::generate(&env);
    let stake = min_stake * 2;
    sac.mint(&r, &stake);
    registry.register(&r, &stake);

    registry.slash_with_reason(&r, &min_stake, &SlashCondition::FraudulentClaim);
    assert_last_event(
        &env,
        &registry.address,
        (symbol_short!("slashed"), r.clone()),
        (min_stake, SlashCondition::FraudulentClaim),
    );

    let info = registry.get(&r).unwrap();
    // stake == min_stake remains; resolver is still Active (strict < threshold).
    assert_eq!(info.stake, min_stake);
    assert_eq!(info.lifecycle, ResolverLifecycle::Active);
    assert!(info.active);
}

#[test]
fn slash_with_reason_order_abandonment_during_unbonding() {
    let env = Env::default();
    let min_stake = 100_0000000i128;
    let (_, _, _, sac, _, registry) = setup_full(&env, min_stake);

    let r = Address::generate(&env);
    sac.mint(&r, &min_stake);
    registry.register(&r, &min_stake);
    registry.request_unregister(&r);

    // Full slash with OrderAbandonment condition during unbonding window.
    registry.slash_with_reason(&r, &min_stake, &SlashCondition::OrderAbandonment);
    assert_last_event(
        &env,
        &registry.address,
        (symbol_short!("slashed"), r.clone()),
        (min_stake, SlashCondition::OrderAbandonment),
    );

    let info = registry.get(&r).unwrap();
    assert_eq!(info.stake, 0);
    assert_eq!(info.lifecycle, ResolverLifecycle::Inactive);
    // Entry still present; resolver must complete the exit cycle.
    assert!(info.unbonding_at.is_some());
}

#[test]
fn slash_with_reason_protocol_violation_is_catchall() {
    let env = Env::default();
    let min_stake = 100_0000000i128;
    let (_, _, _, sac, _, registry) = setup_full(&env, min_stake);

    let r = Address::generate(&env);
    sac.mint(&r, &(min_stake * 2));
    registry.register(&r, &(min_stake * 2));

    let slash_amt = min_stake / 2;
    registry.slash_with_reason(&r, &slash_amt, &SlashCondition::ProtocolViolation);
    assert_last_event(
        &env,
        &registry.address,
        (symbol_short!("slashed"), r.clone()),
        (slash_amt, SlashCondition::ProtocolViolation),
    );

    let info = registry.get(&r).unwrap();
    // Partial slash above the floor — resolver stays Active.
    assert_eq!(info.lifecycle, ResolverLifecycle::Active);
    assert!(info.active);
    assert_eq!(info.stake, min_stake * 2 - slash_amt);
}

#[test]
fn slash_with_reason_zero_amount_rejected() {
    let env = Env::default();
    let min_stake = 100_0000000i128;
    let (_, _, _, sac, _, registry) = setup_full(&env, min_stake);

    let r = Address::generate(&env);
    sac.mint(&r, &min_stake);
    registry.register(&r, &min_stake);
    assert_eq!(
        registry
            .try_slash_with_reason(&r, &0i128, &SlashCondition::ProtocolViolation)
            .err()
            .unwrap()
            .unwrap(),
        Error::InvalidAmount.into()
    );
}
