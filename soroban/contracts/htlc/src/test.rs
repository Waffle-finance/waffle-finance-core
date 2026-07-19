
#![cfg(test)]

use crate::{
    DataKey, Error, HtlcContract, HtlcContractClient, Order, OrderStatus,
    ASSUMED_MIN_LEDGER_TIME_SECS, FINALISED_ORDER_TTL_LEDGERS, INSTANCE_TTL_EXTEND_TO,
    INSTANCE_TTL_THRESHOLD, MAX_TIMELOCK_SECONDS, ORDER_TTL_MARGIN_LEDGERS,
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

fn deploy_token<'a>(env: &Env, admin: &Address) -> (Address, StellarAssetClient<'a>, TokenClient<'a>) {
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

fn setup(env: &Env, min_safety_deposit: i128) -> (Address, HtlcContractClient<'_>) {
    let admin = Address::generate(env);
    // Deploy + configure atomically via the constructor.
    let contract_id = env.register(HtlcContract, (admin.clone(), min_safety_deposit));
    let client = HtlcContractClient::new(env, &contract_id);
    env.mock_all_auths();
    (admin, client)
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

    sac.mint(&sender, &1_000_0000000); // 1000 XLM in stroops

    let preimage = Bytes::from_array(&env, &[7u8; 32]);
    let hashlock = sha256_32(&env, &preimage);

    let amount = 500_0000000i128; // 500 XLM
    let safety = 10_000_000i128; //   1 XLM

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

    // Sender lost amount + safety; contract holds them.
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
        &sender,
        &beneficiary,
        &sender,
        &asset,
        &10_0000000i128,
        &0i128,
        &hashlock,
        &10u64,
    );
    assert_eq!(too_short.err().unwrap().unwrap(), Error::InvalidTimelock.into());

    let too_long = htlc.try_create_order(
        &sender,
        &beneficiary,
        &sender,
        &asset,
        &10_0000000i128,
        &0i128,
        &hashlock,
        &200_000u64,
    );
    assert_eq!(too_long.err().unwrap().unwrap(), Error::InvalidTimelock.into());
}

