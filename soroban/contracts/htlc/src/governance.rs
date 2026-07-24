//! Governance tests for the HTLC contract lifecycle model (#307).
//!
//! Covers:
//!   - Constructor initialises mode to `Live`.
//!   - Every permitted transition succeeds and persists.
//!   - Every forbidden transition is rejected with `InvalidModeTransition`.
//!   - No-op transition (same → same) emits no event and succeeds silently.
//!   - `Paused` blocks `create_order`, `claim_order`, and `refund_order`.
//!   - `Maintenance` blocks `create_order` and `claim_order` but allows
//!     `refund_order` so users can always recover locked funds.
//!   - Each mode transition emits exactly one `(mode,) → (old, new)` event.
//!   - `set_mode` requires admin auth; non-admin callers are rejected.
//!   - Normal Live operations remain fully intact.

#![cfg(test)]

use crate::{ContractMode, Error, HtlcContract, HtlcContractClient};
use soroban_sdk::{
    symbol_short,
    testutils::{Address as _, Events, Ledger, LedgerInfo, MockAuth, MockAuthInvoke},
    token::{StellarAssetClient, TokenClient},
    vec, Address, Bytes, Env, IntoVal,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

fn deploy_token<'a>(
    env: &Env,
    admin: &Address,
) -> (Address, StellarAssetClient<'a>, TokenClient<'a>) {
    let c = env.register_stellar_asset_contract_v2(admin.clone());
    let addr = c.address();
    (addr.clone(), StellarAssetClient::new(env, &addr), TokenClient::new(env, &addr))
}

fn sha256_32(env: &Env, b: &Bytes) -> soroban_sdk::BytesN<32> {
    soroban_sdk::BytesN::<32>::from(env.crypto().sha256(b))
}

fn setup(env: &Env) -> (Address, HtlcContractClient<'_>) {
    let admin = Address::generate(env);
    let id = env.register(HtlcContract, (admin.clone(), 0i128));
    env.mock_all_auths();
    (admin, HtlcContractClient::new(env, &id))
}

fn advance_ledger(env: &Env, seconds: u64) {
    let cur = env.ledger().get();
    env.ledger().set(LedgerInfo {
        timestamp: cur.timestamp + seconds,
        sequence_number: cur.sequence_number + (seconds / 5).max(1) as u32,
        protocol_version: cur.protocol_version,
        network_id: cur.network_id,
        base_reserve: cur.base_reserve,
        min_temp_entry_ttl: cur.min_temp_entry_ttl,
        min_persistent_entry_ttl: cur.min_persistent_entry_ttl,
        max_entry_ttl: cur.max_entry_ttl,
    });
}

/// Create a funded order and return (order_id, preimage_bytes).
fn fund_order<'a>(
    env: &Env,
    htlc: &HtlcContractClient<'_>,
    asset: &Address,
    sac: &StellarAssetClient<'a>,
) -> (u64, Bytes) {
    let sender = Address::generate(env);
    let beneficiary = Address::generate(env);
    sac.mint(&sender, &200_0000000);
    let preimage = Bytes::from_array(env, &[0xabu8; 32]);
    let hashlock = sha256_32(env, &preimage);
    let id = htlc.create_order(
        &sender, &beneficiary, &sender, asset,
        &10_0000000i128, &0i128, &hashlock, &600u64,
    );
    (id, preimage)
}

// ─── Constructor ──────────────────────────────────────────────────────────────

#[test]
fn constructor_sets_mode_to_live() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, htlc) = setup(&env);
    assert_eq!(htlc.contract_mode(), ContractMode::Live);
}

// ─── Permitted transitions ────────────────────────────────────────────────────

#[test]
fn live_to_paused_succeeds() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, htlc) = setup(&env);
    htlc.set_mode(&ContractMode::Paused);
    assert_eq!(htlc.contract_mode(), ContractMode::Paused);
}

#[test]
fn paused_to_live_succeeds() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, htlc) = setup(&env);
    htlc.set_mode(&ContractMode::Paused);
    htlc.set_mode(&ContractMode::Live);
    assert_eq!(htlc.contract_mode(), ContractMode::Live);
}

