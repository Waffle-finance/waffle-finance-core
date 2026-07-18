#![cfg(test)]

use crate::{
    DataKey, Error, HtlcContract, HtlcContractClient, Order, OrderStatus,
    ASSUMED_MIN_LEDGER_TIME_SECS, FINALISED_ORDER_TTL_LEDGERS, INSTANCE_TTL_EXTEND_TO,
    INSTANCE_TTL_THRESHOLD, MAX_TIMELOCK_SECONDS, MIN_TIMELOCK_SECONDS,
    ORDER_TTL_MARGIN_LEDGERS,
};
use wafflefinance_resolver_registry::{ResolverRegistry, ResolverRegistryClient};
use soroban_sdk::{
    symbol_short,
    testutils::{
        storage::{Instance as _, Persistent as _},
        Address as _, Events, Ledger, LedgerInfo, MockAuth, MockAuthInvoke,
    },
    token::{StellarAssetClient, TokenClient},
    vec, Address, Bytes, BytesN, Env, IntoVal, Symbol, Val,
};

// -------------------------------------------------------------------------
// Shared helpers
// -------------------------------------------------------------------------

fn deploy_token<'a>(
    env: &Env,
    admin: &Address,
) -> (Address, StellarAssetClient<'a>, TokenClient<'a>) {
    let contract = env.register_stellar_asset_contract_v2(admin.clone());
    let address = contract.address();
    (
        address.clone(),
        StellarAssetClient::new(env, &address),
        TokenClient::new(env, &address),
    )
}

fn sha256_32(env: &Env, bytes: &Bytes) -> BytesN<32> {
    BytesN::<32>::from(env.crypto().sha256(bytes))
}

/// Deploy the HTLC with `mock_all_auths` already active.
fn setup(env: &Env, min_safety_deposit: i128) -> (Address, HtlcContractClient<'_>) {
    let admin = Address::generate(env);
    let contract_id = env.register(HtlcContract, (admin.clone(), min_safety_deposit));
    let client = HtlcContractClient::new(env, &contract_id);
    env.mock_all_auths();
    (admin, client)
}

/// Assert the last event in the current invocation's log.
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

fn advance_ledger(env: &Env, seconds: u64) {
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

fn advance_sequence(env: &Env, ledgers: u32) {
    env.ledger().with_mut(|li| {
        li.sequence_number += ledgers;
    });
}

fn order_ttl(env: &Env, htlc: &HtlcContractClient, order_id: u64) -> u32 {
    env.as_contract(&htlc.address, || {
        env.storage().persistent().get_ttl(&DataKey::Order(order_id))
    })
}

fn instance_ttl(env: &Env, htlc: &HtlcContractClient) -> u32 {
    env.as_contract(&htlc.address, || env.storage().instance().get_ttl())
}

fn keep_token_alive(env: &Env, asset: &Address, holders: &[&Address]) {
    const LONG: u32 = 5_000_000;
    env.as_contract(asset, || {
        env.storage().instance().extend_ttl(LONG, LONG);
        for holder in holders {
            let key = (Symbol::new(env, "Balance"), (*holder).clone());
            env.storage().persistent().extend_ttl(&key, LONG, LONG);
        }
    });
}

/// Create a funded order and return its id. Caller must have funds minted.
fn create_test_order(
    env: &Env,
    htlc: &HtlcContractClient,
    asset: &Address,
    sac: &StellarAssetClient,
    timelock_seconds: u64,
) -> u64 {
    let sender = Address::generate(env);
    let beneficiary = Address::generate(env);
    sac.mint(&sender, &100_0000000);
    let preimage = Bytes::from_array(env, &[21u8; 32]);
    let hashlock = sha256_32(env, &preimage);
    htlc.create_order(
        &sender,
        &beneficiary,
        &sender,
        asset,
        &10_0000000i128,
        &0i128,
        &hashlock,
        &timelock_seconds,
    )
}

fn setup_registry<'a>(
    env: &'a Env,
    stake_asset: &Address,
) -> (Address, ResolverRegistryClient<'a>, i128) {
    let registry_admin = Address::generate(env);
    let slash_beneficiary = Address::generate(env);
    let min_stake: i128 = 100_0000000;
    let registry_id = env.register(
        ResolverRegistry,
        (
            registry_admin,
            stake_asset.clone(),
            min_stake,
            slash_beneficiary,
        ),
    );
    let registry = ResolverRegistryClient::new(env, &registry_id);
    (registry_id, registry, min_stake)
}

// =========================================================================
// SECTION 1: Original happy-path and basic error tests (preserved exactly)
// =========================================================================

#[test]
fn happy_path_create_and_claim() {
    let env = Env::default();
    env.mock_all_auths();

    let asset_admin = Address::generate(&env);
    let (asset, sac, token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env, 0);

    let sender = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let relayer = Address::generate(&env);

    sac.mint(&sender, &1_000_0000000);

    let preimage = Bytes::from_array(&env, &[7u8; 32]);
    let hashlock = sha256_32(&env, &preimage);

    let amount = 500_0000000i128;
    let safety = 10_000_000i128;

    let order_id = htlc.create_order(
        &sender,
        &beneficiary,
        &sender,
        &asset,
        &amount,
        &safety,
        &hashlock,
        &600u64,
    );
    assert_eq!(order_id, 1);

    assert_eq!(token.balance(&sender), 1_000_0000000 - amount - safety);
    assert_eq!(token.balance(&htlc.address), amount + safety);

    htlc.claim_order(&order_id, &preimage, &relayer);

    assert_eq!(token.balance(&beneficiary), amount);
    assert_eq!(token.balance(&relayer), safety);
    assert_eq!(token.balance(&htlc.address), 0);

    let order: Order = htlc.get_order(&order_id).unwrap();
    assert_eq!(order.status, OrderStatus::Claimed);
    assert_eq!(order.preimage, preimage);
}

#[test]
fn refund_after_timeout_pays_refund_address() {
    let env = Env::default();
    env.mock_all_auths();
    let asset_admin = Address::generate(&env);
    let (asset, sac, token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env, 0);

    let sender = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let refund_to = Address::generate(&env);
    let cleaner = Address::generate(&env);

    sac.mint(&sender, &100_0000000);

    let preimage = Bytes::from_array(&env, &[1u8; 32]);
    let hashlock = sha256_32(&env, &preimage);

    let amount = 50_0000000i128;
    let safety = 1_000_000i128;
    let order_id = htlc.create_order(
        &sender,
        &beneficiary,
        &refund_to,
        &asset,
        &amount,
        &safety,
        &hashlock,
        &600u64,
    );

    let early = htlc.try_refund_order(&order_id, &cleaner);
    assert!(early.is_err());

    advance_ledger(&env, 601);
    htlc.refund_order(&order_id, &cleaner);

    assert_eq!(token.balance(&refund_to), amount);
    assert_eq!(token.balance(&cleaner), safety);
    assert_eq!(token.balance(&htlc.address), 0);

    let order: Order = htlc.get_order(&order_id).unwrap();
    assert_eq!(order.status, OrderStatus::Refunded);
}

#[test]
fn claim_with_wrong_preimage_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let asset_admin = Address::generate(&env);
    let (asset, sac, _token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env, 0);

    let sender = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    sac.mint(&sender, &100_0000000);

    let real_preimage = Bytes::from_array(&env, &[9u8; 32]);
    let hashlock = sha256_32(&env, &real_preimage);
    let order_id = htlc.create_order(
        &sender,
        &beneficiary,
        &sender,
        &asset,
        &10_0000000i128,
        &0i128,
        &hashlock,
        &600u64,
    );

    let wrong = Bytes::from_array(&env, &[8u8; 32]);
    let res = htlc.try_claim_order(&order_id, &wrong, &beneficiary);
    assert_eq!(res.err().unwrap().unwrap(), Error::InvalidPreimage.into());
}

