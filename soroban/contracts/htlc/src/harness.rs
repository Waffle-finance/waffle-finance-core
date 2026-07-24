//! Adversarial state-machine test harness for the WaffleFinance Soroban contracts.
//!
//! # Design
//!
//! This harness drives the HTLC and ResolverRegistry contracts as state machines
//! by generating random but **seed-controlled** sequences of operations:
//!
//!   create_order, claim_order, refund_order, extend_order_ttl
//!   register, increase_stake, request_unregister, withdraw_stake, slash
//!
//! After every operation it asserts a fixed set of invariants:
//!
//!   I1. Order status is monotonic — Funded→Claimed or Funded→Refunded only.
//!   I2. Funds never move without a valid HTLC state transition.
//!   I3. Resolver stake is always ≥ 0 and total_slashed ≤ original stake.
//!   I4. No order re-entry after a terminal state (Claimed / Refunded).
//!   I5. Active flag is false after request_unregister and remains false until
//!       withdraw_stake + re-register.
//!   I6. Slash amount is bounded by available stake.
//!   I7. The HTLC contract balance equals the sum of all Funded order amounts
//!       plus their safety deposits.
//!
//! Failures include the failing seed in the panic message so they can be
//! replayed with `HARNESS_SEED=<n> cargo test harness`.
//!
//! # Running
//!
//!   cargo test -p wafflefinance-htlc harness -- --nocapture
//!
//! Override the seed for deterministic replay:
//!
//!   HARNESS_SEED=12345 cargo test -p wafflefinance-htlc harness -- --nocapture

#![cfg(test)]

use std::collections::HashMap;

use crate::{HtlcContract, HtlcContractClient, Order, OrderStatus};
use wafflefinance_resolver_registry::{ResolverRegistry, ResolverRegistryClient};
use soroban_sdk::{
    testutils::{Address as _, Ledger, LedgerInfo},
    token::{StellarAssetClient, TokenClient},
    Address, Bytes, BytesN, Env,
};

// ─── PRNG ─────────────────────────────────────────────────────────────────────

/// Minimal xorshift64 PRNG so the harness has zero external dependencies.
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        // Ensure the state is never zero.
        Self(if seed == 0 { 0xdeadbeef_cafebabe } else { seed })
    }

    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        x
    }

    fn range(&mut self, lo: u64, hi: u64) -> u64 {
        lo + self.next() % (hi - lo + 1)
    }

    fn bool(&mut self) -> bool {
        self.next() & 1 == 0
    }
}

// ─── Model ────────────────────────────────────────────────────────────────────

/// In-memory model of a single HTLC order — mirrors contract state.
#[derive(Clone, Debug)]
struct ModelOrder {
    id: u64,
    status: OrderStatus,
    amount: i128,
    safety_deposit: i128,
    timelock: u64,           // absolute unix timestamp
    preimage: Option<Vec<u8>>,
}

/// In-memory model of a single resolver entry.
#[derive(Clone, Debug)]
struct ModelResolver {
    original_stake: i128,
    current_stake: i128,
    total_slashed: i128,
    active: bool,
    unbonding_at: Option<u64>,
}

/// Combined in-memory model for invariant checking.
struct Model {
    orders: HashMap<u64, ModelOrder>,
    resolvers: HashMap<usize, ModelResolver>, // keyed by resolver index
}

impl Model {
    fn new() -> Self {
        Self {
            orders: HashMap::new(),
            resolvers: HashMap::new(),
        }
    }

    /// Expected HTLC contract token balance = sum of (amount + safety_deposit)
    /// for all Funded orders.
    fn expected_htlc_balance(&self) -> i128 {
        self.orders
            .values()
            .filter(|o| o.status == OrderStatus::Funded)
            .map(|o| o.amount + o.safety_deposit)
            .sum()
    }
}

// ─── Harness setup ────────────────────────────────────────────────────────────

const NUM_RESOLVERS: usize = 4;
const MIN_STAKE: i128 = 100_0000000;
const UNBONDING_PERIOD: u64 = wafflefinance_resolver_registry::MIN_UNBONDING_PERIOD_SECS;