#[test]
fn safety_deposit_minimum_enforced() {
    let env = Env::default();
    env.mock_all_auths();
    let asset_admin = Address::generate(&env);
    let (asset, sac, _token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env, 1_000_000); // 0.1 XLM minimum

    let sender = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    sac.mint(&sender, &100_0000000);

    let preimage = Bytes::from_array(&env, &[6u8; 32]);
    let hashlock = sha256_32(&env, &preimage);

    let res = htlc.try_create_order(
        &sender,
        &beneficiary,
        &sender,
        &asset,
        &10_0000000i128,
        &500_000i128, // below the configured minimum
        &hashlock,
        &600u64,
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
    // The old post-deploy `initialize` could be front-run by anyone.
    // With the constructor, configuration is atomic with deployment
    // and there is no invocable (re-)initialisation entry point.
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

// ---------------------------------------------------------------------
// Resolver-registry binding (cross-contract enforcement of `is_active`)
// ---------------------------------------------------------------------

/// Deploy + initialise a ResolverRegistry next to the HTLC, using the
/// same SAC asset for stake. Returns the registry client and the
/// minimum stake value used.
fn setup_registry<'a>(
    env: &'a Env,
    stake_asset: &Address,
) -> (Address, ResolverRegistryClient<'a>, i128) {
    let registry_admin = Address::generate(env);
    let slash_beneficiary = Address::generate(env);
    let min_stake: i128 = 100_0000000; // 100 stake-asset units
    // unbonding_period must be >= MIN_UNBONDING_PERIOD_SECS (86 400 s).
    let unbonding_period: u64 = wafflefinance_resolver_registry::MIN_UNBONDING_PERIOD_SECS;
    let registry_id = env.register(
        ResolverRegistry,
        (
            registry_admin,
            stake_asset.clone(),
            min_stake,
            slash_beneficiary,
            unbonding_period,
        ),
    );
    let registry = ResolverRegistryClient::new(env, &registry_id);
    (registry_id, registry, min_stake)
}

#[test]
fn create_order_succeeds_for_active_registered_resolver() {
    let env = Env::default();
    env.mock_all_auths();

    let asset_admin = Address::generate(&env);
    let (asset, sac, token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env, 0);

    let (registry_id, registry, min_stake) = setup_registry(&env, &asset);
    htlc.set_resolver_registry(&registry_id);

    // Fund and register the resolver as an active staker.
    let resolver = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    sac.mint(&resolver, &(min_stake + 500_0000000));
    registry.register(&resolver, &min_stake);
    assert!(registry.is_active(&resolver));

    let preimage = Bytes::from_array(&env, &[42u8; 32]);
    let hashlock = sha256_32(&env, &preimage);

    let amount = 100_0000000i128;
    let order_id = htlc.create_order(
        &resolver,
        &beneficiary,
        &resolver,
        &asset,
        &amount,
        &0i128,
        &hashlock,
        &600u64,
    );
    assert_eq!(order_id, 1);
    assert_eq!(token.balance(&htlc.address), amount);

    // Claim path must remain permissionless even though the registry is
    // configured ΓÇö the registry only gates create_order.
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

    // `stranger` was never registered with the registry.
    let stranger = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    sac.mint(&stranger, &100_0000000);

    let preimage = Bytes::from_array(&env, &[11u8; 32]);
    let hashlock = sha256_32(&env, &preimage);

    let res = htlc.try_create_order(
        &stranger,
        &beneficiary,
        &stranger,
        &asset,
        &10_0000000i128,
        &0i128,
        &hashlock,
        &600u64,
    );
    assert_eq!(
        res.err().unwrap().unwrap(),
        Error::ResolverNotAuthorised.into()
    );
}

#[test]
fn create_order_rejects_resolver_made_inactive_by_slash() {
    // A resolver whose stake is slashed below the minimum is marked
    // inactive by the registry. The HTLC must consult the live state on
    // every create_order, not a cached snapshot.
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

    // Slash the full stake ΓÇö registry drops the resolver below the
    // minimum and flips `active` to false.
    registry.slash(&resolver, &min_stake);
    assert!(!registry.is_active(&resolver));

    let preimage = Bytes::from_array(&env, &[12u8; 32]);
    let hashlock = sha256_32(&env, &preimage);
    let res = htlc.try_create_order(
        &resolver,
        &beneficiary,
        &resolver,
        &asset,
        &10_0000000i128,
        &0i128,
        &hashlock,
        &600u64,
    );
    assert_eq!(
        res.err().unwrap().unwrap(),
        Error::ResolverNotAuthorised.into()
    );
}

#[test]
fn clear_resolver_registry_restores_permissionless_create_order() {
    // After clear_resolver_registry the HTLC must accept any sender
    // again ΓÇö proves the binding is dynamic, not baked in at deploy.
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

    // Blocked while registry is bound.
    let blocked = htlc.try_create_order(
        &stranger,
        &beneficiary,
        &stranger,
        &asset,
        &10_0000000i128,
        &0i128,
        &hashlock,
        &600u64,
    );
    assert_eq!(
        blocked.err().unwrap().unwrap(),
        Error::ResolverNotAuthorised.into()
    );

    // Admin clears the binding; the HTLC stays correct (hashlock +
    // timelock still gate funds) and create_order becomes open again.
    htlc.clear_resolver_registry();
    let order_id = htlc.create_order(
        &stranger,
        &beneficiary,
        &stranger,
        &asset,
        &10_0000000i128,
        &0i128,
        &hashlock,
        &600u64,
    );
    assert_eq!(order_id, 1);
}

// ---------------------------------------------------------------------
// State-archival (TTL) management
// ---------------------------------------------------------------------

/// Advance only the ledger sequence number (TTLs are denominated in
/// ledgers, so this is what erodes an entry's remaining TTL).
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

/// Keep the SAC token's own ledger entries alive across large sequence
/// jumps. The test env archives the token's instance and balance
/// entries like any other entry, which would make transfers fail for
/// reasons unrelated to the HTLC under test. The balance key mirrors
/// the built-in SAC's `DataKey::Balance(Address)` encoding.
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

/// Create a funded order with the given timelock and return its id.
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

#[test]
fn order_ttl_at_creation_covers_max_timelock_plus_margin() {
    let env = Env::default();
    env.mock_all_auths();
    let asset_admin = Address::generate(&env);
    let (asset, sac, _token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env, 0);

    let order_id = create_test_order(&env, &htlc, &asset, &sac, MAX_TIMELOCK_SECONDS);

    let ttl = order_ttl(&env, &htlc, order_id);
    // The entry must stay live for the full timelock (converted at the
    // conservative close time) plus the safety margin.
    let expected = (MAX_TIMELOCK_SECONDS / ASSUMED_MIN_LEDGER_TIME_SECS) as u32
        + ORDER_TTL_MARGIN_LEDGERS;
    assert!(ttl >= expected, "ttl {ttl} < expected {expected}");
    // Sanity: the covered wall-clock time exceeds the timelock itself.
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
    // A longer timelock buys a proportionally longer entry TTL ΓÇö the
    // TTL is not a fixed creation-time constant.
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
        &sender,
        &beneficiary,
        &sender,
        &asset,
        &10_0000000i128,
        &0i128,
        &hashlock,
        &600u64,
    );
    let refunded_id = htlc.create_order(
        &sender,
        &beneficiary,
        &sender,
        &asset,
        &10_0000000i128,
        &0i128,
        &hashlock,
        &600u64,
    );

    // Erode some TTL so the terminal extension is observable.
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

    // Burn most of the entry's TTL without advancing wall-clock time,
    // then let a third party bump it back.
    advance_sequence(&env, initial_ttl - 100);
    assert_eq!(order_ttl(&env, &htlc, order_id), 100);

    htlc.extend_order_ttl(&order_id);
    // The order is still funded with its full timelock remaining, so
    // the keep-alive restores the creation-sized TTL.
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

    // initialize itself extends the instance TTL.
    assert!(instance_ttl(&env, &htlc) >= INSTANCE_TTL_EXTEND_TO);

    // Erode the instance TTL to below the refresh threshold; each admin
    // setter must bump it back to the full target.
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

// ---------------------------------------------------------------------
// Governance: two-step admin transfer + admin/config events
// ---------------------------------------------------------------------

#[test]
fn admin_transfer_requires_accept_and_emits_events() {
    let env = Env::default();
    env.mock_all_auths();
    let (admin, htlc) = setup(&env, 0);
    let new_admin = Address::generate(&env);

    htlc.transfer_admin(&new_admin);
    // The event log only holds the most recent invocation, so assert
    // it before any getter calls.
    assert_last_event(
        &env,
        &htlc.address,
        (symbol_short!("adm_xfer"), symbol_short!("proposed")),
        (admin.clone(), new_admin.clone()),
    );
    // Role has not moved yet; only a proposal exists.
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

    // A third party's auth cannot complete the transfer: accept_admin
    // demands require_auth from the pending admin itself.
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

    // Nothing left to accept or revoke.
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

    // Mid-transfer, the pending admin's auth is not enough to touch
    // admin-gated config.
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

    // The current admin remains fully in control.
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

#[test]
fn instance_ttl_extended_on_create_claim_refund() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, htlc) = setup(&env, 0);

    let erosion = INSTANCE_TTL_EXTEND_TO - INSTANCE_TTL_THRESHOLD + 1;
    let half = erosion / 2;

    // --- create_order refreshes an instance below the threshold ---
    advance_sequence(&env, erosion);
    assert!(instance_ttl(&env, &htlc) < INSTANCE_TTL_THRESHOLD);

    // The token is deployed only now, so its entries are fresh.
    let asset_admin = Address::generate(&env);
    let (asset, sac, _token) = deploy_token(&env, &asset_admin);
    let sender = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    sac.mint(&sender, &100_0000000);

    let preimage = Bytes::from_array(&env, &[24u8; 32]);
    let hashlock = sha256_32(&env, &preimage);
    let claimed_id = htlc.create_order(
        &sender,
        &beneficiary,
        &sender,
        &asset,
        &10_0000000i128,
        &0i128,
        &hashlock,
        &MAX_TIMELOCK_SECONDS,
    );
    assert_eq!(instance_ttl(&env, &htlc), INSTANCE_TTL_EXTEND_TO);
    let refunded_id = htlc.create_order(
        &sender,
        &beneficiary,
        &sender,
        &asset,
        &10_0000000i128,
        &0i128,
        &hashlock,
        &600u64,
    );
    keep_token_alive(&env, &asset, &[&sender, &htlc.address]);

    // --- claim_order refreshes an instance below the threshold ---
    // Erode in two steps with permissionless keep-alives in between so
    // the order entries survive while the instance TTL crosses the
    // threshold. The mid-cycle keep-alives run with the instance still
    // above the threshold, so they don't refresh it themselves.
    advance_sequence(&env, half);
    htlc.extend_order_ttl(&claimed_id);
    htlc.extend_order_ttl(&refunded_id);
    advance_sequence(&env, erosion - half);
    assert!(instance_ttl(&env, &htlc) < INSTANCE_TTL_THRESHOLD);
    htlc.claim_order(&claimed_id, &preimage, &beneficiary);
    assert_eq!(instance_ttl(&env, &htlc), INSTANCE_TTL_EXTEND_TO);

    // --- refund_order refreshes an instance below the threshold ---
    htlc.extend_order_ttl(&refunded_id);
    advance_ledger(&env, 601); // expire the 600 s order
    advance_sequence(&env, half);
    htlc.extend_order_ttl(&refunded_id);
    advance_sequence(&env, erosion - half);
    assert!(instance_ttl(&env, &htlc) < INSTANCE_TTL_THRESHOLD);
    let cleaner = Address::generate(&env);
    htlc.refund_order(&refunded_id, &cleaner);
    assert_eq!(instance_ttl(&env, &htlc), INSTANCE_TTL_EXTEND_TO);
}