#[test]
fn claim_after_expiry_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let asset_admin = Address::generate(&env);
    let (asset, sac, _token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env, 0);

    let sender = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    sac.mint(&sender, &100_0000000);

    let preimage = Bytes::from_array(&env, &[2u8; 32]);
    let hashlock = sha256_32(&env, &preimage);
    let order_id = htlc.create_order(
        &sender,
        &beneficiary,
        &sender,
        &asset,
        &10_0000000i128,
        &0i128,
        &hashlock,
        &600u64,
    );

    advance_ledger(&env, 601);
    let res = htlc.try_claim_order(&order_id, &preimage, &beneficiary);
    assert_eq!(res.err().unwrap().unwrap(), Error::Expired.into());
}

#[test]
fn double_claim_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let asset_admin = Address::generate(&env);
    let (asset, sac, _token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env, 0);

    let sender = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    sac.mint(&sender, &100_0000000);

    let preimage = Bytes::from_array(&env, &[3u8; 32]);
    let hashlock = sha256_32(&env, &preimage);
    let order_id = htlc.create_order(
        &sender,
        &beneficiary,
        &sender,
        &asset,
        &10_0000000i128,
        &0i128,
        &hashlock,
        &600u64,
    );

    htlc.claim_order(&order_id, &preimage, &beneficiary);
    let res = htlc.try_claim_order(&order_id, &preimage, &beneficiary);
    assert_eq!(res.err().unwrap().unwrap(), Error::OrderNotClaimable.into());
}

#[test]
fn refund_after_claim_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let asset_admin = Address::generate(&env);
    let (asset, sac, _token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env, 0);

    let sender = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    sac.mint(&sender, &100_0000000);

    let preimage = Bytes::from_array(&env, &[4u8; 32]);
    let hashlock = sha256_32(&env, &preimage);
    let order_id = htlc.create_order(
        &sender,
        &beneficiary,
        &sender,
        &asset,
        &10_0000000i128,
        &0i128,
        &hashlock,
        &600u64,
    );

    htlc.claim_order(&order_id, &preimage, &beneficiary);
    advance_ledger(&env, 601);
    let res = htlc.try_refund_order(&order_id, &beneficiary);
    assert_eq!(res.err().unwrap().unwrap(), Error::OrderNotRefundable.into());
}

#[test]
fn timelock_outside_bounds_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let asset_admin = Address::generate(&env);
    let (asset, sac, _token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env, 0);

    let sender = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    sac.mint(&sender, &100_0000000);

    let preimage = Bytes::from_array(&env, &[5u8; 32]);
    let hashlock = sha256_32(&env, &preimage);

    let too_short = htlc.try_create_order(
        &sender, &beneficiary, &sender, &asset,
        &10_0000000i128, &0i128, &hashlock, &10u64,
    );
    assert_eq!(too_short.err().unwrap().unwrap(), Error::InvalidTimelock.into());

    let too_long = htlc.try_create_order(
        &sender, &beneficiary, &sender, &asset,
        &10_0000000i128, &0i128, &hashlock, &200_000u64,
    );
    assert_eq!(too_long.err().unwrap().unwrap(), Error::InvalidTimelock.into());
}

#[test]
fn safety_deposit_minimum_enforced() {
    let env = Env::default();
    env.mock_all_auths();
    let asset_admin = Address::generate(&env);
    let (asset, sac, _token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env, 1_000_000);

    let sender = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    sac.mint(&sender, &100_0000000);

    let preimage = Bytes::from_array(&env, &[6u8; 32]);
    let hashlock = sha256_32(&env, &preimage);

    let res = htlc.try_create_order(
        &sender, &beneficiary, &sender, &asset,
        &10_0000000i128, &500_000i128, &hashlock, &600u64,
    );
    assert_eq!(res.err().unwrap().unwrap(), Error::SafetyDepositTooSmall.into());
}

#[test]
fn admin_can_update_min_safety_deposit() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, htlc) = setup(&env, 100);
    assert_eq!(htlc.min_safety_deposit(), 100);
    htlc.set_min_safety_deposit(&500);
    assert_eq!(htlc.min_safety_deposit(), 500);
}

#[test]
fn constructor_cannot_be_rerun_to_steal_admin() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, htlc) = setup(&env, 0);

    let attacker = Address::generate(&env);
    let res = env.try_invoke_contract::<Val, soroban_sdk::Error>(
        &htlc.address,
        &Symbol::new(&env, "__constructor"),
        vec![&env, attacker.into_val(&env), 0i128.into_val(&env)],
    );
    assert!(res.is_err());
    assert_eq!(htlc.admin(), admin);
}

// =========================================================================
// SECTION 2: NEW — Authorization enforcement (negative-auth tests)
//
// Every require_auth call site in lib.rs has a test proving that an
// unauthorized caller is rejected. These tests use selective mock_auths
// so the actual auth check fires.
// =========================================================================

/// create_order must reject a caller whose auth does not match `sender`.
#[test]
fn create_order_unauthorized_sender_rejected() {
    let env = Env::default();
    let asset_admin = Address::generate(&env);
    // Deploy contract WITHOUT mock_all_auths so we control auth selectively.
    let admin = Address::generate(&env);
    let contract_id = env.register(HtlcContract, (admin.clone(), 0i128));
    let htlc = HtlcContractClient::new(&env, &contract_id);

    let (asset, sac, _token) = deploy_token(&env, &asset_admin);
    let real_sender = Address::generate(&env);
    let attacker = Address::generate(&env);
    // Mint to real_sender so balance is not the failure cause.
    env.mock_all_auths();
    sac.mint(&real_sender, &100_0000000);
    // Clear mock so the next call uses real auth.
    let _ = env.mock_all_auths_allowing_non_root_auth();

    let preimage = Bytes::from_array(&env, &[50u8; 32]);
    let hashlock = sha256_32(&env, &preimage);

    // Provide auth only for `attacker`, not for `real_sender`.
    env.mock_auths(&[MockAuth {
        address: &attacker,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "create_order",
            args: (
                real_sender.clone(),
                attacker.clone(),
                real_sender.clone(),
                asset.clone(),
                10_0000000i128,
                0i128,
                hashlock.clone(),
                600u64,
            )
                .into_val(&env),
            sub_invokes: &[],
        },
    }]);

    let res = htlc.try_create_order(
        &real_sender,
        &attacker,
        &real_sender,
        &asset,
        &10_0000000i128,
        &0i128,
        &hashlock,
        &600u64,
    );
    assert!(res.is_err(), "create_order must fail when sender auth is absent");
}