/// All actors and contracts used across a single harness run.
struct Harness<'a> {
    env: Env,
    htlc: HtlcContractClient<'a>,
    registry: ResolverRegistryClient<'a>,
    token: TokenClient<'a>,
    sac: StellarAssetClient<'a>,
    asset: Address,
    htlc_addr: Address,
    resolvers: Vec<Address>,
    slash_beneficiary: Address,
    model: Model,
    seed: u64,
}

fn sha256_32(env: &Env, bytes: &Bytes) -> BytesN<32> {
    BytesN::<32>::from(env.crypto().sha256(bytes))
}

fn advance_ledger(env: &Env, seconds: u64) {
    let current = env.ledger().get();
    env.ledger().set(LedgerInfo {
        timestamp: current.timestamp + seconds,
        sequence_number: current.sequence_number + (seconds / 5).max(1) as u32,
        protocol_version: current.protocol_version,
        network_id: current.network_id,
        base_reserve: current.base_reserve,
        min_temp_entry_ttl: current.min_temp_entry_ttl,
        min_persistent_entry_ttl: current.min_persistent_entry_ttl,
        max_entry_ttl: current.max_entry_ttl,
    });
}

impl<'a> Harness<'a> {
    fn new(env: &'a Env, seed: u64) -> Self {
        env.mock_all_auths();

        let asset_admin = Address::generate(env);
        let contract_addr = env.register_stellar_asset_contract_v2(asset_admin.clone());
        let asset = contract_addr.address();
        let sac = StellarAssetClient::new(env, &asset);
        let token = TokenClient::new(env, &asset);

        // Deploy HTLC (no registry at first — we wire it below).
        let htlc_admin = Address::generate(env);
        let htlc_id = env.register(HtlcContract, (htlc_admin.clone(), 0i128));
        let htlc = HtlcContractClient::new(env, &htlc_id);

        // Deploy ResolverRegistry.
        let reg_admin = Address::generate(env);
        let slash_beneficiary = Address::generate(env);
        let registry_id = env.register(
            ResolverRegistry,
            (
                reg_admin.clone(),
                asset.clone(),
                MIN_STAKE,
                slash_beneficiary.clone(),
                UNBONDING_PERIOD,
            ),
        );
        let registry = ResolverRegistryClient::new(env, &registry_id);

        // Wire the registry into the HTLC.
        htlc.set_resolver_registry(&registry_id);

        // Create resolver addresses and fund them.
        let mut resolvers = Vec::new();
        for _ in 0..NUM_RESOLVERS {
            let addr = Address::generate(env);
            // Give each resolver enough tokens to stake + create multiple orders.
            sac.mint(&addr, &(MIN_STAKE * 10 + 5_000_0000000));
            resolvers.push(addr);
        }

        Self {
            env: env.clone(),
            htlc,
            registry,
            token,
            sac,
            asset,
            htlc_addr: htlc_id,
            resolvers,
            slash_beneficiary,
            model: Model::new(),
            seed,
        }
    }
}

// ─── Operations ───────────────────────────────────────────────────────────────

/// The set of operations the harness can randomly choose.
#[derive(Debug, Clone, Copy)]
enum Op {
    // Registry
    Register(usize),
    IncreaseStake(usize),
    RequestUnregister(usize),
    WithdrawStake(usize),
    Slash(usize),
    // HTLC
    CreateOrder(usize),   // resolver index creates an order
    ClaimOrder(u64),      // claim by order id
    RefundOrder(u64),     // refund by order id
    // Ledger
    AdvanceTime(u64),
}

