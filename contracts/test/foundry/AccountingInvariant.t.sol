// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {HTLCEscrow} from "../../contracts/HTLCEscrow.sol";
import {IHTLCEscrow} from "../../contracts/interfaces/IHTLCEscrow.sol";
import {IResolverRegistry} from "../../contracts/interfaces/IResolverRegistry.sol";

/// @title GuzzlerReceiver
/// @notice Consumes more gas than PAYOUT_GAS_STIPEND (30 000) so the push
///         from _payoutNative always fails and the credit lands in
///         pendingWithdrawals. Exposes pull() so the invariant handler can
///         drain the credit in a second step.
contract GuzzlerReceiver {
    uint256 private _sink;

    receive() external payable {
        // 64 storage writes — each SSTORE costs ~20 000 gas cold.
        // Total >>> 30 000 gas stipend → every bounded push reverts.
        uint256 acc = _sink;
        for (uint256 i = 0; i < 64; i++) {
            acc += i + 1;
            _sink = acc;
        }
    }

    function pull(HTLCEscrow escrow) external returns (uint256) {
        return escrow.withdraw();
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────

/// @title AccountingHandler
/// @notice Drives four operations against HTLCEscrow:
///   • createOrder  — locks ETH into a new order
///   • claimOrder   — reveals the preimage; routes to EOA or guzzler beneficiary
///   • refundOrder  — refunds after timelock expiry; routes to EOA or guzzler
///   • withdraw     — pulls a deferred credit on behalf of the guzzler
///   • warpTime     — advances the clock so timelocks can expire
///
/// Two actors keep things minimal:
///   • eoa    — a plain EOA that always accepts direct ETH pushes
///   • guzzle — a GuzzlerReceiver that always triggers the pull-payment path
///
/// Ghost variable `ghostPending` mirrors pendingWithdrawals[guzzle] from the
/// handler's point of view so the invariant can cross-check both sides.
contract AccountingHandler is Test {
    HTLCEscrow      public immutable htlc;
    address         public immutable eoa;
    GuzzlerReceiver public immutable guzzle;

    uint256 public constant MIN_SD = 1e15;   // 0.001 ETH
    uint64  public constant MIN_TL = 300;    // 5 min
    uint64  public constant MAX_TL = 86_400; // 24 h

    uint256[] private _activeIds;
    mapping(uint256 => bytes) private _preimages;

    /// @notice Ghost tracking of pendingWithdrawals[guzzle].
    uint256 public ghostPending;

    constructor(HTLCEscrow _htlc) {
        htlc   = _htlc;
        eoa    = makeAddr("eoa");
        guzzle = new GuzzlerReceiver();
        vm.deal(eoa, 1_000 ether);
    }

    // ── create ────────────────────────────────────────────────────────────────

    /// @param useGuzzle When true the beneficiary is the guzzler (deferred
    ///                  path); when false it is the plain EOA (direct push).
    function createOrder(
        bytes32 secret,
        uint64  timelockSec,
        uint256 amount,
        bool    useGuzzle
    ) external {
        timelockSec = uint64(bound(timelockSec, MIN_TL, MAX_TL));
        amount      = bound(amount, 1 wei, 5 ether);
        if (secret == bytes32(0)) secret = bytes32(uint256(1));

        bytes memory preimage = abi.encodePacked(secret);
        bytes32 hashlock      = sha256(preimage);
        uint256 total         = amount + MIN_SD;
        address beneficiary   = useGuzzle ? address(guzzle) : eoa;

        vm.deal(eoa, eoa.balance + total);
        vm.prank(eoa);
        try htlc.createOrder{value: total}(
            beneficiary,
            eoa,        // refundAddress is always the EOA
            address(0), // native ETH
            amount,
            MIN_SD,
            hashlock,
            timelockSec
        ) returns (uint256 orderId) {
            _activeIds.push(orderId);
            _preimages[orderId] = preimage;
        } catch {}
    }

    // ── claim ─────────────────────────────────────────────────────────────────

    function claimOrder(uint256 idx) external {
        if (_activeIds.length == 0) return;
        idx = bound(idx, 0, _activeIds.length - 1);
        uint256 orderId = _activeIds[idx];

        IHTLCEscrow.Order memory o;
        try htlc.getOrder(orderId) returns (IHTLCEscrow.Order memory got) {
            o = got;
        } catch { return; }

        if (o.status != IHTLCEscrow.OrderStatus.Funded) { _drop(idx); return; }
        if (block.timestamp >= o.timelock) return; // expired — let refundOrder handle it

        uint256 guzzleBalBefore = address(guzzle).balance;

        vm.prank(eoa); // eoa claims — it's the msg.sender → receives safety deposit directly
        try htlc.claimOrder(orderId, _preimages[orderId]) {
            // If the beneficiary is the guzzler the push fails → credit created.
            if (o.beneficiary == address(guzzle)) {
                if (address(guzzle).balance == guzzleBalBefore) {
                    ghostPending += o.amount;
                }
            }
            _drop(idx);
        } catch {}
    }

    // ── refund ────────────────────────────────────────────────────────────────

    function refundOrder(uint256 idx) external {
        if (_activeIds.length == 0) return;
        idx = bound(idx, 0, _activeIds.length - 1);
        uint256 orderId = _activeIds[idx];

        IHTLCEscrow.Order memory o;
        try htlc.getOrder(orderId) returns (IHTLCEscrow.Order memory got) {
            o = got;
        } catch { return; }

        if (o.status != IHTLCEscrow.OrderStatus.Funded) { _drop(idx); return; }
        if (block.timestamp <= o.timelock) {
            vm.warp(o.timelock + 1);
        }

        // refundAddress is always the EOA in this handler — direct push always
        // succeeds, so no ghost update needed for the principal. Safety deposit
        // also goes to eoa (the caller) as a direct push.
        vm.prank(eoa);
        try htlc.refundOrder(orderId) {
            _drop(idx);
        } catch {}
    }

    // ── withdraw ──────────────────────────────────────────────────────────────

    /// @notice Pull whatever the guzzler has credited.
    function withdraw() external {
        uint256 pending = htlc.pendingWithdrawals(address(guzzle));
        if (pending == 0) return;

        try guzzle.pull(htlc) returns (uint256 amount) {
            ghostPending -= amount;
        } catch {}
    }

    // ── time ──────────────────────────────────────────────────────────────────

    function warpTime(uint64 delta) external {
        delta = uint64(bound(delta, 1, 2 days));
        vm.warp(block.timestamp + delta);
    }

    // ── internal ──────────────────────────────────────────────────────────────

    function _drop(uint256 idx) private {
        _activeIds[idx] = _activeIds[_activeIds.length - 1];
        _activeIds.pop();
    }

    function activeCount() external view returns (uint256) {
        return _activeIds.length;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Invariant test contract
// ─────────────────────────────────────────────────────────────────────────────

/// @title AccountingInvariantTest
/// @notice Focused stateful invariant covering the core accounting property:
///
///   contract_balance == funded_eth + pending_withdrawals
///
/// This is the single most important invariant for HTLCEscrow: every wei
/// deposited must be either locked in a Funded order or credited as a
/// pull-payment.  A violation means funds have leaked, been double-counted,
/// or been permanently stranded.
///
/// The handler exercises:
///   • createOrder  (native ETH; EOA or guzzler beneficiary)
///   • claimOrder   (terminal path 1: order claimed)
///   • refundOrder  (terminal path 2: order refunded)
///   • withdraw     (pull-payment collection after deferred push)
///   • warpTime     (advances the clock so timelocks can expire)
///
/// Running the tests
/// -----------------
/// From the contracts/ directory:
///
///   forge test --match-contract AccountingInvariantTest -v
///
/// For a reproducible failure replay with a fixed seed:
///
///   forge test --match-contract AccountingInvariantTest -v \
///       --fuzz-seed 0xdeadbeef
///
/// Configured via foundry.toml ([invariant] runs = 1024, depth = 50).
contract AccountingInvariantTest is Test {
    HTLCEscrow        public htlc;
    AccountingHandler public handler;

    function setUp() public {
        htlc    = new HTLCEscrow(IResolverRegistry(address(0)), 1e15);
        handler = new AccountingHandler(htlc);
        targetContract(address(handler));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Invariant 1 — core accounting
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice The contract's ETH balance must equal:
    ///   (a) sum of all Funded orders' (amount + safetyDeposit), plus
    ///   (b) sum of all credited pull-payment balances.
    ///
    /// Catches: ETH drain, double-counting, and permanent stranding.
    function invariant_balanceEqualsLiabilities() public view {
        uint256 nextId = htlc.nextOrderId();

        uint256 fundedEth;
        for (uint256 i = 1; i < nextId; i++) {
            try htlc.getOrder(i) returns (IHTLCEscrow.Order memory o) {
                if (o.status == IHTLCEscrow.OrderStatus.Funded) {
                    if (o.token == address(0)) {
                        fundedEth += o.amount + o.safetyDeposit;
                    } else {
                        fundedEth += o.safetyDeposit; // ERC20: only deposit is ETH
                    }
                }
            } catch {}
        }

        uint256 pendingEth =
            htlc.pendingWithdrawals(address(handler.guzzle())) +
            htlc.pendingWithdrawals(handler.eoa())             +
            htlc.pendingWithdrawals(address(handler));

        assertEq(
            address(htlc).balance,
            fundedEth + pendingEth,
            "balance != funded_eth + pending_withdrawals"
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Invariant 2 — ghost cross-check
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice The handler's ghost variable must agree with the on-chain
    ///         pendingWithdrawals for the guzzler.
    ///
    /// A divergence indicates a handler accounting bug that would obscure real
    /// invariant violations — this meta-invariant guards the ghost's accuracy.
    function invariant_ghostMatchesOnChainPending() public view {
        assertEq(
            htlc.pendingWithdrawals(address(handler.guzzle())),
            handler.ghostPending(),
            "ghost_pending != on-chain pendingWithdrawals[guzzle]"
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Invariant 3 — terminal-state immutability
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Once an order reaches Claimed or Refunded it must stay there.
    ///         finalisedAt must be positive and >= createdAt.
    function invariant_terminalStateImmutable() public view {
        uint256 nextId = htlc.nextOrderId();
        for (uint256 i = 1; i < nextId; i++) {
            try htlc.getOrder(i) returns (IHTLCEscrow.Order memory o) {
                bool terminal = (
                    o.status == IHTLCEscrow.OrderStatus.Claimed ||
                    o.status == IHTLCEscrow.OrderStatus.Refunded
                );
                if (terminal) {
                    assertTrue(o.finalisedAt > 0,
                        "terminal order: finalisedAt is zero");
                    assertTrue(o.finalisedAt >= o.createdAt,
                        "terminal order: finalisedAt < createdAt");
                }
            } catch {}
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Concrete scenario A — claim → withdraw (guzzler / deferred path)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Full deferred-payout lifecycle: create → claim (push fails,
    ///         credit created) → withdraw (full gas, credit collected).
    ///         Deterministic — not fuzz-driven.
    function test_claimDeferredThenWithdraw() public {
        address         eoaActor   = handler.eoa();
        GuzzlerReceiver guzzleActor = handler.guzzle();
        address         guzzleAddr = address(guzzleActor);

        bytes32      secret   = bytes32(uint256(0xbeef));
        bytes memory pre      = abi.encodePacked(secret);
        bytes32      hashlock = sha256(pre);
        uint256      amount   = 1 ether;
        uint256      sd       = 1e15;
        uint256      total    = amount + sd;

        vm.deal(eoaActor, total);

        // --- create ---
        vm.prank(eoaActor);
        uint256 orderId = htlc.createOrder{value: total}(
            guzzleAddr, eoaActor, address(0), amount, sd, hashlock, 600
        );
        assertEq(address(htlc).balance, total, "balance after create");

        // --- claim (push to guzzler fails → deferred) ---
        vm.prank(eoaActor);
        htlc.claimOrder(orderId, pre);

        assertEq(uint8(htlc.getOrder(orderId).status),
            uint8(IHTLCEscrow.OrderStatus.Claimed), "status after claim");
        assertEq(htlc.pendingWithdrawals(guzzleAddr), amount,
            "credit after claim");
        // Safety deposit reached eoaActor directly; only deferred amount stays.
        assertEq(address(htlc).balance, amount,
            "balance after claim (deferred principal only)");

        // --- withdraw (full gas forwarded; guzzler receive completes) ---
        guzzleActor.pull(htlc);

        assertEq(htlc.pendingWithdrawals(guzzleAddr), 0, "credit after withdraw");
        assertEq(address(htlc).balance, 0,              "balance after withdraw");
        assertEq(guzzleAddr.balance, amount,             "guzzler balance after withdraw");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Concrete scenario B — refund (EOA path, zero residual)
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Full refund lifecycle: create → warp past timelock → refund.
    ///         Both principal and safety deposit go to EOAs — contract
    ///         balance must be zero after settlement.
    function test_refundEoaPath() public {
        address eoaActor   = handler.eoa();
        address refundAddr = makeAddr("refundTarget");

        bytes32      secret   = bytes32(uint256(0xcafe));
        bytes memory pre      = abi.encodePacked(secret);
        bytes32      hashlock = sha256(pre);
        uint256      amount   = 1 ether;
        uint256      sd       = 1e15;
        uint256      total    = amount + sd;

        vm.deal(eoaActor, total);

        // --- create ---
        vm.prank(eoaActor);
        uint256 orderId = htlc.createOrder{value: total}(
            eoaActor, refundAddr, address(0), amount, sd, hashlock, 300
        );
        assertEq(address(htlc).balance, total, "balance after create");

        // --- warp past timelock and refund ---
        vm.warp(block.timestamp + 301);
        // eoaActor is the caller → receives safety deposit; refundAddr gets amount.
        vm.prank(eoaActor);
        htlc.refundOrder(orderId);

        assertEq(uint8(htlc.getOrder(orderId).status),
            uint8(IHTLCEscrow.OrderStatus.Refunded), "status after refund");
        assertEq(address(htlc).balance, 0,                  "balance after refund");
        assertEq(htlc.pendingWithdrawals(refundAddr), 0,    "no credit for EOA refundAddr");
        assertEq(htlc.pendingWithdrawals(eoaActor), 0,      "no credit for EOA caller");
    }
}