/// claim_order must reject a caller whose auth does not match `caller`.
#[test]
fn claim_order_unauthorized_caller_rejected() {
    let env = Env::default();
    let asset_admin = Address::generate(&env);
    let admin = Address::generate(&env);
    let contract_id = env.register(HtlcContract, (admin.clone(), 0i128));
    let htlc = HtlcContractClient::new(&env, &contract_id);
    let (asset, sac, _token) = deploy_token(&env, &asset_admin);

    let sender = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let real_caller = Address::generate(&env);
    let attacker = Address::generate(&env);

    // Set up an order under mock_all_auths.
    env.mock_all_auths();
    sac.mint(&sender, &100_0000000);
    let preimage = Bytes::from_array(&env, &[51u8; 32]);
    let hashlock = sha256_32(&env, &preimage);
    let order_id = htlc.create_order(
        &sender, &beneficiary, &sender, &asset,
        &10_0000000i128, &0i128, &hashlock, &600u64,
    );

    // Now provide auth only for `attacker`, claiming as `real_caller`.
    env.mock_auths(&[MockAuth {
        address: &attacker,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "claim_order",
            args: (order_id, preimage.clone(), real_caller.clone()).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    let res = htlc.try_claim_order(&order_id, &preimage, &real_caller);
    assert!(res.is_err(), "claim_order must fail when caller auth is absent");
}

/// refund_order must reject a caller whose auth does not match `caller`.
#[test]
fn refund_order_unauthorized_caller_rejected() {
    let env = Env::default();
    let asset_admin = Address::generate(&env);
    let admin = Address::generate(&env);
    let contract_id = env.register(HtlcContract, (admin.clone(), 0i128));
    let htlc = HtlcContractClient::new(&env, &contract_id);
    let (asset, sac, _token) = deploy_token(&env, &asset_admin);

    let sender = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let real_caller = Address::generate(&env);
    let attacker = Address::generate(&env);

    env.mock_all_auths();
    sac.mint(&sender, &100_0000000);
    let preimage = Bytes::from_array(&env, &[52u8; 32]);
    let hashlock = sha256_32(&env, &preimage);
    let order_id = htlc.create_order(
        &sender, &beneficiary, &sender, &asset,
        &10_0000000i128, &0i128, &hashlock, &600u64,
    );
    advance_ledger(&env, 601);

    // Auth only for attacker, refunding as real_caller.
    env.mock_auths(&[MockAuth {
        address: &attacker,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "refund_order",
            args: (order_id, real_caller.clone()).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    let res = htlc.try_refund_order(&order_id, &real_caller);
    assert!(res.is_err(), "refund_order must fail when caller auth is absent");
}

/// set_resolver_registry must reject a non-admin caller.
#[test]
fn set_resolver_registry_non_admin_rejected() {
    let env = Env::default();
    let asset_admin = Address::generate(&env);
    let admin = Address::generate(&env);
    let contract_id = env.register(HtlcContract, (admin.clone(), 0i128));
    let htlc = HtlcContractClient::new(&env, &contract_id);
    let (asset, _sac, _token) = deploy_token(&env, &asset_admin);
    let (registry_id, _registry, _) = {
        env.mock_all_auths();
        setup_registry(&env, &asset)
    };

    let stranger = Address::generate(&env);
    env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "set_resolver_registry",
            args: (registry_id.clone(),).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    assert!(
        htlc.try_set_resolver_registry(&registry_id).is_err(),
        "set_resolver_registry must fail for non-admin"
    );
}

/// clear_resolver_registry must reject a non-admin caller.
#[test]
fn clear_resolver_registry_non_admin_rejected() {
    let env = Env::default();
    let asset_admin = Address::generate(&env);
    let admin = Address::generate(&env);
    let contract_id = env.register(HtlcContract, (admin.clone(), 0i128));
    let htlc = HtlcContractClient::new(&env, &contract_id);
    let (asset, _sac, _token) = deploy_token(&env, &asset_admin);

    // Bind a registry first so clearing is meaningful.
    env.mock_all_auths();
    let (registry_id, _registry, _) = setup_registry(&env, &asset);
    htlc.set_resolver_registry(&registry_id);

    let stranger = Address::generate(&env);
    env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "clear_resolver_registry",
            args: ().into_val(&env),
            sub_invokes: &[],
        },
    }]);
    assert!(
        htlc.try_clear_resolver_registry().is_err(),
        "clear_resolver_registry must fail for non-admin"
    );
    // Binding must still be intact.
    assert_eq!(htlc.resolver_registry(), Some(registry_id));
}

/// set_min_safety_deposit must reject a non-admin caller.
#[test]
fn set_min_safety_deposit_non_admin_rejected() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let contract_id = env.register(HtlcContract, (admin.clone(), 100i128));
    let htlc = HtlcContractClient::new(&env, &contract_id);

    let stranger = Address::generate(&env);
    env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "set_min_safety_deposit",
            args: (999i128,).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    assert!(
        htlc.try_set_min_safety_deposit(&999).is_err(),
        "set_min_safety_deposit must fail for non-admin"
    );
    assert_eq!(htlc.min_safety_deposit(), 100, "value must not change");
}

/// transfer_admin must reject a non-admin caller.
#[test]
fn transfer_admin_non_admin_rejected() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let contract_id = env.register(HtlcContract, (admin.clone(), 0i128));
    let htlc = HtlcContractClient::new(&env, &contract_id);

    let stranger = Address::generate(&env);
    let new_admin = Address::generate(&env);
    env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "transfer_admin",
            args: (new_admin.clone(),).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    assert!(
        htlc.try_transfer_admin(&new_admin).is_err(),
        "transfer_admin must fail for non-admin"
    );
    assert_eq!(htlc.pending_admin(), None, "no pending admin should be set");
}

// =========================================================================
// SECTION 3: NEW — Event assertions (exact topic + payload wire format)
//
// Each of the three core events is pinned: topics tuple, data tuple, and
// field types must match exactly what the backend indexes.
// =========================================================================

/// The `created` event must carry exact topics and payload.
///
/// Topics: (symbol!("created"), sender, beneficiary, hashlock)
/// Data:   (order_id: u64, asset: Address, amount: i128, safety_deposit: i128, timelock: u64)
#[test]
fn created_event_exact_topics_and_payload() {
    let env = Env::default();
    env.mock_all_auths();

    let asset_admin = Address::generate(&env);
    let (asset, sac, _token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env, 0);

    let sender = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    sac.mint(&sender, &100_0000000);

    let preimage = Bytes::from_array(&env, &[70u8; 32]);
    let hashlock = sha256_32(&env, &preimage);
    let amount = 10_0000000i128;
    let safety = 1_000_000i128;
    let timelock_seconds = 600u64;

    let now = env.ledger().timestamp();
    let expected_timelock = now + timelock_seconds;

    let order_id = htlc.create_order(
        &sender,
        &beneficiary,
        &sender,
        &asset,
        &amount,
        &safety,
        &hashlock,
        &timelock_seconds,
    );

    // Assert topics and data immediately — the event log is per-invocation.
    assert_last_event(
        &env,
        &htlc.address,
        // topics: (symbol, sender, beneficiary, hashlock)
        (symbol_short!("created"), sender.clone(), beneficiary.clone(), hashlock.clone()),
        // data: (order_id, asset, amount, safety_deposit, absolute_timelock)
        (order_id, asset.clone(), amount, safety, expected_timelock),
    );
}

/// The `claimed` event must carry exact topics and payload.
///
/// Topics: (symbol!("claimed"), beneficiary, hashlock)
/// Data:   (order_id: u64, caller: Address, preimage: Bytes, amount: i128, safety_deposit: i128)
#[test]
fn claimed_event_exact_topics_and_payload() {
    let env = Env::default();
    env.mock_all_auths();

    let asset_admin = Address::generate(&env);
    let (asset, sac, _token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env, 0);

    let sender = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let caller = Address::generate(&env);
    sac.mint(&sender, &100_0000000);

    let preimage = Bytes::from_array(&env, &[71u8; 32]);
    let hashlock = sha256_32(&env, &preimage);
    let amount = 20_0000000i128;
    let safety = 2_000_000i128;

    let order_id = htlc.create_order(
        &sender, &beneficiary, &sender, &asset,
        &amount, &safety, &hashlock, &600u64,
    );

    htlc.claim_order(&order_id, &preimage, &caller);

    assert_last_event(
        &env,
        &htlc.address,
        // topics: (symbol, beneficiary, hashlock)
        (symbol_short!("claimed"), beneficiary.clone(), hashlock.clone()),
        // data: (order_id, caller, preimage, amount, safety_deposit)
        (order_id, caller.clone(), preimage.clone(), amount, safety),
    );
}