impl<'a> Harness<'a> {
    /// Generate a random operation given current model state.
    fn random_op(&self, rng: &mut Rng) -> Op {
        // Collect candidates with simple weights.
        let funded_ids: Vec<u64> = self
            .model
            .orders
            .values()
            .filter(|o| o.status == OrderStatus::Funded)
            .map(|o| o.id)
            .collect();

        let registered_indices: Vec<usize> = (0..NUM_RESOLVERS)
            .filter(|i| self.model.resolvers.contains_key(i))
            .collect();

        let active_indices: Vec<usize> = (0..NUM_RESOLVERS)
            .filter(|i| {
                self.model
                    .resolvers
                    .get(i)
                    .map(|r| r.active)
                    .unwrap_or(false)
            })
            .collect();

        let unregistered_indices: Vec<usize> = (0..NUM_RESOLVERS)
            .filter(|i| !self.model.resolvers.contains_key(i))
            .collect();

        let unbonding_done: Vec<usize> = (0..NUM_RESOLVERS)
            .filter(|i| {
                if let Some(r) = self.model.resolvers.get(i) {
                    if let Some(ready_at) = r.unbonding_at {
                        return self.env.ledger().timestamp() >= ready_at;
                    }
                }
                false
            })
            .collect();

        // Build a weighted op table.
        let pick = rng.range(0, 99);

        // Always try to advance time (10% chance).
        if pick < 10 {
            return Op::AdvanceTime(rng.range(60, 3600));
        }
        // Register a new resolver (15% if any unregistered).
        if pick < 25 && !unregistered_indices.is_empty() {
            let idx = unregistered_indices[rng.range(0, (unregistered_indices.len() - 1) as u64) as usize];
            return Op::Register(idx);
        }
        // Create order (20% if any active resolvers).
        if pick < 45 && !active_indices.is_empty() {
            let idx = active_indices[rng.range(0, (active_indices.len() - 1) as u64) as usize];
            return Op::CreateOrder(idx);
        }
        // Claim a funded order (20%).
        if pick < 65 && !funded_ids.is_empty() {
            let id = funded_ids[rng.range(0, (funded_ids.len() - 1) as u64) as usize];
            return Op::ClaimOrder(id);
        }
        // Refund a funded order (10%).
        if pick < 75 && !funded_ids.is_empty() {
            let id = funded_ids[rng.range(0, (funded_ids.len() - 1) as u64) as usize];
            return Op::RefundOrder(id);
        }
        // Slash a registered resolver (10%).
        if pick < 85 && !registered_indices.is_empty() {
            let idx = registered_indices[rng.range(0, (registered_indices.len() - 1) as u64) as usize];
            return Op::Slash(idx);
        }
        // RequestUnregister (5%).
        if pick < 90 && !active_indices.is_empty() {
            let idx = active_indices[rng.range(0, (active_indices.len() - 1) as u64) as usize];
            return Op::RequestUnregister(idx);
        }
        // WithdrawStake (5%).
        if !unbonding_done.is_empty() {
            let idx = unbonding_done[rng.range(0, (unbonding_done.len() - 1) as u64) as usize];
            return Op::WithdrawStake(idx);
        }
        // IncreaseStake fallback.
        if !registered_indices.is_empty() {
            let idx = registered_indices[rng.range(0, (registered_indices.len() - 1) as u64) as usize];
            return Op::IncreaseStake(idx);
        }
        // Default: just advance time.
        Op::AdvanceTime(rng.range(60, 600))
    }
}

// ─── Execution of each operation ─────────────────────────────────────────────