#[test]
fn live_to_maintenance_succeeds() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, htlc) = setup(&env);
    htlc.set_mode(&ContractMode::Maintenance);
    assert_eq!(htlc.contract_mode(), ContractMode::Maintenance);
}

#[test]
fn maintenance_to_live_succeeds() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, htlc) = setup(&env);
    htlc.set_mode(&ContractMode::Maintenance);
    htlc.set_mode(&ContractMode::Live);
    assert_eq!(htlc.contract_mode(), ContractMode::Live);
}

// ─── Forbidden transitions ────────────────────────────────────────────────────

#[test]
fn paused_to_maintenance_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, htlc) = setup(&env);
    htlc.set_mode(&ContractMode::Paused);
    let res = htlc.try_set_mode(&ContractMode::Maintenance);
    assert_eq!(res.err().unwrap().unwrap(), Error::InvalidModeTransition.into());
    assert_eq!(htlc.contract_mode(), ContractMode::Paused);
}

#[test]
fn maintenance_to_paused_rejected() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, htlc) = setup(&env);
    htlc.set_mode(&ContractMode::Maintenance);
    let res = htlc.try_set_mode(&ContractMode::Paused);
    assert_eq!(res.err().unwrap().unwrap(), Error::InvalidModeTransition.into());
    assert_eq!(htlc.contract_mode(), ContractMode::Maintenance);
}

// ─── No-op transition ─────────────────────────────────────────────────────────

#[test]
fn set_mode_same_mode_is_noop_emits_no_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, htlc) = setup(&env);

    // Record baseline event count.
    let before = env.events().all().len();

    // Live → Live is a no-op.
    htlc.set_mode(&ContractMode::Live);

    let after = env.events().all().len();
    assert_eq!(after, before, "no-op set_mode must not emit any event");
}

// ─── Audit events ─────────────────────────────────────────────────────────────

#[test]
fn set_mode_emits_mode_event_with_old_and_new() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, htlc) = setup(&env);

    htlc.set_mode(&ContractMode::Paused);

    // The very last event must be:
    //   topics = (symbol "mode",)
    //   data   = (ContractMode::Live, ContractMode::Paused)
    let all = env.events().all();
    assert_eq!(
        all.slice(all.len() - 1..),
        vec![
            &env,
            (
                htlc.address.clone(),
                (symbol_short!("mode"),).into_val(&env),
                (ContractMode::Live, ContractMode::Paused).into_val(&env),
            )
        ],
        "set_mode must emit (mode,) → (old, new)"
    );
}

#[test]
fn each_transition_emits_exactly_one_mode_event() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, htlc) = setup(&env);

    let before_pause = env.events().all().len();
    htlc.set_mode(&ContractMode::Paused);
    assert_eq!(
        env.events().all().len() - before_pause,
        1,
        "Live→Paused must emit exactly 1 event"
    );

    let before_live = env.events().all().len();
    htlc.set_mode(&ContractMode::Live);
    assert_eq!(
        env.events().all().len() - before_live,
        1,
        "Paused→Live must emit exactly 1 event"
    );
}

#[test]
fn maintenance_transition_event_has_correct_payload() {
    let env = Env::default();
    env.mock_all_auths();
    let (_admin, htlc) = setup(&env);

    htlc.set_mode(&ContractMode::Maintenance);

    let all = env.events().all();
    assert_eq!(
        all.slice(all.len() - 1..),
        vec![
            &env,
            (
                htlc.address.clone(),
                (symbol_short!("mode"),).into_val(&env),
                (ContractMode::Live, ContractMode::Maintenance).into_val(&env),
            )
        ]
    );
}

// ─── Paused blocks all settlement ────────────────────────────────────────────

#[test]
fn paused_blocks_create_order() {
    let env = Env::default();
    env.mock_all_auths();
    let asset_admin = Address::generate(&env);
    let (asset, sac, _tok) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env);

    let sender = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    sac.mint(&sender, &100_0000000);
    let hashlock = sha256_32(&env, &Bytes::from_array(&env, &[1u8; 32]));

    htlc.set_mode(&ContractMode::Paused);

    let res = htlc.try_create_order(
        &sender, &beneficiary, &sender, &asset,
        &10_0000000i128, &0i128, &hashlock, &600u64,
    );
    assert_eq!(res.err().unwrap().unwrap(), Error::ContractPaused.into());
}