/// The `refunded` event must carry exact topics and payload.
///
/// Topics: (symbol!("refunded"), refund_address, hashlock)
/// Data:   (order_id: u64, caller: Address, amount: i128, safety_deposit: i128)
#[test]
fn refunded_event_exact_topics_and_payload() {
    let env = Env::default();
    env.mock_all_auths();

    let asset_admin = Address::generate(&env);
    let (asset, sac, _token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env, 0);

    let sender = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let refund_address = Address::generate(&env);
    let caller = Address::generate(&env);
    sac.mint(&sender, &100_0000000);

    let preimage = Bytes::from_array(&env, &[72u8; 32]);
    let hashlock = sha256_32(&env, &preimage);
    let amount = 30_0000000i128;
    let safety = 3_000_000i128;

    let order_id = htlc.create_order(
        &sender, &beneficiary, &refund_address, &asset,
        &amount, &safety, &hashlock, &600u64,
    );

    advance_ledger(&env, 601);
    htlc.refund_order(&order_id, &caller);

    assert_last_event(
        &env,
        &htlc.address,
        // topics: (symbol, refund_address, hashlock)
        (symbol_short!("refunded"), refund_address.clone(), hashlock.clone()),
        // data: (order_id, caller, amount, safety_deposit)
        (order_id, caller.clone(), amount, safety),
    );
}

// =========================================================================
// SECTION 4: NEW — Timelock boundary tests
//
// Exact boundary values: 299 (invalid), 300 (valid), 86_400 (valid),
// 86_401 (invalid). These are the four fence-post cases the existing
// test skips.
// =========================================================================

#[test]
fn timelock_299_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let asset_admin = Address::generate(&env);
    let (asset, sac, _token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env, 0);
    let sender = Address::generate(&env);
    sac.mint(&sender, &100_0000000);
    let preimage = Bytes::from_array(&env, &[80u8; 32]);
    let hashlock = sha256_32(&env, &preimage);

    let res = htlc.try_create_order(
        &sender, &sender, &sender, &asset,
        &10_0000000i128, &0i128, &hashlock, &(MIN_TIMELOCK_SECONDS - 1),
    );
    assert_eq!(res.err().unwrap().unwrap(), Error::InvalidTimelock.into());
}

#[test]
fn timelock_300_accepted() {
    let env = Env::default();
    env.mock_all_auths();
    let asset_admin = Address::generate(&env);
    let (asset, sac, _token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env, 0);
    let sender = Address::generate(&env);
    sac.mint(&sender, &100_0000000);
    let preimage = Bytes::from_array(&env, &[81u8; 32]);
    let hashlock = sha256_32(&env, &preimage);

    let order_id = htlc.create_order(
        &sender, &sender, &sender, &asset,
        &10_0000000i128, &0i128, &hashlock, &MIN_TIMELOCK_SECONDS,
    );
    assert_eq!(order_id, 1);
}

#[test]
fn timelock_86400_accepted() {
    let env = Env::default();
    env.mock_all_auths();
    let asset_admin = Address::generate(&env);
    let (asset, sac, _token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env, 0);
    let sender = Address::generate(&env);
    sac.mint(&sender, &100_0000000);
    let preimage = Bytes::from_array(&env, &[82u8; 32]);
    let hashlock = sha256_32(&env, &preimage);

    let order_id = htlc.create_order(
        &sender, &sender, &sender, &asset,
        &10_0000000i128, &0i128, &hashlock, &MAX_TIMELOCK_SECONDS,
    );
    assert_eq!(order_id, 1);
}

#[test]
fn timelock_86401_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let asset_admin = Address::generate(&env);
    let (asset, sac, _token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env, 0);
    let sender = Address::generate(&env);
    sac.mint(&sender, &100_0000000);
    let preimage = Bytes::from_array(&env, &[83u8; 32]);
    let hashlock = sha256_32(&env, &preimage);

    let res = htlc.try_create_order(
        &sender, &sender, &sender, &asset,
        &10_0000000i128, &0i128, &hashlock, &(MAX_TIMELOCK_SECONDS + 1),
    );
    assert_eq!(res.err().unwrap().unwrap(), Error::InvalidTimelock.into());
}

// =========================================================================
// SECTION 5: NEW — Claim-vs-refund at exactly timestamp == timelock
//
// lib.rs:331 uses `>` for Expired  → claim is valid at timestamp == timelock
// lib.rs:384 uses `<=` for NotExpired → refund is invalid at timestamp == timelock
// =========================================================================

/// At timestamp == timelock, claim_order must SUCCEED (the preimage window
/// is still open: `timestamp > timelock` is false).
#[test]
fn claim_at_exactly_timelock_succeeds() {
    let env = Env::default();
    env.mock_all_auths();
    let asset_admin = Address::generate(&env);
    let (asset, sac, token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env, 0);

    let sender = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    sac.mint(&sender, &100_0000000);

    let preimage = Bytes::from_array(&env, &[84u8; 32]);
    let hashlock = sha256_32(&env, &preimage);
    let timelock_seconds = 600u64;
    let amount = 10_0000000i128;

    let order_id = htlc.create_order(
        &sender, &beneficiary, &sender, &asset,
        &amount, &0i128, &hashlock, &timelock_seconds,
    );

    // Advance exactly to the absolute timelock (timestamp + timelock_seconds).
    advance_ledger(&env, timelock_seconds);

    // claim must succeed — the window is still open.
    htlc.claim_order(&order_id, &preimage, &beneficiary);
    assert_eq!(token.balance(&beneficiary), amount);

    let order: Order = htlc.get_order(&order_id).unwrap();
    assert_eq!(order.status, OrderStatus::Claimed);
}

/// At timestamp == timelock, refund_order must FAIL (the timelock has not
/// yet *strictly* expired: `timestamp <= timelock` triggers NotExpired).
#[test]
fn refund_at_exactly_timelock_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let asset_admin = Address::generate(&env);
    let (asset, sac, _token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env, 0);

    let sender = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let caller = Address::generate(&env);
    sac.mint(&sender, &100_0000000);

    let preimage = Bytes::from_array(&env, &[85u8; 32]);
    let hashlock = sha256_32(&env, &preimage);
    let timelock_seconds = 600u64;

    let order_id = htlc.create_order(
        &sender, &beneficiary, &sender, &asset,
        &10_0000000i128, &0i128, &hashlock, &timelock_seconds,
    );

    // Advance exactly to the absolute timelock.
    advance_ledger(&env, timelock_seconds);

    // refund must fail — the timelock hasn't strictly passed yet.
    let res = htlc.try_refund_order(&order_id, &caller);
    assert_eq!(res.err().unwrap().unwrap(), Error::NotExpired.into());
}

// =========================================================================
// SECTION 6: NEW — InvalidAmount branches
//
// amount <= 0 (zero and negative) and safety_deposit < 0 each trigger
// Error::InvalidAmount from create_order.
// =========================================================================