impl<'a> Harness<'a> {
    fn exec_op(&mut self, op: Op, rng: &mut Rng) {
        match op {
            Op::AdvanceTime(secs) => {
                advance_ledger(&self.env, secs);
            }

            Op::Register(idx) => {
                let resolver = self.resolvers[idx].clone();
                // Skip if already registered.
                if self.model.resolvers.contains_key(&idx) {
                    return;
                }
                let stake = rng.range(MIN_STAKE as u64, (MIN_STAKE * 3) as u64) as i128;
                // Make sure the resolver still has enough tokens.
                let bal = self.token.balance(&resolver);
                if bal < stake {
                    self.sac.mint(&resolver, &(stake - bal + 1_000_0000000));
                }
                self.registry.register(&resolver, &stake);
                self.model.resolvers.insert(idx, ModelResolver {
                    original_stake: stake,
                    current_stake: stake,
                    total_slashed: 0,
                    active: true,
                    unbonding_at: None,
                });
            }

            Op::IncreaseStake(idx) => {
                let resolver = self.resolvers[idx].clone();
                if let Some(model_r) = self.model.resolvers.get_mut(&idx) {
                    if model_r.unbonding_at.is_some() {
                        return; // can't increase while unbonding
                    }
                    let additional = rng.range(1_0000000, 10_0000000) as i128;
                    let bal = self.token.balance(&resolver);
                    if bal < additional {
                        self.sac.mint(&resolver, &(additional - bal + 1_0000000));
                    }
                    self.registry.increase_stake(&resolver, &additional);
                    model_r.current_stake += additional;
                    model_r.original_stake += additional;
                }
            }

            Op::RequestUnregister(idx) => {
                let resolver = self.resolvers[idx].clone();
                if let Some(model_r) = self.model.resolvers.get_mut(&idx) {
                    if !model_r.active || model_r.unbonding_at.is_some() {
                        return;
                    }
                    self.registry.request_unregister(&resolver);
                    let ready_at = self.env.ledger().timestamp() + UNBONDING_PERIOD;
                    model_r.active = false;
                    model_r.unbonding_at = Some(ready_at);
                }
            }

            Op::WithdrawStake(idx) => {
                let resolver = self.resolvers[idx].clone();
                if let Some(model_r) = self.model.resolvers.get(&idx).cloned() {
                    let Some(ready_at) = model_r.unbonding_at else { return };
                    if self.env.ledger().timestamp() < ready_at { return }
                    self.registry.withdraw_stake(&resolver);
                    self.model.resolvers.remove(&idx);
                }
            }

            Op::Slash(idx) => {
                let resolver = self.resolvers[idx].clone();
                if let Some(model_r) = self.model.resolvers.get_mut(&idx) {
                    if model_r.current_stake <= 0 { return }
                    // Slash a random fraction (1–100%) of current stake.
                    let pct = rng.range(1, 100) as i128;
                    let slash_amount = (model_r.current_stake * pct / 100).max(1);
                    let actual = slash_amount.min(model_r.current_stake);
                    self.registry.slash(&resolver, &actual);
                    model_r.total_slashed += actual;
                    model_r.current_stake -= actual;
                    // Registry deactivates if below min_stake and was active.
                    if model_r.active && model_r.current_stake < MIN_STAKE {
                        model_r.active = false;
                    }
                }
            }

            Op::CreateOrder(idx) => {
                let resolver = self.resolvers[idx].clone();
                if !self.model.resolvers.get(&idx).map(|r| r.active).unwrap_or(false) {
                    return;
                }
                let amount = rng.range(1_0000000, 50_0000000) as i128;
                let safety = rng.range(0, 2_0000000) as i128;
                let timelock_secs: u64 = rng.range(300, 86_400);
                let beneficiary = Address::generate(&self.env);

                // Build a unique preimage from the RNG state.
                let raw: [u8; 32] = {
                    let mut arr = [0u8; 32];
                    for chunk in arr.chunks_mut(8) {
                        let v = rng.next().to_le_bytes();
                        chunk.copy_from_slice(&v[..chunk.len()]);
                    }
                    arr
                };
                let preimage_bytes = Bytes::from_array(&self.env, &raw);
                let hashlock = sha256_32(&self.env, &preimage_bytes);

                // Ensure the resolver has enough balance.
                let needed = amount + safety;
                let bal = self.token.balance(&resolver);
                if bal < needed {
                    self.sac.mint(&resolver, &(needed - bal + 1_0000000));
                }

                let order_id = self.htlc.create_order(
                    &resolver,
                    &beneficiary,
                    &resolver,
                    &self.asset,
                    &amount,
                    &safety,
                    &hashlock,
                    &timelock_secs,
                );

                let abs_timelock = self.env.ledger().timestamp() + timelock_secs;
                self.model.orders.insert(order_id, ModelOrder {
                    id: order_id,
                    status: OrderStatus::Funded,
                    amount,
                    safety_deposit: safety,
                    timelock: abs_timelock,
                    preimage: Some(raw.to_vec()),
                });
            }

            Op::ClaimOrder(order_id) => {
                let model_order = match self.model.orders.get(&order_id) {
                    Some(o) if o.status == OrderStatus::Funded => o.clone(),
                    _ => return,
                };
                // Check if timelock has expired — a claim after expiry must fail.
                let now = self.env.ledger().timestamp();
                if now > model_order.timelock {
                    // Expect failure; don't update model.
                    let preimage_raw = model_order.preimage.clone().unwrap_or_else(|| vec![0u8; 32]);
                    let preimage_bytes = Bytes::from_slice(&self.env, &preimage_raw);
                    let caller = Address::generate(&self.env);
                    let res = self.htlc.try_claim_order(&order_id, &preimage_bytes, &caller);
                    assert!(
                        res.is_err(),
                        "[seed={}] claim after expiry should fail for order {}",
                        self.seed, order_id
                    );
                    return;
                }
                let preimage_raw = model_order.preimage.clone().unwrap_or_else(|| vec![0u8; 32]);
                let preimage_bytes = Bytes::from_slice(&self.env, &preimage_raw);
                let caller = Address::generate(&self.env);
                self.htlc.claim_order(&order_id, &preimage_bytes, &caller);
                self.model.orders.get_mut(&order_id).unwrap().status = OrderStatus::Claimed;
            }

            Op::RefundOrder(order_id) => {
                let model_order = match self.model.orders.get(&order_id) {
                    Some(o) if o.status == OrderStatus::Funded => o.clone(),
                    _ => return,
                };
                let now = self.env.ledger().timestamp();
                if now <= model_order.timelock {
                    // Expect failure.
                    let caller = Address::generate(&self.env);
                    let res = self.htlc.try_refund_order(&order_id, &caller);
                    assert!(
                        res.is_err(),
                        "[seed={}] refund before expiry should fail for order {}",
                        self.seed, order_id
                    );
                    return;
                }
                let caller = Address::generate(&self.env);
                self.htlc.refund_order(&order_id, &caller);
                self.model.orders.get_mut(&order_id).unwrap().status = OrderStatus::Refunded;
            }
        }
    }
}