// ---------------------------------------------------------------------
// Cross-contract: unbonding resolver is rejected by create_order
// (Acceptance criterion: request_unregister immediately sets
//  is_active == false and HTLC rejects the resolver.)
// ---------------------------------------------------------------------

#[test]
fn create_order_rejects_resolver_who_requested_unregistration() {
    // A resolver that has called request_unregister is inactive, so
    // the HTLC must reject them even while their stake is still locked
    // in the registry during the unbonding window.
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

    // The resolver initiates exit — this immediately flips is_active
    // to false in the registry.
    registry.request_unregister(&resolver);
    assert!(!registry.is_active(&resolver));

    let preimage = Bytes::from_array(&env, &[99u8; 32]);
    let hashlock = sha256_32(&env, &preimage);

    // HTLC create_order must now reject the resolver.
    let res = htlc.try_create_order(
        &resolver,
        &beneficiary,
        &resolver,
        &asset,
        &10_0000000i128,
        &0i128,
        &hashlock,
        &600u64,
    );
    assert_eq!(
        res.err().unwrap().unwrap(),
        Error::ResolverNotAuthorised.into(),
        "HTLC must reject a resolver that has requested unregistration"
    );
}

// =====================================================================
// AUTH ENFORCEMENT — negative tests using selective mock_auths
// Every require_auth call site in lib.rs has a failing-path test here.
// =====================================================================