#[test]
fn create_order_zero_amount_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let asset_admin = Address::generate(&env);
    let (asset, sac, _token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env, 0);
    let sender = Address::generate(&env);
    sac.mint(&sender, &100_0000000);
    let preimage = Bytes::from_array(&env, &[90u8; 32]);
    let hashlock = sha256_32(&env, &preimage);

    let res = htlc.try_create_order(
        &sender, &sender, &sender, &asset,
        &0i128, &0i128, &hashlock, &600u64,
    );
    assert_eq!(res.err().unwrap().unwrap(), Error::InvalidAmount.into());
}

#[test]
fn create_order_negative_amount_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let asset_admin = Address::generate(&env);
    let (asset, sac, _token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env, 0);
    let sender = Address::generate(&env);
    sac.mint(&sender, &100_0000000);
    let preimage = Bytes::from_array(&env, &[91u8; 32]);
    let hashlock = sha256_32(&env, &preimage);

    let res = htlc.try_create_order(
        &sender, &sender, &sender, &asset,
        &(-1i128), &0i128, &hashlock, &600u64,
    );
    assert_eq!(res.err().unwrap().unwrap(), Error::InvalidAmount.into());
}

#[test]
fn create_order_negative_safety_deposit_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let asset_admin = Address::generate(&env);
    let (asset, sac, _token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env, 0);
    let sender = Address::generate(&env);
    sac.mint(&sender, &100_0000000);
    let preimage = Bytes::from_array(&env, &[92u8; 32]);
    let hashlock = sha256_32(&env, &preimage);

    let res = htlc.try_create_order(
        &sender, &sender, &sender, &asset,
        &10_0000000i128, &(-1i128), &hashlock, &600u64,
    );
    assert_eq!(res.err().unwrap().unwrap(), Error::InvalidAmount.into());
}

/// Zero safety deposit is valid (== 0, which is >= 0).
#[test]
fn create_order_zero_safety_deposit_succeeds() {
    let env = Env::default();
    env.mock_all_auths();
    let asset_admin = Address::generate(&env);
    let (asset, sac, _token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env, 0);
    let sender = Address::generate(&env);
    sac.mint(&sender, &100_0000000);
    let preimage = Bytes::from_array(&env, &[93u8; 32]);
    let hashlock = sha256_32(&env, &preimage);

    let order_id = htlc.create_order(
        &sender, &sender, &sender, &asset,
        &10_0000000i128, &0i128, &hashlock, &600u64,
    );
    assert_eq!(order_id, 1);
}

// =========================================================================
// SECTION 7: NEW — OrderNotFound tests
//
// claim_order, refund_order, and get_order on a nonexistent id.
// =========================================================================

#[test]
fn claim_order_nonexistent_id_returns_not_found() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, htlc) = setup(&env, 0);

    let caller = Address::generate(&env);
    let preimage = Bytes::from_array(&env, &[95u8; 32]);

    let res = htlc.try_claim_order(&9999u64, &preimage, &caller);
    assert_eq!(res.err().unwrap().unwrap(), Error::OrderNotFound.into());
}

#[test]
fn refund_order_nonexistent_id_returns_not_found() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, htlc) = setup(&env, 0);

    let caller = Address::generate(&env);
    advance_ledger(&env, 86_401);

    let res = htlc.try_refund_order(&9999u64, &caller);
    assert_eq!(res.err().unwrap().unwrap(), Error::OrderNotFound.into());
}

#[test]
fn get_order_nonexistent_id_returns_none() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, htlc) = setup(&env, 0);

    assert!(
        htlc.get_order(&9999u64).is_none(),
        "get_order must return None for a nonexistent order"
    );
}

// =========================================================================
// SECTION 8: NEW — Zero-safety-deposit terminal flows
//
// When safety_deposit == 0, no second transfer should be attempted.
// Both claim and refund must complete normally with no safety deposit
// movement and correct final balances.
// =========================================================================

#[test]
fn claim_with_zero_safety_deposit_completes_normally() {
    let env = Env::default();
    env.mock_all_auths();
    let asset_admin = Address::generate(&env);
    let (asset, sac, token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env, 0);

    let sender = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let caller = Address::generate(&env);
    sac.mint(&sender, &100_0000000);

    let preimage = Bytes::from_array(&env, &[100u8; 32]);
    let hashlock = sha256_32(&env, &preimage);
    let amount = 10_0000000i128;

    let order_id = htlc.create_order(
        &sender, &beneficiary, &sender, &asset,
        &amount, &0i128, &hashlock, &600u64,
    );

    htlc.claim_order(&order_id, &preimage, &caller);

    // Beneficiary gets the amount; caller gets nothing (safety deposit = 0).
    assert_eq!(token.balance(&beneficiary), amount);
    assert_eq!(token.balance(&caller), 0);
    assert_eq!(token.balance(&htlc.address), 0);

    let order: Order = htlc.get_order(&order_id).unwrap();
    assert_eq!(order.status, OrderStatus::Claimed);
    assert_eq!(order.safety_deposit, 0);
}

#[test]
fn refund_with_zero_safety_deposit_completes_normally() {
    let env = Env::default();
    env.mock_all_auths();
    let asset_admin = Address::generate(&env);
    let (asset, sac, token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env, 0);

    let sender = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let refund_address = Address::generate(&env);
    let caller = Address::generate(&env);
    sac.mint(&sender, &100_0000000);

    let preimage = Bytes::from_array(&env, &[101u8; 32]);
    let hashlock = sha256_32(&env, &preimage);
    let amount = 10_0000000i128;

    let order_id = htlc.create_order(
        &sender, &beneficiary, &refund_address, &asset,
        &amount, &0i128, &hashlock, &600u64,
    );

    advance_ledger(&env, 601);
    htlc.refund_order(&order_id, &caller);

    // Refund address gets the amount; caller gets nothing.
    assert_eq!(token.balance(&refund_address), amount);
    assert_eq!(token.balance(&caller), 0);
    assert_eq!(token.balance(&htlc.address), 0);

    let order: Order = htlc.get_order(&order_id).unwrap();
    assert_eq!(order.status, OrderStatus::Refunded);
    assert_eq!(order.safety_deposit, 0);
}

// =========================================================================
// SECTION 9: NEW — Auth-shape test for create_order
//
// Guards against SDK upgrade regressions: verifies the full auth tree
// produced by create_order includes a token transfer sub-invocation
// from `sender`, proving the SAC allowance requirement is wired correctly.
// =========================================================================