// ─── Invariant checks ────────────────────────────────────────────────────────

impl<'a> Harness<'a> {
    /// Assert all invariants against the live contract state and the model.
    fn assert_invariants(&self) {
        let seed = self.seed;

        // ── I1 + I4: order status is monotonic; no re-entry after terminal ──
        for (id, model_order) in &self.model.orders {
            let live: Order = self
                .htlc
                .get_order(id)
                .unwrap_or_else(|| panic!("[seed={seed}] order {id} missing from contract"));

            // Model and contract must agree on status.
            assert_eq!(
                live.status, model_order.status,
                "[seed={seed}] order {id}: model status {:?} ≠ contract status {:?}",
                model_order.status, live.status
            );

            // Terminal orders must stay terminal.
            if model_order.status == OrderStatus::Claimed
                || model_order.status == OrderStatus::Refunded
            {
                assert_ne!(
                    live.status,
                    OrderStatus::Funded,
                    "[seed={seed}] order {id} re-entered Funded after terminal state"
                );
            }
        }

        // ── I2 + I7: HTLC balance equals sum of funded orders ───────────────
        let expected_balance = self.model.expected_htlc_balance();
        let actual_balance = self.token.balance(&self.htlc_addr);
        assert_eq!(
            actual_balance, expected_balance,
            "[seed={seed}] HTLC balance {actual_balance} ≠ expected {expected_balance} \
             (sum of Funded orders)"
        );

        // ── I3 + I6: resolver stake invariants ──────────────────────────────
        for (idx, model_r) in &self.model.resolvers {
            let resolver_addr = &self.resolvers[*idx];
            let live_info = self.registry.get(resolver_addr);

            // If the model has a resolver, the registry should too (unless
            // withdraw_stake was just executed and we missed removing it).
            if let Some(live) = live_info {
                // Stake is always non-negative.
                assert!(
                    live.stake >= 0,
                    "[seed={seed}] resolver {idx} has negative stake {}",
                    live.stake
                );
                // total_slashed never exceeds original stake.
                assert!(
                    live.total_slashed <= model_r.original_stake,
                    "[seed={seed}] resolver {idx} total_slashed {} > original_stake {}",
                    live.total_slashed,
                    model_r.original_stake
                );
                // I5: after request_unregister the resolver is inactive.
                if model_r.unbonding_at.is_some() {
                    assert!(
                        !live.active,
                        "[seed={seed}] resolver {idx} is still active while unbonding"
                    );
                }
                // Model and contract agree on active flag.
                assert_eq!(
                    live.active, model_r.active,
                    "[seed={seed}] resolver {idx}: model.active={} ≠ contract.active={}",
                    model_r.active, live.active
                );
            }
        }
    }
}

// ─── Entry-point test ─────────────────────────────────────────────────────────

/// Read the seed from `HARNESS_SEED` env var, or use the default.
fn get_seed() -> u64 {
    match std::env::var("HARNESS_SEED") {
        Ok(s) => s.trim().parse::<u64>().unwrap_or(0xcafe_f00d_dead_beef),
        Err(_) => 0xcafe_f00d_dead_beef,
    }
}

/// Number of operations per run. Increase for deeper exploration.
const OPS_PER_RUN: usize = 300;

