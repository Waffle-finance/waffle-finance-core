//! Property-based governance & auth-enforcement harness for the HTLC contract.
//!
//! The state-machine harness in `harness.rs` runs under `mock_all_auths`, so it
//! exercises balance/terminal-state/idempotency invariants but deliberately
//! cannot observe the contract's authorization rules. This module fills that
//! gap: it drives the admin-governance entry points
//!
//!   transfer_admin, accept_admin, revoke_pending_admin, set_min_safety_deposit
//!
//! with **explicit per-call auth** (no `mock_all_auths`) and a randomly chosen
//! signer that may be the current admin, the pending admin, an unrelated
//! candidate, or an outright attacker.
//!
//! Invariant families asserted after every generated step:
//!
//!   * **Auth enforcement** — a call signed by anyone other than the address
//!     the contract requires is rejected and never mutates governance state.
//!   * **Admin-transfer safety** — the admin role only changes hands once the
//!     *pending* admin accepts; `transfer_admin` alone never transfers control,
//!     the old admin loses all power the instant the handoff completes, and a
//!     `revoke` returns control cleanly. A two-phase handoff can never strand
//!     the contract without a usable admin.
//!
//! proptest shrinks any failing sequence and records it under
//! `contracts/htlc/proptest-regressions/` for deterministic CI + local replay.

#![cfg(test)]

use super::*;
use proptest::prelude::*;
use soroban_sdk::testutils::{Address as _, MockAuth, MockAuthInvoke};
use soroban_sdk::{Address, Env, IntoVal};
use std::vec::Vec;

/// One admin-governance action plus the index of the address that signs it.
///
/// `signer` selects one of three candidate admin addresses (0, 1, 2) or an
/// out-of-band attacker (3), letting the generator probe every combination of
/// "right signer" and "wrong signer" for each entry point.
#[derive(Clone, Debug)]
enum GovAction {
    Transfer { target: usize, signer: usize },
    Accept { signer: usize },
    Revoke { signer: usize },
    SetMinDeposit { value: i128, signer: usize },
}

fn gov_strategy() -> impl Strategy<Value = Vec<GovAction>> {
    let transfer = (0usize..3, 0usize..4)
        .prop_map(|(target, signer)| GovAction::Transfer { target, signer });
    let accept = (0usize..4).prop_map(|signer| GovAction::Accept { signer });
    let revoke = (0usize..4).prop_map(|signer| GovAction::Revoke { signer });
    // Values deliberately straddle zero so both the accepted (>= 0) and the
    // rejected (< 0 → InvalidAmount) config-change branches are generated.
    let set_min = (-5i128..1000, 0usize..4)
        .prop_map(|(value, signer)| GovAction::SetMinDeposit { value, signer });

    prop::collection::vec(prop_oneof![transfer, accept, revoke, set_min], 1..24)
}

/// Model of the contract's governance state, tracked as candidate indices so it
/// can be compared against the live contract after every step.
struct GovModel {
    admin: usize,
    pending: Option<usize>,
    min_deposit: i128,
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 96, ..ProptestConfig::default() })]

    #[test]
    fn admin_governance_auth_safety(seq in gov_strategy()) {
        let env = Env::default();

        // Three interchangeable admin candidates + an attacker with no role.
        let candidates: [Address; 3] = [
            Address::generate(&env),
            Address::generate(&env),
            Address::generate(&env),
        ];
        let attacker = Address::generate(&env);
        let addr = |i: usize| if i < 3 { candidates[i].clone() } else { attacker.clone() };

        let cid = env.register(HtlcContract, (candidates[0].clone(), 0i128));
        let htlc = HtlcContractClient::new(&env, &cid);

        let mut model = GovModel { admin: 0, pending: None, min_deposit: 0 };

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
                    let res = htlc.try_transfer_admin(&target_addr);
                    // Only the current admin may propose a new admin.
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
                    let res = htlc.try_accept_admin();
                    // Succeeds only when a pending transfer exists AND the
                    // signer is exactly that pending admin.
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
                    let res = htlc.try_revoke_pending_admin();
                    if signer == model.admin && model.pending.is_some() {
                        prop_assert!(res.is_ok(), "admin's revoke of a pending transfer must succeed");
                        model.pending = None;
                    } else {
                        prop_assert!(res.is_err(), "revoke requires admin auth and a pending transfer");
                    }
                }

                GovAction::SetMinDeposit { value, signer } => {
                    env.mock_auths(&[MockAuth {
                        address: &addr(signer),
                        invoke: &MockAuthInvoke {
                            contract: &cid,
                            fn_name: "set_min_safety_deposit",
                            args: (value,).into_val(&env),
                            sub_invokes: &[],
                        },
                    }]);
                    let res = htlc.try_set_min_safety_deposit(&value);
                    if signer == model.admin && value >= 0 {
                        prop_assert!(res.is_ok(), "admin's valid config change must succeed");
                        model.min_deposit = value;
                    } else {
                        prop_assert!(res.is_err(), "unauthorized or invalid config change must be rejected");
                    }
                }
            }

            // ── Invariants: live contract state matches the model exactly. ──
            prop_assert_eq!(htlc.admin(), addr(model.admin), "admin diverged from model");
            match model.pending {
                Some(i) => prop_assert_eq!(htlc.pending_admin(), Some(addr(i)), "pending admin diverged"),
                None => prop_assert_eq!(htlc.pending_admin(), None, "pending admin should be cleared"),
            }
            prop_assert_eq!(htlc.min_safety_deposit(), model.min_deposit, "min_safety_deposit diverged");
        }
    }
}