/// create_order's auth tree must include a token.transfer sub-invocation
/// authorised by the sender. This test uses selective mock_auths with an
/// explicit sub-invoke specification; if the sub-invoke is removed (e.g.
/// by an SDK breaking change), the mock validation will fail with an
/// unmatched auth error.
#[test]
fn create_order_auth_tree_includes_token_transfer_sub_invocation() {
    let env = Env::default();
    let asset_admin = Address::generate(&env);

    // Deploy everything; we'll supply selective auth.
    let admin = Address::generate(&env);
    let contract_id = env.register(HtlcContract, (admin.clone(), 0i128));
    let htlc = HtlcContractClient::new(&env, &contract_id);

    // Mint token to sender via mock_all_auths, then switch to selective.
    env.mock_all_auths();
    let (asset, sac, token) = deploy_token(&env, &asset_admin);
    let sender = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let amount = 10_0000000i128;
    let total = amount; // safety_deposit = 0
    sac.mint(&sender, &100_0000000);

    let preimage = Bytes::from_array(&env, &[110u8; 32]);
    let hashlock = sha256_32(&env, &preimage);

    // Now supply the exact auth tree: create_order + transfer sub-invocation.
    env.mock_auths(&[MockAuth {
        address: &sender,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "create_order",
            args: (
                sender.clone(),
                beneficiary.clone(),
                sender.clone(),
                asset.clone(),
                amount,
                0i128,
                hashlock.clone(),
                600u64,
            )
                .into_val(&env),
            sub_invokes: &[MockAuthInvoke {
                contract: &asset,
                fn_name: "transfer",
                args: (sender.clone(), contract_id.clone(), total).into_val(&env),
                sub_invokes: &[],
            }],
        },
    }]);

    // This call must succeed with the exact auth tree above.
    let order_id = htlc.create_order(
        &sender,
        &beneficiary,
        &sender,
        &asset,
        &amount,
        &0i128,
        &hashlock,
        &600u64,
    );

    assert_eq!(order_id, 1);
    assert_eq!(token.balance(&htlc.address), amount);
}

/// Regression guard: if the sub-invocation is NOT in the auth tree,
/// the call must fail.
#[test]
fn create_order_auth_without_transfer_sub_invoke_is_rejected() {
    let env = Env::default();
    let asset_admin = Address::generate(&env);

    let admin = Address::generate(&env);
    let contract_id = env.register(HtlcContract, (admin.clone(), 0i128));
    let htlc = HtlcContractClient::new(&env, &contract_id);

    env.mock_all_auths();
    let (asset, sac, _token) = deploy_token(&env, &asset_admin);
    let sender = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    sac.mint(&sender, &100_0000000);
    let preimage = Bytes::from_array(&env, &[111u8; 32]);
    let hashlock = sha256_32(&env, &preimage);

    // Auth for create_order but NO transfer sub-invocation.
    env.mock_auths(&[MockAuth {
        address: &sender,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "create_order",
            args: (
                sender.clone(),
                beneficiary.clone(),
                sender.clone(),
                asset.clone(),
                10_0000000i128,
                0i128,
                hashlock.clone(),
                600u64,
            )
                .into_val(&env),
            // Intentionally no sub_invokes — the transfer auth is missing.
            sub_invokes: &[],
        },
    }]);

    let res = htlc.try_create_order(
        &sender,
        &beneficiary,
        &sender,
        &asset,
        &10_0000000i128,
        &0i128,
        &hashlock,
        &600u64,
    );
    assert!(
        res.is_err(),
        "create_order must fail when token transfer sub-invocation is not authorised"
    );
}

// =========================================================================
// SECTION 10: Resolver-registry binding (preserved + original tests)
// =========================================================================

#[test]
fn create_order_succeeds_for_active_registered_resolver() {
    let env = Env::default();
    env.mock_all_auths();

    let asset_admin = Address::generate(&env);
    let (asset, sac, token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env, 0);

    let (registry_id, registry, min_stake) = setup_registry(&env, &asset);
    htlc.set_resolver_registry(&registry_id);

    let resolver = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    sac.mint(&resolver, &(min_stake + 500_0000000));
    registry.register(&resolver, &min_stake);
    assert!(registry.is_active(&resolver));

    let preimage = Bytes::from_array(&env, &[42u8; 32]);
    let hashlock = sha256_32(&env, &preimage);

    let amount = 100_0000000i128;
    let order_id = htlc.create_order(
        &resolver, &beneficiary, &resolver, &asset,
        &amount, &0i128, &hashlock, &600u64,
    );
    assert_eq!(order_id, 1);
    assert_eq!(token.balance(&htlc.address), amount);

    let outsider = Address::generate(&env);
    htlc.claim_order(&order_id, &preimage, &outsider);
    let order: Order = htlc.get_order(&order_id).unwrap();
    assert_eq!(order.status, OrderStatus::Claimed);
}

#[test]
fn create_order_rejects_unregistered_sender_when_registry_is_set() {
    let env = Env::default();
    env.mock_all_auths();

    let asset_admin = Address::generate(&env);
    let (asset, sac, _token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env, 0);

    let (registry_id, _registry, _min_stake) = setup_registry(&env, &asset);
    htlc.set_resolver_registry(&registry_id);

    let stranger = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    sac.mint(&stranger, &100_0000000);

    let preimage = Bytes::from_array(&env, &[11u8; 32]);
    let hashlock = sha256_32(&env, &preimage);

    let res = htlc.try_create_order(
        &stranger, &beneficiary, &stranger, &asset,
        &10_0000000i128, &0i128, &hashlock, &600u64,
    );
    assert_eq!(
        res.err().unwrap().unwrap(),
        Error::ResolverNotAuthorised.into()
    );
}

#[test]
fn create_order_rejects_resolver_made_inactive_by_slash() {
    let env = Env::default();
    env.mock_all_auths();

    let asset_admin = Address::generate(&env);
    let (asset, sac, _token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env, 0);

    let (registry_id, registry, min_stake) = setup_registry(&env, &asset);
    htlc.set_resolver_registry(&registry_id);

    let resolver = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    sac.mint(&resolver, &(min_stake + 100_0000000));
    registry.register(&resolver, &min_stake);
    assert!(registry.is_active(&resolver));

    registry.slash(&resolver, &min_stake);
    assert!(!registry.is_active(&resolver));

    let preimage = Bytes::from_array(&env, &[12u8; 32]);
    let hashlock = sha256_32(&env, &preimage);
    let res = htlc.try_create_order(
        &resolver, &beneficiary, &resolver, &asset,
        &10_0000000i128, &0i128, &hashlock, &600u64,
    );
    assert_eq!(
        res.err().unwrap().unwrap(),
        Error::ResolverNotAuthorised.into()
    );
}

#[test]
fn clear_resolver_registry_restores_permissionless_create_order() {
    let env = Env::default();
    env.mock_all_auths();

    let asset_admin = Address::generate(&env);
    let (asset, sac, _token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env, 0);

    let (registry_id, _registry, _min_stake) = setup_registry(&env, &asset);
    htlc.set_resolver_registry(&registry_id);

    let stranger = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    sac.mint(&stranger, &100_0000000);

    let preimage = Bytes::from_array(&env, &[13u8; 32]);
    let hashlock = sha256_32(&env, &preimage);

    let blocked = htlc.try_create_order(
        &stranger, &beneficiary, &stranger, &asset,
        &10_0000000i128, &0i128, &hashlock, &600u64,
    );
    assert_eq!(
        blocked.err().unwrap().unwrap(),
        Error::ResolverNotAuthorised.into()
    );

    htlc.clear_resolver_registry();
    let order_id = htlc.create_order(
        &stranger, &beneficiary, &stranger, &asset,
        &10_0000000i128, &0i128, &hashlock, &600u64,
    );
    assert_eq!(order_id, 1);
}

// =========================================================================
// SECTION 11: State-archival (TTL) management (preserved + original tests)
// =========================================================================

#[test]
fn order_ttl_at_creation_covers_max_timelock_plus_margin() {
    let env = Env::default();
    env.mock_all_auths();
    let asset_admin = Address::generate(&env);
    let (asset, sac, _token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env, 0);

    let order_id = create_test_order(&env, &htlc, &asset, &sac, MAX_TIMELOCK_SECONDS);

    let ttl = order_ttl(&env, &htlc, order_id);
    let expected = (MAX_TIMELOCK_SECONDS / ASSUMED_MIN_LEDGER_TIME_SECS) as u32
        + ORDER_TTL_MARGIN_LEDGERS;
    assert!(ttl >= expected, "ttl {ttl} < expected {expected}");
    assert!(ttl as u64 * ASSUMED_MIN_LEDGER_TIME_SECS > MAX_TIMELOCK_SECONDS);
}