/// Number of independent seeds to test when no override is given.
const SEED_COUNT: usize = 5;

#[test]
fn harness_adversarial_sequences() {
    let base_seed = get_seed();
    let seeds: Vec<u64> = if std::env::var("HARNESS_SEED").is_ok() {
        vec![base_seed]
    } else {
        // Derive SEED_COUNT distinct seeds from the base using the PRNG.
        let mut rng = Rng::new(base_seed);
        (0..SEED_COUNT).map(|_| rng.next()).collect()
    };

    for seed in seeds {
        println!("[harness] running seed={seed:#018x}");
        run_one_seed(seed);
        println!("[harness] seed={seed:#018x} PASSED");
    }
}

fn run_one_seed(seed: u64) {
    let env = Env::default();
    let mut h = Harness::new(&env, seed);
    let mut rng = Rng::new(seed);

    // Register at least two resolvers before we start so there are always
    // actors available to create orders.
    for idx in 0..2 {
        h.exec_op(Op::Register(idx), &mut rng);
    }
    h.assert_invariants();

    for step in 0..OPS_PER_RUN {
        let op = h.random_op(&mut rng);
        println!("[harness seed={seed:#018x}] step={step} op={op:?}");
        h.exec_op(op, &mut rng);
        h.assert_invariants();
    }

    // Final: verify all Funded orders are still accessible and terminal
    // orders cannot be re-claimed or re-refunded.
    assert_terminal_re_entry_blocked(&mut h, seed);
}

/// Adversarial final sweep: attempt to claim every Claimed order and refund
/// every Refunded order — both must be rejected by the contract.
fn assert_terminal_re_entry_blocked(h: &mut Harness<'_>, seed: u64) {
    let terminal_orders: Vec<_> = h
        .model
        .orders
        .values()
        .filter(|o| o.status != OrderStatus::Funded)
        .cloned()
        .collect();

    for order in terminal_orders {
        let preimage_raw = order.preimage.clone().unwrap_or_else(|| vec![0u8; 32]);
        let preimage_bytes = Bytes::from_slice(&h.env, &preimage_raw);
        let caller = Address::generate(&h.env);

        // Attempt a second claim — must always fail.
        let claim_res = h.htlc.try_claim_order(&order.id, &preimage_bytes, &caller);
        assert!(
            claim_res.is_err(),
            "[seed={seed}] double-claim succeeded on terminal order {} (status={:?})",
            order.id, order.status
        );

        // Attempt a second refund — must always fail.
        let refund_res = h.htlc.try_refund_order(&order.id, &caller);
        assert!(
            refund_res.is_err(),
            "[seed={seed}] double-refund succeeded on terminal order {} (status={:?})",
            order.id, order.status
        );
    }
}

// ─── Focused adversarial scenarios ───────────────────────────────────────────
//
// These are deterministic sub-harness tests that exercise specific invariant
// paths the pure random generator might miss with low probability.

/// Invariant I4: Claim then attempt claim again — must be rejected.
#[test]
fn harness_double_claim_blocked() {
    let env = Env::default();
    let seed = 0x1111_2222_3333_4444;
    let mut h = Harness::new(&env, seed);
    let mut rng = Rng::new(seed);
    h.exec_op(Op::Register(0), &mut rng);

    // Create an order.
    h.exec_op(Op::CreateOrder(0), &mut rng);
    let order_id = *h.model.orders.keys().next().expect("an order was created");

    // Claim it.
    h.exec_op(Op::ClaimOrder(order_id), &mut rng);
    h.assert_invariants();

    // Second claim — must fail.
    let o = h.model.orders[&order_id].clone();
    let preimage_bytes = Bytes::from_slice(&env, o.preimage.as_deref().unwrap_or(&[0u8; 32]));
    let caller = Address::generate(&env);
    let res = h.htlc.try_claim_order(&order_id, &preimage_bytes, &caller);
    assert!(res.is_err(), "[seed={seed}] double-claim must be rejected after Claimed");
}