// Helper: build a contract with no mock (auth checking is live).
fn setup_no_mock(env: &Env, min_safety_deposit: i128) -> (Address, HtlcContractClient<'_>) {
    let admin = Address::generate(env);
    let contract_id = env.register(HtlcContract, (admin.clone(), min_safety_deposit));
    (admin, HtlcContractClient::new(env, &contract_id))
}



// ---------------------------------------------------------------------
// create_order: sender.require_auth()
// ---------------------------------------------------------------------

#[test]
fn create_order_requires_sender_auth() {
    let env = Env::default();
    let asset_admin = Address::generate(&env);
    let (asset, sac, _token) = deploy_token(&env, &asset_admin);
    let (admin, htlc) = setup_no_mock(&env, 0);
    let sender = Address::generate(&env);
    let beneficiary = Address::generate(&env);

    // Mint tokens — the SAC mint itself needs admin auth.
    env.mock_auths(&[MockAuth {
        address: &asset_admin,
        invoke: &MockAuthInvoke {
            contract: &asset,
            fn_name: "mint",
            args: (sender.clone(), 100_0000000i128).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    sac.mint(&sender, &100_0000000);

    let preimage = Bytes::from_array(&env, &[30u8; 32]);
    let hashlock = sha256_32(&env, &preimage);

    // Attempt create_order with a STRANGER's auth — must fail.
    let stranger = Address::generate(&env);
    env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &htlc.address,
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
            sub_invokes: &[],
        },
    }]);
    let res = htlc.try_create_order(
        &sender, &beneficiary, &sender, &asset,
        &10_0000000i128, &0i128, &hashlock, &600u64,
    );
    assert!(res.is_err(), "create_order must reject when sender auth is absent");
    // Admin state must be intact.
    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &htlc.address,
            fn_name: "admin",
            args: ().into_val(&env),
            sub_invokes: &[],
        },
    }]);
    assert_eq!(htlc.admin(), admin);
}

// ---------------------------------------------------------------------
// claim_order: caller.require_auth()
// ---------------------------------------------------------------------

#[test]
fn claim_order_requires_caller_auth() {
    // Set up order with mock_all, then remove auth and prove claim fails.
    let env = Env::default();
    env.mock_all_auths();
    let asset_admin = Address::generate(&env);
    let (asset, sac, _token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env, 0);
    let sender = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    sac.mint(&sender, &100_0000000);

    let preimage = Bytes::from_array(&env, &[31u8; 32]);
    let hashlock = sha256_32(&env, &preimage);
    let order_id = htlc.create_order(
        &sender, &beneficiary, &sender, &asset,
        &10_0000000i128, &0i128, &hashlock, &600u64,
    );

    // Now try to claim with a stranger's auth (not the intended caller).
    let stranger = Address::generate(&env);
    let caller = Address::generate(&env);
    env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &htlc.address,
            fn_name: "claim_order",
            args: (order_id, preimage.clone(), caller.clone()).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    let res = htlc.try_claim_order(&order_id, &preimage, &caller);
    assert!(res.is_err(), "claim_order must fail when caller auth is absent");
}

// ---------------------------------------------------------------------
// refund_order: caller.require_auth()
// ---------------------------------------------------------------------

#[test]
fn refund_order_requires_caller_auth() {
    let env = Env::default();
    env.mock_all_auths();
    let asset_admin = Address::generate(&env);
    let (asset, sac, _token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env, 0);
    let sender = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    sac.mint(&sender, &100_0000000);

    let preimage = Bytes::from_array(&env, &[32u8; 32]);
    let hashlock = sha256_32(&env, &preimage);
    let order_id = htlc.create_order(
        &sender, &beneficiary, &sender, &asset,
        &10_0000000i128, &0i128, &hashlock, &600u64,
    );
    advance_ledger(&env, 601);

    let stranger = Address::generate(&env);
    let caller = Address::generate(&env);
    env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &htlc.address,
            fn_name: "refund_order",
            args: (order_id, caller.clone()).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    let res = htlc.try_refund_order(&order_id, &caller);
    assert!(res.is_err(), "refund_order must fail when caller auth is absent");
}

// ---------------------------------------------------------------------
// Admin-gated functions: non-admin must be rejected
// ---------------------------------------------------------------------

#[test]
fn set_min_safety_deposit_requires_admin_auth() {
    let env = Env::default();
    let (admin, htlc) = setup_no_mock(&env, 0);
    let stranger = Address::generate(&env);

    // Stranger's auth — must fail.
    env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &htlc.address,
            fn_name: "set_min_safety_deposit",
            args: (500i128,).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    assert!(htlc.try_set_min_safety_deposit(&500).is_err());

    // Admin's auth — must succeed.
    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &htlc.address,
            fn_name: "set_min_safety_deposit",
            args: (500i128,).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    htlc.set_min_safety_deposit(&500);
    env.mock_all_auths();
    assert_eq!(htlc.min_safety_deposit(), 500);
}

