#![cfg(test)]

use crate::{Error, ResolverRegistry, ResolverRegistryClient};
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events, MockAuth, MockAuthInvoke},
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
        (admin.clone(), tok_addr.clone(), min_stake, beneficiary.clone()),
    );
    env.mock_all_auths();
    (
        admin,
        beneficiary,
        tok_addr,
        sac,
        token,
        ResolverRegistryClient::new(env, &cid),
    )
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
            attacker.into_val(&env),
        ],
    );
    assert!(res.is_err());
    assert_eq!(registry.admin(), admin);
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

    // emit happens here — assert event BEFORE any read call
    registry.register(&resolver, &min_stake);
    assert_last_event(
        &env,
        &registry.address,
        (symbol_short!("register"), resolver.clone()),
        (min_stake,),
    );

    // balance checks (each is a separate invocation — event log is gone by now)
    assert_eq!(token.balance(&resolver), bal_resolver_before - min_stake);
    assert_eq!(token.balance(&registry.address), bal_contract_before + min_stake);

    // state checks
    let info = registry.get(&resolver).unwrap();
    assert_eq!(info.stake, min_stake);
    assert!(info.active);
    assert_eq!(info.total_slashed, 0);
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

    // emit + assert immediately
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
// unregister — success
// ---------------------------------------------------------------------------

#[test]
fn unregister_returns_full_stake_removes_from_list_emits_event() {
    let env = Env::default();
    let min_stake = 100_0000000i128;
    let (_, _, _, sac, token, registry) = setup_full(&env, min_stake);

    let r = Address::generate(&env);
    sac.mint(&r, &min_stake);
    registry.register(&r, &min_stake);

    assert_eq!(token.balance(&r), 0);
    assert_eq!(token.balance(&registry.address), min_stake);

    // emit + assert immediately
    registry.unregister(&r);
    assert_last_event(
        &env,
        &registry.address,
        (symbol_short!("unreg"), r.clone()),
        (min_stake,),
    );

    assert_eq!(token.balance(&r), min_stake);
    assert_eq!(token.balance(&registry.address), 0);
    assert!(registry.get(&r).is_none());
    assert!(!registry.list().contains(&r));
    assert!(!registry.is_active(&r));
}

#[test]
fn unregister_after_partial_slash_returns_remaining_stake() {
    let env = Env::default();
    let min_stake = 100_0000000i128;
    let (_, _, _, sac, token, registry) = setup_full(&env, min_stake);

    let r = Address::generate(&env);
    let stake = min_stake * 2;
    sac.mint(&r, &stake);
    registry.register(&r, &stake);

    let slash_amt = min_stake; // partial — leaves min_stake remaining
    registry.slash(&r, &slash_amt);
    let remaining = stake - slash_amt;

    // emit + assert immediately
    registry.unregister(&r);
    assert_last_event(
        &env,
        &registry.address,
        (symbol_short!("unreg"), r.clone()),
        (remaining,),
    );

    assert_eq!(token.balance(&r), remaining);
    assert_eq!(token.balance(&registry.address), 0);
}

// ---------------------------------------------------------------------------
// unregister — errors
// ---------------------------------------------------------------------------

#[test]
fn unregister_unknown_resolver_rejected() {
    let env = Env::default();
    let (_, _, _, _, _, registry) = setup_full(&env, 100_0000000i128);

    assert_eq!(
        registry.try_unregister(&Address::generate(&env)).err().unwrap().unwrap(),
        Error::ResolverNotFound.into()
    );
}

// ---------------------------------------------------------------------------
// slash — success
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

    let slash_amt = min_stake; // partial — resolver stays active (2× left)

    // emit + assert immediately
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
    // Requesting more than the stake should only take what is available.
    let env = Env::default();
    let min_stake = 100_0000000i128;
    let (_, beneficiary, _, sac, token, registry) = setup_full(&env, min_stake);

    let r = Address::generate(&env);
    sac.mint(&r, &min_stake);
    registry.register(&r, &min_stake);

    let over = min_stake * 2;

    // emit + assert immediately — data must carry clamped amount, not `over`
    registry.slash(&r, &over);
    assert_last_event(
        &env,
        &registry.address,
        (symbol_short!("slashed"), r.clone()),
        (min_stake,), // take = min(over, stake) = min_stake
    );

    assert_eq!(token.balance(&beneficiary), min_stake);
    assert_eq!(token.balance(&registry.address), 0);
    let info = registry.get(&r).unwrap();
    assert_eq!(info.stake, 0);
    assert_eq!(info.total_slashed, min_stake);
}