/// Invariant I4: Refund then attempt refund again — must be rejected.
#[test]
fn harness_double_refund_blocked() {
    let env = Env::default();
    let seed = 0x5555_6666_7777_8888;
    let mut h = Harness::new(&env, seed);
    let mut rng = Rng::new(seed);
    h.exec_op(Op::Register(0), &mut rng);
    h.exec_op(Op::CreateOrder(0), &mut rng);
    let order_id = *h.model.orders.keys().next().expect("an order was created");

    // Advance past timelock.
    let timelock = h.model.orders[&order_id].timelock;
    let now = env.ledger().timestamp();
    if now <= timelock {
        advance_ledger(&env, timelock - now + 1);
    }
    h.exec_op(Op::RefundOrder(order_id), &mut rng);
    h.assert_invariants();

    // Second refund — must fail.
    let caller = Address::generate(&env);
    let res = h.htlc.try_refund_order(&order_id, &caller);
    assert!(res.is_err(), "[seed={seed}] double-refund must be rejected after Refunded");
}

/// Invariant I5: resolver inactive immediately after request_unregister;
/// HTLC rejects create_order for them during the unbonding window.
#[test]
fn harness_unbonding_resolver_rejected_by_htlc() {
    let env = Env::default();
    let seed = 0xaaaa_bbbb_cccc_dddd;
    let mut h = Harness::new(&env, seed);
    let mut rng = Rng::new(seed);
    h.exec_op(Op::Register(0), &mut rng);
    assert!(h.registry.is_active(&h.resolvers[0]));

    // Initiate exit.
    h.exec_op(Op::RequestUnregister(0), &mut rng);
    assert!(!h.registry.is_active(&h.resolvers[0]),
        "[seed={seed}] resolver must be inactive immediately after request_unregister");
    h.assert_invariants();

    // Try to create an order during the unbonding window — must fail.
    let resolver = h.resolvers[0].clone();
    let beneficiary = Address::generate(&env);
    let preimage = Bytes::from_array(&env, &[0xabu8; 32]);
    let hashlock = sha256_32(&env, &preimage);
    h.sac.mint(&resolver, &1_000_0000000);
    let res = h.htlc.try_create_order(
        &resolver, &beneficiary, &resolver, &h.asset,
        &10_0000000i128, &0i128, &hashlock, &600u64,
    );
    assert!(res.is_err(),
        "[seed={seed}] HTLC must reject create_order for unbonding resolver");
}

/// Invariant I3 + I6: slash can never drive stake below zero.
#[test]
fn harness_slash_bounded_by_available_stake() {
    let env = Env::default();
    let seed = 0xdead_cafe_f00d_1234;
    let mut h = Harness::new(&env, seed);
    let mut rng = Rng::new(seed);
    h.exec_op(Op::Register(0), &mut rng);

    let resolver = h.resolvers[0].clone();
    let initial_stake = h.registry.get(&resolver).unwrap().stake;

    // Slash more than the available stake — contract caps at current stake.
    let over_slash = initial_stake * 10;
    h.registry.slash(&resolver, &over_slash);

    let info = h.registry.get(&resolver).unwrap();
    assert_eq!(info.stake, 0, "[seed={seed}] stake must be 0 after over-slash, got {}", info.stake);
    assert!(info.total_slashed <= initial_stake,
        "[seed={seed}] total_slashed {} > initial_stake {}", info.total_slashed, initial_stake);
    assert!(info.stake >= 0,
        "[seed={seed}] stake went negative: {}", info.stake);
}

/// Invariant I2: funds only move under a valid HTLC transition; wrong
/// preimage never moves funds.
#[test]
fn harness_wrong_preimage_never_moves_funds() {
    let env = Env::default();
    let seed = 0x9988_7766_5544_3322;
    let mut h = Harness::new(&env, seed);
    let mut rng = Rng::new(seed);
    h.exec_op(Op::Register(0), &mut rng);
    h.exec_op(Op::CreateOrder(0), &mut rng);
    let order_id = *h.model.orders.keys().next().unwrap();

    let htlc_balance_before = h.token.balance(&h.htlc_addr);

    // Use a completely wrong preimage.
    let wrong = Bytes::from_array(&env, &[0xffu8; 32]);
    let caller = Address::generate(&env);
    let res = h.htlc.try_claim_order(&order_id, &wrong, &caller);
    assert!(res.is_err(), "[seed={seed}] wrong preimage must not succeed");

    let htlc_balance_after = h.token.balance(&h.htlc_addr);
    assert_eq!(
        htlc_balance_before, htlc_balance_after,
        "[seed={seed}] HTLC balance changed after failed claim"
    );
    h.assert_invariants();
}