#[test]
fn order_ttl_scales_with_timelock() {
    let env = Env::default();
    env.mock_all_auths();
    let asset_admin = Address::generate(&env);
    let (asset, sac, _token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env, 0);

    let short = create_test_order(&env, &htlc, &asset, &sac, 600);
    let long = create_test_order(&env, &htlc, &asset, &sac, MAX_TIMELOCK_SECONDS);

    let short_ttl = order_ttl(&env, &htlc, short);
    let long_ttl = order_ttl(&env, &htlc, long);
    assert!(short_ttl >= ORDER_TTL_MARGIN_LEDGERS);
    let expected_gap = ((MAX_TIMELOCK_SECONDS - 600) / ASSUMED_MIN_LEDGER_TIME_SECS) as u32;
    assert_eq!(long_ttl - short_ttl, expected_gap);
}

#[test]
fn claim_and_refund_extend_terminal_order_ttl() {
    let env = Env::default();
    env.mock_all_auths();
    let asset_admin = Address::generate(&env);
    let (asset, sac, _token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env, 0);

    let sender = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    sac.mint(&sender, &100_0000000);

    let preimage = Bytes::from_array(&env, &[22u8; 32]);
    let hashlock = sha256_32(&env, &preimage);
    let claimed_id = htlc.create_order(
        &sender, &beneficiary, &sender, &asset,
        &10_0000000i128, &0i128, &hashlock, &600u64,
    );
    let refunded_id = htlc.create_order(
        &sender, &beneficiary, &sender, &asset,
        &10_0000000i128, &0i128, &hashlock, &600u64,
    );

    advance_sequence(&env, 10_000);
    assert!(order_ttl(&env, &htlc, claimed_id) < FINALISED_ORDER_TTL_LEDGERS);

    htlc.claim_order(&claimed_id, &preimage, &beneficiary);
    assert_eq!(order_ttl(&env, &htlc, claimed_id), FINALISED_ORDER_TTL_LEDGERS);

    advance_ledger(&env, 601);
    htlc.refund_order(&refunded_id, &beneficiary);
    assert_eq!(order_ttl(&env, &htlc, refunded_id), FINALISED_ORDER_TTL_LEDGERS);
}

#[test]
fn extend_order_ttl_keeps_live_order_alive() {
    let env = Env::default();
    env.mock_all_auths();
    let asset_admin = Address::generate(&env);
    let (asset, sac, _token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env, 0);

    let order_id = create_test_order(&env, &htlc, &asset, &sac, 600);
    let initial_ttl = order_ttl(&env, &htlc, order_id);

    advance_sequence(&env, initial_ttl - 100);
    assert_eq!(order_ttl(&env, &htlc, order_id), 100);

    htlc.extend_order_ttl(&order_id);
    assert_eq!(order_ttl(&env, &htlc, order_id), initial_ttl);
}

#[test]
fn extend_order_ttl_unknown_order_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, htlc) = setup(&env, 0);

    let res = htlc.try_extend_order_ttl(&999u64);
    assert_eq!(res.err().unwrap().unwrap(), Error::OrderNotFound.into());
}

#[test]
fn instance_ttl_extended_on_admin_setters() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, htlc) = setup(&env, 0);

    assert!(instance_ttl(&env, &htlc) >= INSTANCE_TTL_EXTEND_TO);

    let erosion = INSTANCE_TTL_EXTEND_TO - INSTANCE_TTL_THRESHOLD + 1;
    advance_sequence(&env, erosion);
    assert!(instance_ttl(&env, &htlc) < INSTANCE_TTL_THRESHOLD);
    htlc.set_min_safety_deposit(&1);
    assert_eq!(instance_ttl(&env, &htlc), INSTANCE_TTL_EXTEND_TO);

    advance_sequence(&env, erosion);
    let new_admin = Address::generate(&env);
    htlc.transfer_admin(&new_admin);
    assert_eq!(instance_ttl(&env, &htlc), INSTANCE_TTL_EXTEND_TO);

    advance_sequence(&env, erosion);
    htlc.accept_admin();
    assert_eq!(instance_ttl(&env, &htlc), INSTANCE_TTL_EXTEND_TO);
}

// =========================================================================
// SECTION 12: Governance — two-step admin transfer + events (preserved)
// =========================================================================

#[test]
fn admin_transfer_requires_accept_and_emits_events() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, htlc) = setup(&env, 0);
    let new_admin = Address::generate(&env);

    htlc.transfer_admin(&new_admin);
    assert_last_event(
        &env,
        &htlc.address,
        (symbol_short!("adm_xfer"), symbol_short!("proposed")),
        (admin.clone(), new_admin.clone()),
    );
    assert_eq!(htlc.admin(), admin);
    assert_eq!(htlc.pending_admin(), Some(new_admin.clone()));

    htlc.accept_admin();
    assert_last_event(
        &env,
        &htlc.address,
        (symbol_short!("adm_xfer"), symbol_short!("accepted")),
        (admin, new_admin.clone()),
    );
    assert_eq!(htlc.admin(), new_admin);
    assert_eq!(htlc.pending_admin(), None);
}

#[test]
fn accept_admin_requires_pending_admin_auth() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let contract_id = env.register(HtlcContract, (admin.clone(), 0i128));
    let htlc = HtlcContractClient::new(&env, &contract_id);
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
    htlc.transfer_admin(&new_admin);

    env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "accept_admin",
            args: ().into_val(&env),
            sub_invokes: &[],
        },
    }]);
    assert!(htlc.try_accept_admin().is_err());
    assert_eq!(htlc.admin(), admin);

    env.mock_auths(&[MockAuth {
        address: &new_admin,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "accept_admin",
            args: ().into_val(&env),
            sub_invokes: &[],
        },
    }]);
    htlc.accept_admin();
    assert_eq!(htlc.admin(), new_admin);
}

#[test]
fn revoke_pending_admin_recovers_mistaken_transfer() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, htlc) = setup(&env, 0);
    let wrong_address = Address::generate(&env);

    htlc.transfer_admin(&wrong_address);
    htlc.revoke_pending_admin();
    assert_last_event(
        &env,
        &htlc.address,
        (symbol_short!("adm_xfer"), symbol_short!("revoked")),
        (admin.clone(), wrong_address),
    );
    assert_eq!(htlc.pending_admin(), None);
    assert_eq!(htlc.admin(), admin);

    assert_eq!(
        htlc.try_accept_admin().err().unwrap().unwrap(),
        Error::NoPendingTransfer.into()
    );
    assert_eq!(
        htlc.try_revoke_pending_admin().err().unwrap().unwrap(),
        Error::NoPendingTransfer.into()
    );
}