#[test]
fn slash_just_below_threshold_deactivates() {
    // stake = min_stake + 1; slash 2 → remaining = min_stake - 1 → inactive
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

// ---------------------------------------------------------------------------
// slash — errors
// ---------------------------------------------------------------------------

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

    // stranger auth must fail
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

    // admin auth must succeed
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
// Pinned behaviour: increase_stake does NOT reactivate a deactivated resolver
//
// MAINTAINER NOTE (see PR description):
//   `increase_stake` never re-evaluates `info.active`. Once deactivated
//   by a slash, topping up the stake does NOT flip `active` back to
//   `true`. If this policy should change, a dedicated `reactivate`
//   function or an update to `increase_stake` is required. This test
//   MUST stay green until that change is explicitly merged.
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

    registry.slash(&r, &min_stake); // full slash → deactivated, stake = 0
    assert!(!registry.is_active(&r));

    registry.increase_stake(&r, &(min_stake * 2)); // top up to 2× min

    let info = registry.get(&r).unwrap();
    assert_eq!(info.stake, min_stake * 2);
    assert!(
        !info.active,
        "increase_stake must NOT reactivate — maintainer decision required"
    );
    assert!(!registry.is_active(&r));
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

    // emit + assert immediately
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

/// Raising min_stake above a registered resolver's stake does NOT
/// retroactively deactivate them — `active` is only mutated by `slash`.
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
    // emit + assert immediately
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
fn list_tracks_add_and_remove() {
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

    registry.unregister(&r2);
    let after = registry.list();
    assert_eq!(after.len(), 2);
    assert!(after.contains(&r1) && after.contains(&r3));
    assert!(!after.contains(&r2));
}

// ---------------------------------------------------------------------------
// Re-register after unregister
// ---------------------------------------------------------------------------

#[test]
fn re_register_after_unregister_succeeds() {
    let env = Env::default();
    let min_stake = 100_0000000i128;
    let (_, _, _, sac, token, registry) = setup_full(&env, min_stake);

    let r = Address::generate(&env);
    sac.mint(&r, &(min_stake * 2));

    registry.register(&r, &min_stake);
    registry.unregister(&r);

    assert!(registry.get(&r).is_none());

    registry.register(&r, &min_stake);

    let info = registry.get(&r).unwrap();
    assert_eq!(info.stake, min_stake);
    assert!(info.active);
    assert!(registry.list().contains(&r));
    assert_eq!(token.balance(&registry.address), min_stake);
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
        (admin.clone(), Address::generate(&env), 0i128, Address::generate(&env)),
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

    // stranger cannot complete
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

    // pending admin succeeds
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
        (admin.clone(), Address::generate(&env), 0i128, Address::generate(&env)),
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

    // pending admin cannot touch admin-gated config
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

    // current admin can
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
fn full_lifecycle_register_increase_unregister_balances() {
    let env = Env::default();
    let min_stake = 100_0000000i128;
    let (_, _, _, sac, token, registry) = setup_full(&env, min_stake);

    let r = Address::generate(&env);
    let mint = min_stake * 4;
    sac.mint(&r, &mint);

    registry.register(&r, &min_stake);
    assert_eq!(token.balance(&r), mint - min_stake);
    assert_eq!(token.balance(&registry.address), min_stake);
    assert!(registry.is_active(&r));

    let top_up = min_stake;
    registry.increase_stake(&r, &top_up);
    assert_eq!(token.balance(&registry.address), min_stake + top_up);
    assert_eq!(registry.get(&r).unwrap().stake, min_stake + top_up);

    let total_staked = min_stake + top_up;
    registry.unregister(&r);
    assert_eq!(token.balance(&r), mint - total_staked + total_staked);
    assert_eq!(token.balance(&registry.address), 0);
    assert!(!registry.is_active(&r));
}

/// slash-below-minimum → deactivated → increase_stake tops up (stays inactive)
/// → unregister returns remaining stake
#[test]
fn lifecycle_deactivate_then_topup_then_unregister() {
    let env = Env::default();
    let min_stake = 100_0000000i128;
    let (_, beneficiary, _, sac, token, registry) = setup_full(&env, min_stake);

    let r = Address::generate(&env);
    sac.mint(&r, &(min_stake * 5));
    registry.register(&r, &min_stake);

    registry.slash(&r, &min_stake); // full slash → stake=0, inactive
    assert!(!registry.is_active(&r));
    assert_eq!(token.balance(&beneficiary), min_stake);

    registry.increase_stake(&r, &(min_stake * 2)); // top up → still inactive (pinned)
    assert!(!registry.get(&r).unwrap().active);

    registry.unregister(&r);
    assert_eq!(token.balance(&registry.address), 0);
}

/// Multiple resolvers are independent: slashing one does not affect others.
#[test]
fn multiple_resolver_independence() {
    let env = Env::default();
    let min_stake = 100_0000000i128;
    let (_, _, _, sac, token, registry) = setup_full(&env, min_stake);

    let r1 = Address::generate(&env);
    let r2 = Address::generate(&env);
    sac.mint(&r1, &min_stake);
    sac.mint(&r2, &(min_stake * 2));

    registry.register(&r1, &min_stake);
    registry.register(&r2, &min_stake);

    registry.slash(&r1, &min_stake); // fully slash r1
    assert!(!registry.is_active(&r1));
    assert!(registry.is_active(&r2));
    assert_eq!(registry.get(&r2).unwrap().stake, min_stake);

    registry.unregister(&r2);
    assert!(registry.get(&r1).is_some()); // r1 record still exists
    assert!(registry.get(&r2).is_none());
    assert_eq!(token.balance(&r2), min_stake * 2); // got stake back + remainder
    let list = registry.list();
    assert_eq!(list.len(), 1);
    assert!(list.contains(&r1));
}
