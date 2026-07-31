//! Property-based governance & auth-enforcement harness for the resolver
//! registry.
//!
//! The stake-conservation property in `prop_tests.rs` runs under
//! `mock_all_auths`; this module complements it by exercising the privileged
//! entry points
//!
//!   transfer_admin, accept_admin, revoke_pending_admin, set_min_stake, slash
//!
//! with **explicit per-call auth** so the contract's authorization rules are
//! actually observed. A randomly chosen signer (current admin, pending admin,
//! unrelated candidate, or attacker) probes both the accepted and rejected
//! branch of every call.
//!
//! Invariant families asserted after every generated step:
//!
//!   * **Auth enforcement** — privileged calls signed by anyone other than the
//!     required address are rejected and never mutate state. `slash` in
//!     particular can never fire without admin auth.
//!   * **Admin-transfer safety** — control changes hands only via a two-phase
//!     propose/accept, the old admin loses power the moment the handoff lands,
//!     and revoke restores the status quo without stranding the contract.
//!
//! Failing sequences are shrunk and recorded under
//! `contracts/resolver-registry/proptest-regressions/` for deterministic
//! CI + local replay.

#![cfg(test)]

use super::*;
use proptest::prelude::*;
use soroban_sdk::testutils::{Address as _, MockAuth, MockAuthInvoke};
use soroban_sdk::{Address, Env, IntoVal};
use std::vec::Vec;

#[derive(Clone, Debug)]
enum GovAction {
    Transfer { target: usize, signer: usize },
    Accept { signer: usize },
    Revoke { signer: usize },
    SetMinStake { value: i128, signer: usize },
    /// `slash` against an address that was never registered — must be rejected
    /// for any signer (non-admin → auth failure, admin → ResolverNotFound).
    Slash { signer: usize },
}

fn gov_strategy() -> impl Strategy<Value = Vec<GovAction>> {
    let transfer = (0usize..3, 0usize..4)
        .prop_map(|(target, signer)| GovAction::Transfer { target, signer });
    let accept = (0usize..4).prop_map(|signer| GovAction::Accept { signer });
    let revoke = (0usize..4).prop_map(|signer| GovAction::Revoke { signer });
    let set_min = (-5i128..1000, 0usize..4)
        .prop_map(|(value, signer)| GovAction::SetMinStake { value, signer });
    let slash = (0usize..4).prop_map(|signer| GovAction::Slash { signer });

    prop::collection::vec(prop_oneof![transfer, accept, revoke, set_min, slash], 1..24)
}

struct GovModel {
    admin: usize,
    pending: Option<usize>,
    min_stake: i128,
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 96, ..ProptestConfig::default() })]

    #[test]
    fn admin_governance_auth_safety(seq in gov_strategy()) {
        let env = Env::default();

        let candidates: [Address; 3] = [
            Address::generate(&env),
            Address::generate(&env),
            Address::generate(&env),
        ];
        let attacker = Address::generate(&env);
        let addr = |i: usize| if i < 3 { candidates[i].clone() } else { attacker.clone() };

        let asset = env
            .register_stellar_asset_contract_v2(Address::generate(&env))
            .address();
        let slash_beneficiary = Address::generate(&env);
        let unregistered = Address::generate(&env);

        let cid = env.register(
            ResolverRegistry,
            (
                candidates[0].clone(),
                asset,
                0i128,
                slash_beneficiary,
                DEFAULT_UNBONDING_PERIOD_SECS,
            ),
        );
        let registry = ResolverRegistryClient::new(&env, &cid);

        let mut model = GovModel { admin: 0, pending: None, min_stake: 0 };

        for action in seq {
            match action {
                GovAction::Transfer { target, signer } => {
                    let target_addr = addr(target);
                    env.mock_auths(&[MockAuth {
                        address: &addr(signer),
                        invoke: &MockAuthInvoke {
                            contract: &cid,
                            fn_name: "transfer_admin",
                            args: (target_addr.clone(),).into_val(&env),
                            sub_invokes: &[],
                        },
                    }]);
                    let res = registry.try_transfer_admin(&target_addr);
                    if signer == model.admin {
                        prop_assert!(res.is_ok(), "admin's transfer_admin must succeed");
                        model.pending = Some(target);
                    } else {
                        prop_assert!(res.is_err(), "non-admin transfer_admin must be rejected");
                    }
                }

                GovAction::Accept { signer } => {
                    env.mock_auths(&[MockAuth {
                        address: &addr(signer),
                        invoke: &MockAuthInvoke {
                            contract: &cid,
                            fn_name: "accept_admin",
                            args: ().into_val(&env),
                            sub_invokes: &[],
                        },
                    }]);
                    let res = registry.try_accept_admin();
                    if model.pending == Some(signer) && signer < 3 {
                        prop_assert!(res.is_ok(), "pending admin's accept must succeed");
                        model.admin = signer;
                        model.pending = None;
                    } else {
                        prop_assert!(res.is_err(), "only the pending admin may accept");
                    }
                }

                GovAction::Revoke { signer } => {
                    env.mock_auths(&[MockAuth {
                        address: &addr(signer),
                        invoke: &MockAuthInvoke {
                            contract: &cid,
                            fn_name: "revoke_pending_admin",
                            args: ().into_val(&env),
                            sub_invokes: &[],
                        },
                    }]);
                    let res = registry.try_revoke_pending_admin();
                    if signer == model.admin && model.pending.is_some() {
                        prop_assert!(res.is_ok(), "admin's revoke must succeed");
                        model.pending = None;
                    } else {
                        prop_assert!(res.is_err(), "revoke requires admin auth and a pending transfer");
                    }
                }

                GovAction::SetMinStake { value, signer } => {
                    env.mock_auths(&[MockAuth {
                        address: &addr(signer),
                        invoke: &MockAuthInvoke {
                            contract: &cid,
                            fn_name: "set_min_stake",
                            args: (value,).into_val(&env),
                            sub_invokes: &[],
                        },
                    }]);
                    let res = registry.try_set_min_stake(&value);
                    if signer == model.admin && value >= 0 {
                        prop_assert!(res.is_ok(), "admin's valid config change must succeed");
                        model.min_stake = value;
                    } else {
                        prop_assert!(res.is_err(), "unauthorized or invalid config change must be rejected");
                    }
                }

                GovAction::Slash { signer } => {
                    env.mock_auths(&[MockAuth {
                        address: &addr(signer),
                        invoke: &MockAuthInvoke {
                            contract: &cid,
                            fn_name: "slash",
                            args: (unregistered.clone(), 1i128).into_val(&env),
                            sub_invokes: &[],
                        },
                    }]);
                    // Never valid: a non-admin lacks auth; the admin hits an
                    // unregistered resolver. Either way slash must not fire.
                    let res = registry.try_slash(&unregistered, &1i128);
                    prop_assert!(res.is_err(), "slash must never succeed without admin auth and a live resolver");
                }
            }

            prop_assert_eq!(registry.admin(), addr(model.admin), "admin diverged from model");
            match model.pending {
                Some(i) => prop_assert_eq!(registry.pending_admin(), Some(addr(i)), "pending admin diverged"),
                None => prop_assert_eq!(registry.pending_admin(), None, "pending admin should be cleared"),
            }
            prop_assert_eq!(registry.min_stake(), model.min_stake, "min_stake diverged");
        }
    }
}