#[test]
fn admin_functions_stay_with_current_admin_mid_transfer() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let contract_id = env.register(HtlcContract, (admin.clone(), 0i128));
    let htlc = HtlcContractClient::new(&env, &contract_id);
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
    htlc.transfer_admin(&new_admin);

    env.mock_auths(&[MockAuth {
        address: &new_admin,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "set_min_safety_deposit",
            args: (5i128,).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    assert!(htlc.try_set_min_safety_deposit(&5).is_err());

    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "set_min_safety_deposit",
            args: (7i128,).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    htlc.set_min_safety_deposit(&7);
    assert_eq!(htlc.min_safety_deposit(), 7);
}

#[test]
fn config_mutations_emit_events_with_old_and_new_values() {
    let env = Env::default();
    env.mock_all_auths();
    let asset_admin = Address::generate(&env);
    let (asset, _sac, _token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env, 100);

    htlc.set_min_safety_deposit(&500);
    assert_last_event(
        &env,
        &htlc.address,
        (symbol_short!("cfg"), symbol_short!("min_sd")),
        (100i128, 500i128),
    );

    let (registry_id, _registry, _min_stake) = setup_registry(&env, &asset);
    htlc.set_resolver_registry(&registry_id);
    assert_last_event(
        &env,
        &htlc.address,
        (symbol_short!("cfg"), symbol_short!("registry")),
        (None::<Address>, Some(registry_id.clone())),
    );

    htlc.clear_resolver_registry();
    assert_last_event(
        &env,
        &htlc.address,
        (symbol_short!("cfg"), symbol_short!("registry")),
        (Some(registry_id), None::<Address>),
    );
}

// =========================================================================
// SECTION 13: instance_ttl extended on create/claim/refund (preserved)
// =========================================================================

#[test]
fn instance_ttl_extended_on_create_claim_refund() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, htlc) = setup(&env, 0);

    let erosion = INSTANCE_TTL_EXTEND_TO - INSTANCE_TTL_THRESHOLD + 1;
    let half = erosion / 2;

    advance_sequence(&env, erosion);
    assert!(instance_ttl(&env, &htlc) < INSTANCE_TTL_THRESHOLD);

    let asset_admin = Address::generate(&env);
    let (asset, sac, _token) = deploy_token(&env, &asset_admin);
    let sender = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    sac.mint(&sender, &100_0000000);

    let preimage = Bytes::from_array(&env, &[24u8; 32]);
    let hashlock = sha256_32(&env, &preimage);
    let claimed_id = htlc.create_order(
        &sender, &beneficiary, &sender, &asset,
        &10_0000000i128, &0i128, &hashlock, &MAX_TIMELOCK_SECONDS,
    );
    assert_eq!(instance_ttl(&env, &htlc), INSTANCE_TTL_EXTEND_TO);
    let refunded_id = htlc.create_order(
        &sender, &beneficiary, &sender, &asset,
        &10_0000000i128, &0i128, &hashlock, &600u64,
    );
    keep_token_alive(&env, &asset, &[&sender, &htlc.address]);

    advance_sequence(&env, half);
    htlc.extend_order_ttl(&claimed_id);
    htlc.extend_order_ttl(&refunded_id);
    advance_sequence(&env, erosion - half);
    assert!(instance_ttl(&env, &htlc) < INSTANCE_TTL_THRESHOLD);
    htlc.claim_order(&claimed_id, &preimage, &beneficiary);
    assert_eq!(instance_ttl(&env, &htlc), INSTANCE_TTL_EXTEND_TO);

    htlc.extend_order_ttl(&refunded_id);
    advance_ledger(&env, 601);
    advance_sequence(&env, half);
    htlc.extend_order_ttl(&refunded_id);
    advance_sequence(&env, erosion - half);
    assert!(instance_ttl(&env, &htlc) < INSTANCE_TTL_THRESHOLD);
    let cleaner = Address::generate(&env);
    htlc.refund_order(&refunded_id, &cleaner);
    assert_eq!(instance_ttl(&env, &htlc), INSTANCE_TTL_EXTEND_TO);
}

// =========================================================================
// SECTION 14: NEW — Additional governance auth tests
//
// revoke_pending_admin and transfer_admin must reject non-admin callers.
// =========================================================================

#[test]
fn revoke_pending_admin_non_admin_rejected() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let contract_id = env.register(HtlcContract, (admin.clone(), 0i128));
    let htlc = HtlcContractClient::new(&env, &contract_id);
    let new_admin = Address::generate(&env);
    let stranger = Address::generate(&env);

    // Set up a real pending transfer.
    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "transfer_admin",
            args: (new_admin.clone(),).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    htlc.transfer_admin(&new_admin);
    assert_eq!(htlc.pending_admin(), Some(new_admin.clone()));

    // Stranger cannot revoke.
    env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &contract_id,
            fn_name: "revoke_pending_admin",
            args: ().into_val(&env),
            sub_invokes: &[],
        },
    }]);
    assert!(
        htlc.try_revoke_pending_admin().is_err(),
        "revoke_pending_admin must fail for non-admin"
    );
    // Pending admin must still be set.
    assert_eq!(htlc.pending_admin(), Some(new_admin));
}

// =========================================================================
// SECTION 15: NEW — set_min_safety_deposit edge-cases
//
// Negative new_minimum must be rejected; zero is valid.
// =========================================================================

#[test]
fn set_min_safety_deposit_negative_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, htlc) = setup(&env, 100);

    let res = htlc.try_set_min_safety_deposit(&(-1i128));
    assert_eq!(res.err().unwrap().unwrap(), Error::InvalidAmount.into());
    assert_eq!(htlc.min_safety_deposit(), 100, "value must not change");
}

#[test]
fn set_min_safety_deposit_zero_is_valid() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, htlc) = setup(&env, 100);

    htlc.set_min_safety_deposit(&0);
    assert_eq!(htlc.min_safety_deposit(), 0);
}

// =========================================================================
// SECTION 16: NEW — Multiple order sequencing
//
// IDs must be monotonically increasing across orders; each order is
// independent so one claim must not affect a sibling.
// =========================================================================

#[test]
fn order_ids_are_monotonically_increasing() {
    let env = Env::default();
    env.mock_all_auths();
    let asset_admin = Address::generate(&env);
    let (asset, sac, _token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env, 0);

    let sender = Address::generate(&env);
    sac.mint(&sender, &1_000_0000000);

    for expected_id in 1u64..=5 {
        let preimage = Bytes::from_array(&env, &[expected_id as u8; 32]);
        let hashlock = sha256_32(&env, &preimage);
        let id = htlc.create_order(
            &sender, &sender, &sender, &asset,
            &1_0000000i128, &0i128, &hashlock, &600u64,
        );
        assert_eq!(id, expected_id, "expected id {expected_id}, got {id}");
    }
    assert_eq!(htlc.next_order_id(), 6);
}

#[test]
fn claiming_one_order_does_not_affect_sibling() {
    let env = Env::default();
    env.mock_all_auths();
    let asset_admin = Address::generate(&env);
    let (asset, sac, token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env, 0);

    let sender = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    sac.mint(&sender, &100_0000000);

    let preimage_a = Bytes::from_array(&env, &[120u8; 32]);
    let hashlock_a = sha256_32(&env, &preimage_a);
    let preimage_b = Bytes::from_array(&env, &[121u8; 32]);
    let hashlock_b = sha256_32(&env, &preimage_b);
    let amount = 10_0000000i128;

    let id_a = htlc.create_order(
        &sender, &beneficiary, &sender, &asset,
        &amount, &0i128, &hashlock_a, &600u64,
    );
    let id_b = htlc.create_order(
        &sender, &beneficiary, &sender, &asset,
        &amount, &0i128, &hashlock_b, &600u64,
    );

    htlc.claim_order(&id_a, &preimage_a, &beneficiary);

    // Order B must still be in Funded state.
    let order_b: Order = htlc.get_order(&id_b).unwrap();
    assert_eq!(order_b.status, OrderStatus::Funded);
    // Contract still holds order B's funds.
    assert_eq!(token.balance(&htlc.address), amount);
}