#[test]
fn paused_blocks_claim_order() {
    let env = Env::default();
    env.mock_all_auths();
    let asset_admin = Address::generate(&env);
    let (asset, sac, _tok) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env);

    let (order_id, preimage) = fund_order(&env, &htlc, &asset, &sac);
    htlc.set_mode(&ContractMode::Paused);

    let caller = Address::generate(&env);
    let res = htlc.try_claim_order(&order_id, &preimage, &caller);
    assert_eq!(res.err().unwrap().unwrap(), Error::ContractPaused.into());
}

#[test]
fn paused_blocks_refund_order() {
    let env = Env::default();
    env.mock_all_auths();
    let asset_admin = Address::generate(&env);
    let (asset, sac, _tok) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env);

    let (order_id, _) = fund_order(&env, &htlc, &asset, &sac);
    advance_ledger(&env, 601);

    htlc.set_mode(&ContractMode::Paused);

    let caller = Address::generate(&env);
    let res = htlc.try_refund_order(&order_id, &caller);
    assert_eq!(
        res.err().unwrap().unwrap(),
        Error::ContractPaused.into(),
        "refund_order must be blocked in Paused mode"
    );
}

// ─── Maintenance: create/claim blocked, refund allowed ───────────────────────

#[test]
fn maintenance_blocks_create_order() {
    let env = Env::default();
    env.mock_all_auths();
    let asset_admin = Address::generate(&env);
    let (asset, sac, _tok) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env);

    let sender = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    sac.mint(&sender, &100_0000000);
    let hashlock = sha256_32(&env, &Bytes::from_array(&env, &[2u8; 32]));

    htlc.set_mode(&ContractMode::Maintenance);

    let res = htlc.try_create_order(
        &sender, &beneficiary, &sender, &asset,
        &10_0000000i128, &0i128, &hashlock, &600u64,
    );
    assert_eq!(res.err().unwrap().unwrap(), Error::ContractInMaintenance.into());
}

#[test]
fn maintenance_blocks_claim_order() {
    let env = Env::default();
    env.mock_all_auths();
    let asset_admin = Address::generate(&env);
    let (asset, sac, _tok) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env);

    let (order_id, preimage) = fund_order(&env, &htlc, &asset, &sac);
    htlc.set_mode(&ContractMode::Maintenance);

    let caller = Address::generate(&env);
    let res = htlc.try_claim_order(&order_id, &preimage, &caller);
    assert_eq!(res.err().unwrap().unwrap(), Error::ContractInMaintenance.into());
}

#[test]
fn maintenance_allows_refund_order() {
    // refund_order must succeed in Maintenance so users with expiring
    // timelocks can always recover their locked funds.
    let env = Env::default();
    env.mock_all_auths();
    let asset_admin = Address::generate(&env);
    let (asset, sac, token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env);

    let sender = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    sac.mint(&sender, &100_0000000);
    let preimage = Bytes::from_array(&env, &[0xccu8; 32]);
    let hashlock = sha256_32(&env, &preimage);
    let amount = 10_0000000i128;

    let order_id = htlc.create_order(
        &sender, &beneficiary, &sender, &asset,
        &amount, &0i128, &hashlock, &600u64,
    );
    advance_ledger(&env, 601);
    htlc.set_mode(&ContractMode::Maintenance);

    let caller = Address::generate(&env);
    // Must not panic.
    htlc.refund_order(&order_id, &caller);
    assert_eq!(
        token.balance(&sender),
        100_0000000i128,
        "sender must receive the refund"
    );
}

// ─── Resume from Paused restores full access ─────────────────────────────────