#[test]
fn set_resolver_registry_requires_admin_auth() {
    let env = Env::default();
    let (admin, htlc) = setup_no_mock(&env, 0);
    let stranger = Address::generate(&env);
    let registry_addr = Address::generate(&env);

    env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &htlc.address,
            fn_name: "set_resolver_registry",
            args: (registry_addr.clone(),).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    assert!(htlc.try_set_resolver_registry(&registry_addr).is_err());

    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &htlc.address,
            fn_name: "set_resolver_registry",
            args: (registry_addr.clone(),).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    htlc.set_resolver_registry(&registry_addr);
    env.mock_all_auths();
    assert_eq!(htlc.resolver_registry(), Some(registry_addr));
}

#[test]
fn clear_resolver_registry_requires_admin_auth() {
    let env = Env::default();
    let (admin, htlc) = setup_no_mock(&env, 0);
    let stranger = Address::generate(&env);
    let registry_addr = Address::generate(&env);

    // Set registry first.
    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &htlc.address,
            fn_name: "set_resolver_registry",
            args: (registry_addr.clone(),).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    htlc.set_resolver_registry(&registry_addr);

    // Stranger cannot clear.
    env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &htlc.address,
            fn_name: "clear_resolver_registry",
            args: ().into_val(&env),
            sub_invokes: &[],
        },
    }]);
    assert!(htlc.try_clear_resolver_registry().is_err());

    // Admin can.
    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &htlc.address,
            fn_name: "clear_resolver_registry",
            args: ().into_val(&env),
            sub_invokes: &[],
        },
    }]);
    htlc.clear_resolver_registry();
    env.mock_all_auths();
    assert_eq!(htlc.resolver_registry(), None);
}

#[test]
fn transfer_admin_requires_current_admin_auth() {
    let env = Env::default();
    let (admin, htlc) = setup_no_mock(&env, 0);
    let stranger = Address::generate(&env);
    let new_admin = Address::generate(&env);

    // Stranger cannot propose.
    env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &htlc.address,
            fn_name: "transfer_admin",
            args: (new_admin.clone(),).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    assert!(htlc.try_transfer_admin(&new_admin).is_err());
    env.mock_all_auths();
    assert_eq!(htlc.pending_admin(), None);

    // Admin can.
    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &htlc.address,
            fn_name: "transfer_admin",
            args: (new_admin.clone(),).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    htlc.transfer_admin(&new_admin);
    env.mock_all_auths();
    assert_eq!(htlc.pending_admin(), Some(new_admin));
}

#[test]
fn revoke_pending_admin_requires_current_admin_auth() {
    let env = Env::default();
    let (admin, htlc) = setup_no_mock(&env, 0);
    let stranger = Address::generate(&env);
    let new_admin = Address::generate(&env);

    // Propose first (admin auth).
    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &htlc.address,
            fn_name: "transfer_admin",
            args: (new_admin.clone(),).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    htlc.transfer_admin(&new_admin);

    // Stranger cannot revoke.
    env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &htlc.address,
            fn_name: "revoke_pending_admin",
            args: ().into_val(&env),
            sub_invokes: &[],
        },
    }]);
    assert!(htlc.try_revoke_pending_admin().is_err());
    env.mock_all_auths();
    assert_eq!(htlc.pending_admin(), Some(new_admin.clone()));

    // Admin can.
    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &htlc.address,
            fn_name: "revoke_pending_admin",
            args: ().into_val(&env),
            sub_invokes: &[],
        },
    }]);
    htlc.revoke_pending_admin();
    env.mock_all_auths();
    assert_eq!(htlc.pending_admin(), None);
}

// =====================================================================
// EVENT ASSERTIONS — exact topic tuple + payload for created/claimed/refunded
// Pins the wire format the coordinator/resolver index on.
// =====================================================================

#[test]
fn create_order_emits_created_event_with_exact_shape() {
    let env = Env::default();
    env.mock_all_auths();
    let asset_admin = Address::generate(&env);
    let (asset, sac, _token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env, 0);

    let sender = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    sac.mint(&sender, &100_0000000);

    let preimage = Bytes::from_array(&env, &[40u8; 32]);
    let hashlock = sha256_32(&env, &preimage);
    let amount = 10_0000000i128;
    let safety = 1_000_000i128;
    let timelock_secs = 600u64;

    let now = env.ledger().timestamp();
    let expected_timelock = now + timelock_secs;

    // Assert immediately after the call — the event log is per-invocation.
    let order_id = htlc.create_order(
        &sender, &beneficiary, &sender, &asset,
        &amount, &safety, &hashlock, &timelock_secs,
    );
    assert_last_event(
        &env,
        &htlc.address,
        // topics: (symbol "created", sender, beneficiary, hashlock)
        (symbol_short!("created"), sender.clone(), beneficiary.clone(), hashlock.clone()),
        // data:   (order_id, asset, amount, safety_deposit, timelock)
        (order_id, asset.clone(), amount, safety, expected_timelock),
    );
}

