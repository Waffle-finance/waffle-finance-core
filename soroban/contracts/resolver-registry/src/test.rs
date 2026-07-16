#![cfg(test)]

use crate::{Error, ResolverRegistry, ResolverRegistryClient};
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events, MockAuth, MockAuthInvoke},
    vec, Address, Env, IntoVal, Symbol, Val,
};

/// Deploy + configure the registry atomically via the constructor.
/// The stake asset is a plain generated address: none of the
/// governance paths under test move tokens.
fn setup(env: &Env) -> (Address, Address, ResolverRegistryClient<'_>) {
    let admin = Address::generate(env);
    let stake_asset = Address::generate(env);
    let slash_beneficiary = Address::generate(env);
    let contract_id = env.register(
        ResolverRegistry,
        (
            admin.clone(),
            stake_asset,
            100_0000000i128,
            slash_beneficiary.clone(),
        ),
    );
    let client = ResolverRegistryClient::new(env, &contract_id);
    env.mock_all_auths();
    (admin, slash_beneficiary, client)
}

/// Assert the last event published by the most recent invocation.
/// Comparison happens between soroban Vecs because `Val` itself does
/// not implement `PartialEq`.
fn assert_last_event<T, D>(env: &Env, contract: &Address, topics: T, data: D)
where
    T: IntoVal<Env, soroban_sdk::Vec<Val>>,
    D: IntoVal<Env, Val>,
{
    let all = env.events().all();
    assert_eq!(
        all.slice(all.len() - 1..),
        vec![
            env,
            (contract.clone(), topics.into_val(env), data.into_val(env))
        ]
    );
}

#[test]
fn constructor_cannot_be_rerun_to_steal_admin() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, beneficiary, registry) = setup(&env);

    let attacker = Address::generate(&env);
    let res = env.try_invoke_contract::<Val, soroban_sdk::Error>(
        &registry.address,
        &Symbol::new(&env, "__constructor"),
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
    let _ = beneficiary;
}

#[test]
fn admin_transfer_requires_accept_and_emits_events() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, _beneficiary, registry) = setup(&env);
    let new_admin = Address::generate(&env);

    registry.transfer_admin(&new_admin);
    // The event log only holds the most recent invocation, so assert
    // it before any getter calls.
    assert_last_event(
        &env,
        &registry.address,
        (symbol_short!("adm_xfer"), symbol_short!("proposed")),
        (admin.clone(), new_admin.clone()),
    );
    // Role has not moved yet; only a proposal exists.
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
    let stake_asset = Address::generate(&env);
    let slash_beneficiary = Address::generate(&env);
    let contract_id = env.register(
        ResolverRegistry,
        (admin.clone(), stake_asset, 0i128, slash_beneficiary),
    );
    let registry = ResolverRegistryClient::new(&env, &contract_id);
    let new_admin = Address::generate(&env);
    let stranger = Address::generate(&env);

    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "transfer_admin",
            args: (new_admin.clone(),).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    registry.transfer_admin(&new_admin);

    // A third party's auth cannot complete the transfer.
    env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "accept_admin",
            args: ().into_val(&env),
            sub_invokes: &[],
        },
    }]);
    assert!(registry.try_accept_admin().is_err());
    assert_eq!(registry.admin(), admin);

    // With the pending admin's auth it succeeds.
    env.mock_auths(&[MockAuth {
        address: &new_admin,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "accept_admin",
            args: ().into_val(&env),
            sub_invokes: &[],
        },
    }]);
    registry.accept_admin();
    assert_eq!(registry.admin(), new_admin);
}

#[test]
fn revoke_pending_admin_recovers_mistaken_transfer() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, _beneficiary, registry) = setup(&env);
    let wrong_address = Address::generate(&env);

    registry.transfer_admin(&wrong_address);
    registry.revoke_pending_admin();
    assert_last_event(
        &env,
        &registry.address,
        (symbol_short!("adm_xfer"), symbol_short!("revoked")),
        (admin.clone(), wrong_address),
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
fn admin_functions_stay_with_current_admin_mid_transfer() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let stake_asset = Address::generate(&env);
    let slash_beneficiary = Address::generate(&env);
    let contract_id = env.register(
        ResolverRegistry,
        (admin.clone(), stake_asset, 0i128, slash_beneficiary),
    );
    let registry = ResolverRegistryClient::new(&env, &contract_id);
    let new_admin = Address::generate(&env);

    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "transfer_admin",
            args: (new_admin.clone(),).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    registry.transfer_admin(&new_admin);

    // Mid-transfer, the pending admin's auth is not enough to touch
    // admin-gated config.
    env.mock_auths(&[MockAuth {
        address: &new_admin,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "set_min_stake",
            args: (5i128,).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    assert!(registry.try_set_min_stake(&5).is_err());

    // The current admin remains fully in control.
    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
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
    let (_admin, beneficiary, registry) = setup(&env);

    registry.set_min_stake(&50_0000000);
    assert_last_event(
        &env,
        &registry.address,
        (symbol_short!("cfg"), symbol_short!("min_stake")),
        (100_0000000i128, 50_0000000i128),
    );

    let new_beneficiary = Address::generate(&env);
    registry.set_slash_beneficiary(&new_beneficiary);
    assert_last_event(
        &env,
        &registry.address,
        (symbol_short!("cfg"), symbol_short!("slash_ben")),
        (beneficiary, new_beneficiary),
    );
}