#[test]
fn resuming_from_paused_restores_create_order() {
    let env = Env::default();
    env.mock_all_auths();
    let asset_admin = Address::generate(&env);
    let (asset, sac, _tok) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env);

    let sender = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    sac.mint(&sender, &100_0000000);
    let hashlock = sha256_32(&env, &Bytes::from_array(&env, &[3u8; 32]));

    htlc.set_mode(&ContractMode::Paused);
    assert!(htlc.try_create_order(
        &sender, &beneficiary, &sender, &asset,
        &10_0000000i128, &0i128, &hashlock, &600u64,
    ).is_err(), "must be blocked while Paused");

    htlc.set_mode(&ContractMode::Live);
    let id = htlc.create_order(
        &sender, &beneficiary, &sender, &asset,
        &10_0000000i128, &0i128, &hashlock, &600u64,
    );
    assert!(htlc.get_order(&id).is_some(), "order must exist after resuming");
}

#[test]
fn resuming_from_maintenance_restores_claim_order() {
    let env = Env::default();
    env.mock_all_auths();
    let asset_admin = Address::generate(&env);
    let (asset, sac, token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env);

    let (order_id, preimage) = fund_order(&env, &htlc, &asset, &sac);

    htlc.set_mode(&ContractMode::Maintenance);
    let caller = Address::generate(&env);
    assert!(
        htlc.try_claim_order(&order_id, &preimage, &caller).is_err(),
        "must be blocked in Maintenance"
    );

    htlc.set_mode(&ContractMode::Live);
    htlc.claim_order(&order_id, &preimage, &caller);
    let order = htlc.get_order(&order_id).unwrap();
    assert_eq!(order.status, crate::OrderStatus::Claimed);
    assert_eq!(token.balance(&order.beneficiary), order.amount);
}

// ─── Admin auth enforcement ───────────────────────────────────────────────────

#[test]
fn set_mode_requires_admin_auth() {
    let env = Env::default();
    let admin = Address::generate(&env);
    let id = env.register(HtlcContract, (admin.clone(), 0i128));
    let htlc = HtlcContractClient::new(&env, &id);
    let stranger = Address::generate(&env);

    // Stranger's auth must be rejected.
    env.mock_auths(&[MockAuth {
        address: &stranger,
        invoke: &MockAuthInvoke {
            contract: &id,
            fn_name: "set_mode",
            args: (ContractMode::Paused,).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    assert!(
        htlc.try_set_mode(&ContractMode::Paused).is_err(),
        "set_mode must reject non-admin callers"
    );

    // Mode must still be Live.
    env.mock_all_auths();
    assert_eq!(htlc.contract_mode(), ContractMode::Live);

    // Admin's auth must succeed.
    env.mock_auths(&[MockAuth {
        address: &admin,
        invoke: &MockAuthInvoke {
            contract: &id,
            fn_name: "set_mode",
            args: (ContractMode::Paused,).into_val(&env),
            sub_invokes: &[],
        },
    }]);
    htlc.set_mode(&ContractMode::Paused);
    env.mock_all_auths();
    assert_eq!(htlc.contract_mode(), ContractMode::Paused);
}

// ─── Live mode: all operations unaffected ────────────────────────────────────

#[test]
fn live_mode_permits_create_claim_and_refund_unchanged() {
    let env = Env::default();
    env.mock_all_auths();
    let asset_admin = Address::generate(&env);
    let (asset, sac, token) = deploy_token(&env, &asset_admin);
    let (_admin, htlc) = setup(&env);

    assert_eq!(htlc.contract_mode(), ContractMode::Live);

    let sender = Address::generate(&env);
    let beneficiary = Address::generate(&env);
    let refund_to = Address::generate(&env);
    sac.mint(&sender, &200_0000000);

    let preimage = Bytes::from_array(&env, &[0x55u8; 32]);
    let hashlock = sha256_32(&env, &preimage);
    let amount = 50_0000000i128;

    let claimed_id = htlc.create_order(
        &sender, &beneficiary, &refund_to, &asset,
        &amount, &0i128, &hashlock, &600u64,
    );
    let refunded_id = htlc.create_order(
        &sender, &beneficiary, &refund_to, &asset,
        &amount, &0i128, &hashlock, &600u64,
    );

    let caller = Address::generate(&env);
    htlc.claim_order(&claimed_id, &preimage, &caller);
    assert_eq!(token.balance(&beneficiary), amount);

    advance_ledger(&env, 601);
    htlc.refund_order(&refunded_id, &caller);
    assert_eq!(token.balance(&refund_to), amount);
}