#[test]
fn claim_order_emits_claimed_event_with_exact_shape() {
    let env = Env::default();
    env.mock_all_auths();
    let asset_admin = Address::generate(&env);
    let (asset, sac, _token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env, 0);

    let sender = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let caller = Address::generate(&env); // separate relay address
    sac.mint(&sender, &100_0000000);

    let preimage = Bytes::from_array(&env, &[41u8; 32]);
    let hashlock = sha256_32(&env, &preimage);
    let amount = 10_0000000i128;
    let safety = 1_000_000i128;

    let order_id = htlc.create_order(
        &sender, &beneficiary, &sender, &asset,
        &amount, &safety, &hashlock, &600u64,
    );

    htlc.claim_order(&order_id, &preimage, &caller);
    assert_last_event(
        &env,
        &htlc.address,
        // topics: (symbol "claimed", beneficiary, hashlock)
        (symbol_short!("claimed"), beneficiary.clone(), hashlock.clone()),
        // data:   (order_id, caller, preimage, amount, safety_deposit)
        (order_id, caller.clone(), preimage.clone(), amount, safety),
    );
}

#[test]
fn refund_order_emits_refunded_event_with_exact_shape() {
    let env = Env::default();
    env.mock_all_auths();
    let asset_admin = Address::generate(&env);
    let (asset, sac, _token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env, 0);

    let sender = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let refund_to = Address::generate(&env);
    let caller = Address::generate(&env);
    sac.mint(&sender, &100_0000000);

    let preimage = Bytes::from_array(&env, &[42u8; 32]);
    let hashlock = sha256_32(&env, &preimage);
    let amount = 10_0000000i128;
    let safety = 1_000_000i128;

    let order_id = htlc.create_order(
        &sender, &beneficiary, &refund_to, &asset,
        &amount, &safety, &hashlock, &600u64,
    );

    advance_ledger(&env, 601);
    htlc.refund_order(&order_id, &caller);
    assert_last_event(
        &env,
        &htlc.address,
        // topics: (symbol "refunded", refund_address, hashlock)
        (symbol_short!("refunded"), refund_to.clone(), hashlock.clone()),
        // data:   (order_id, caller, amount, safety_deposit)
        (order_id, caller.clone(), amount, safety),
    );
}

// =====================================================================
// TIMELOCK BOUNDARY VALUES
// 299 s → InvalidTimelock, 300 s → valid, 86 400 s → valid, 86 401 s → invalid
// Plus: claim at timestamp == timelock (valid) vs refund at == timelock (invalid)
// =====================================================================

#[test]
fn timelock_299_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let asset_admin = Address::generate(&env);
    let (asset, sac, _token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env, 0);
    let sender = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    sac.mint(&sender, &100_0000000);
    let hashlock = sha256_32(&env, &Bytes::from_array(&env, &[50u8; 32]));

    assert_eq!(
        htlc.try_create_order(
            &sender, &beneficiary, &sender, &asset,
            &10_0000000i128, &0i128, &hashlock, &299u64,
        ).err().unwrap().unwrap(),
        Error::InvalidTimelock.into()
    );
}

#[test]
fn timelock_300_accepted() {
    let env = Env::default();
    env.mock_all_auths();
    let asset_admin = Address::generate(&env);
    let (asset, sac, _token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env, 0);
    let sender = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    sac.mint(&sender, &100_0000000);
    let hashlock = sha256_32(&env, &Bytes::from_array(&env, &[51u8; 32]));

    let id = htlc.create_order(
        &sender, &beneficiary, &sender, &asset,
        &10_0000000i128, &0i128, &hashlock, &300u64,
    );
    assert!(htlc.get_order(&id).is_some());
}

#[test]
fn timelock_86400_accepted() {
    let env = Env::default();
    env.mock_all_auths();
    let asset_admin = Address::generate(&env);
    let (asset, sac, _token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env, 0);
    let sender = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    sac.mint(&sender, &100_0000000);
    let hashlock = sha256_32(&env, &Bytes::from_array(&env, &[52u8; 32]));

    let id = htlc.create_order(
        &sender, &beneficiary, &sender, &asset,
        &10_0000000i128, &0i128, &hashlock, &86_400u64,
    );
    assert!(htlc.get_order(&id).is_some());
}

#[test]
fn timelock_86401_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let asset_admin = Address::generate(&env);
    let (asset, sac, _token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env, 0);
    let sender = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    sac.mint(&sender, &100_0000000);
    let hashlock = sha256_32(&env, &Bytes::from_array(&env, &[53u8; 32]));

    assert_eq!(
        htlc.try_create_order(
            &sender, &beneficiary, &sender, &asset,
            &10_0000000i128, &0i128, &hashlock, &86_401u64,
        ).err().unwrap().unwrap(),
        Error::InvalidTimelock.into()
    );
}

// ---------------------------------------------------------------------
// claim at timestamp == timelock is VALID (condition: > timelock to expire)
// refund at timestamp == timelock is INVALID (condition: <= timelock → NotExpired)
// ---------------------------------------------------------------------

#[test]
fn claim_at_exactly_timelock_succeeds() {
    // lib.rs:331: if env.ledger().timestamp() > order.timelock → Expired
    // So timestamp == timelock is still claimable.
    let env = Env::default();
    env.mock_all_auths();
    let asset_admin = Address::generate(&env);
    let (asset, sac, token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env, 0);

    let sender = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    sac.mint(&sender, &100_0000000);

    let preimage = Bytes::from_array(&env, &[54u8; 32]);
    let hashlock = sha256_32(&env, &preimage);
    let amount = 10_0000000i128;
    let timelock_secs = 600u64;

    let order_id = htlc.create_order(
        &sender, &beneficiary, &sender, &asset,
        &amount, &0i128, &hashlock, &timelock_secs,
    );

    // Advance to exactly the timelock timestamp (not past it).
    advance_ledger(&env, timelock_secs);

    // Must succeed — timestamp == timelock is the boundary that is still claimable.
    htlc.claim_order(&order_id, &preimage, &beneficiary);
    assert_eq!(token.balance(&beneficiary), amount);
    assert_eq!(htlc.get_order(&order_id).unwrap().status, OrderStatus::Claimed);
}

#[test]
fn refund_at_exactly_timelock_fails() {
    // lib.rs:384: if env.ledger().timestamp() <= order.timelock → NotExpired
    // So timestamp == timelock is NOT yet refundable.
    let env = Env::default();
    env.mock_all_auths();
    let asset_admin = Address::generate(&env);
    let (asset, sac, _token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env, 0);

    let sender = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let caller = Address::generate(&env);
    sac.mint(&sender, &100_0000000);

    let preimage = Bytes::from_array(&env, &[55u8; 32]);
    let hashlock = sha256_32(&env, &preimage);
    let timelock_secs = 600u64;

    let order_id = htlc.create_order(
        &sender, &beneficiary, &sender, &asset,
        &10_0000000i128, &0i128, &hashlock, &timelock_secs,
    );

    // Advance to exactly the timelock timestamp.
    advance_ledger(&env, timelock_secs);

    // Must fail — refund requires strictly past the timelock.
    assert_eq!(
        htlc.try_refund_order(&order_id, &caller).err().unwrap().unwrap(),
        Error::NotExpired.into()
    );
}

#[test]
fn refund_one_second_past_timelock_succeeds() {
    let env = Env::default();
    env.mock_all_auths();
    let asset_admin = Address::generate(&env);
    let (asset, sac, token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env, 0);

    let sender = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let refund_to = Address::generate(&env);
    let caller = Address::generate(&env);
    sac.mint(&sender, &100_0000000);

    let preimage = Bytes::from_array(&env, &[56u8; 32]);
    let hashlock = sha256_32(&env, &preimage);
    let amount = 10_0000000i128;
    let timelock_secs = 600u64;

    let order_id = htlc.create_order(
        &sender, &beneficiary, &refund_to, &asset,
        &amount, &0i128, &hashlock, &timelock_secs,
    );

    // One second past the timelock.
    advance_ledger(&env, timelock_secs + 1);
    htlc.refund_order(&order_id, &caller);
    assert_eq!(token.balance(&refund_to), amount);
}

// =====================================================================
// INVALID AMOUNT BRANCHES
// amount <= 0 and safety_deposit < 0
// =====================================================================

#[test]
fn create_order_zero_amount_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let asset_admin = Address::generate(&env);
    let (asset, sac, _token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env, 0);
    let sender = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    sac.mint(&sender, &100_0000000);
    let hashlock = sha256_32(&env, &Bytes::from_array(&env, &[60u8; 32]));

    assert_eq!(
        htlc.try_create_order(
            &sender, &beneficiary, &sender, &asset,
            &0i128, &0i128, &hashlock, &600u64,
        ).err().unwrap().unwrap(),
        Error::InvalidAmount.into()
    );
}

#[test]
fn create_order_negative_amount_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let asset_admin = Address::generate(&env);
    let (asset, sac, _token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env, 0);
    let sender = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    sac.mint(&sender, &100_0000000);
    let hashlock = sha256_32(&env, &Bytes::from_array(&env, &[61u8; 32]));

    assert_eq!(
        htlc.try_create_order(
            &sender, &beneficiary, &sender, &asset,
            &(-1i128), &0i128, &hashlock, &600u64,
        ).err().unwrap().unwrap(),
        Error::InvalidAmount.into()
    );
}

#[test]
fn create_order_negative_safety_deposit_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let asset_admin = Address::generate(&env);
    let (asset, sac, _token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env, 0);
    let sender = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    sac.mint(&sender, &100_0000000);
    let hashlock = sha256_32(&env, &Bytes::from_array(&env, &[62u8; 32]));

    assert_eq!(
        htlc.try_create_order(
            &sender, &beneficiary, &sender, &asset,
            &10_0000000i128, &(-1i128), &hashlock, &600u64,
        ).err().unwrap().unwrap(),
        Error::InvalidAmount.into()
    );
}

#[test]
fn set_min_safety_deposit_negative_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, htlc) = setup(&env, 0);

    assert_eq!(
        htlc.try_set_min_safety_deposit(&(-1i128)).err().unwrap().unwrap(),
        Error::InvalidAmount.into()
    );
}

// =====================================================================
// OrderNotFound — claim, refund, and get_order on nonexistent ids
// =====================================================================

#[test]
fn claim_order_nonexistent_id_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, htlc) = setup(&env, 0);
    let caller = Address::generate(&env);
    let preimage = Bytes::from_array(&env, &[70u8; 32]);

    assert_eq!(
        htlc.try_claim_order(&999u64, &preimage, &caller).err().unwrap().unwrap(),
        Error::OrderNotFound.into()
    );
}

#[test]
fn refund_order_nonexistent_id_fails() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, htlc) = setup(&env, 0);
    let caller = Address::generate(&env);

    // Advance time so NotExpired doesn't fire first.
    advance_ledger(&env, 100_000);

    assert_eq!(
        htlc.try_refund_order(&999u64, &caller).err().unwrap().unwrap(),
        Error::OrderNotFound.into()
    );
}

#[test]
fn get_order_nonexistent_id_returns_none() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, htlc) = setup(&env, 0);

    assert!(htlc.get_order(&999u64).is_none());
}

// =====================================================================
// ZERO SAFETY-DEPOSIT TERMINAL FLOWS
// claim and refund when safety_deposit == 0 must not attempt a zero transfer
// =====================================================================

#[test]
fn claim_order_with_zero_safety_deposit_succeeds() {
    let env = Env::default();
    env.mock_all_auths();
    let asset_admin = Address::generate(&env);
    let (asset, sac, token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env, 0);

    let sender = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let caller = Address::generate(&env);
    sac.mint(&sender, &100_0000000);

    let preimage = Bytes::from_array(&env, &[80u8; 32]);
    let hashlock = sha256_32(&env, &preimage);
    let amount = 10_0000000i128;

    let order_id = htlc.create_order(
        &sender, &beneficiary, &sender, &asset,
        &amount, &0i128, &hashlock, &600u64,
    );

    htlc.claim_order(&order_id, &preimage, &caller);

    assert_eq!(token.balance(&beneficiary), amount);
    // Caller gets nothing (no safety deposit).
    assert_eq!(token.balance(&caller), 0);
    assert_eq!(token.balance(&htlc.address), 0);
    assert_eq!(htlc.get_order(&order_id).unwrap().status, OrderStatus::Claimed);
}

#[test]
fn refund_order_with_zero_safety_deposit_succeeds() {
    let env = Env::default();
    env.mock_all_auths();
    let asset_admin = Address::generate(&env);
    let (asset, sac, token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env, 0);

    let sender = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let refund_to = Address::generate(&env);
    let caller = Address::generate(&env);
    sac.mint(&sender, &100_0000000);

    let preimage = Bytes::from_array(&env, &[81u8; 32]);
    let hashlock = sha256_32(&env, &preimage);
    let amount = 10_0000000i128;

    let order_id = htlc.create_order(
        &sender, &beneficiary, &refund_to, &asset,
        &amount, &0i128, &hashlock, &600u64,
    );

    advance_ledger(&env, 601);
    htlc.refund_order(&order_id, &caller);

    assert_eq!(token.balance(&refund_to), amount);
    // Caller gets nothing (no safety deposit).
    assert_eq!(token.balance(&caller), 0);
    assert_eq!(token.balance(&htlc.address), 0);
    assert_eq!(htlc.get_order(&order_id).unwrap().status, OrderStatus::Refunded);
}

// =====================================================================
// AUTH-SHAPE TEST — create_order auth tree covers the token transfer
// sub-invocation, guarding against SDK upgrade regressions that might
// drop the sub-invoke from the auth tree.
// =====================================================================

#[test]
fn create_order_auth_tree_covers_token_transfer_sub_invocation() {
    // We supply a full MockAuth that includes the token::transfer
    // sub-invocation in its sub_invokes list.  If the SDK no longer
    // nests the transfer under the sender's auth, the MockAuth
    // verification will reject the invocation and the test will fail.
    let env = Env::default();
    let asset_admin = Address::generate(&env);
    let (asset, sac, _token) = deploy_token(&env, &asset_admin);

    let admin = Address::generate(&env);
    let contract_id = env.register(HtlcContract, (admin.clone(), 0i128));
    let htlc = HtlcContractClient::new(&env, &contract_id);

    let sender = Address::generate(&env);
    let beneficiary = Address::generate(&env);

    // Mint with mock_all so we don't have to model the SAC auth tree.
    env.mock_all_auths();
    sac.mint(&sender, &100_0000000);

    let preimage = Bytes::from_array(&env, &[90u8; 32]);
    let hashlock = sha256_32(&env, &preimage);
    let amount = 10_0000000i128;
    let safety = 0i128;
    let total = amount; // amount + safety

    // Now set up a selective mock that explicitly models the sub-invoke.
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
                safety,
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

    // If the sub-invocation is correctly nested under sender's auth
    // this call succeeds; if the SDK drops the nesting it will panic.
    let order_id = htlc.create_order(
        &sender, &beneficiary, &sender, &asset,
        &amount, &safety, &hashlock, &600u64,
    );
    env.mock_all_auths();
    assert!(htlc.get_order(&order_id).is_some());
}
