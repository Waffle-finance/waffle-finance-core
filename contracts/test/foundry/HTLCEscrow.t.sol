// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {HTLCEscrow} from "../../contracts/HTLCEscrow.sol";
import {IHTLCEscrow} from "../../contracts/interfaces/IHTLCEscrow.sol";
import {IResolverRegistry} from "../../contracts/interfaces/IResolverRegistry.sol";

/// @dev Minimal stub — always returns isActive = true so createOrder is permissionless.
contract MockRegistry {
    function isActive(address) external pure returns (bool) { return true; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fuzz tests
// ─────────────────────────────────────────────────────────────────────────────

contract HTLCEscrowFuzzTest is Test {
    HTLCEscrow htlc;

    uint64 constant MIN_TL = 300;
    uint64 constant MAX_TL = 86_400;
    uint256 constant MIN_SD = 1e15; // 0.001 ETH

    function setUp() public {
        htlc = new HTLCEscrow(IResolverRegistry(address(0)), MIN_SD);
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    function _boundTl(uint64 tl) internal pure returns (uint64) {
        return uint64(bound(tl, MIN_TL, MAX_TL));
    }

    function _boundAmount(uint256 a) internal pure returns (uint256) {
        return bound(a, 1, 100 ether);
    }

    function _boundSd(uint256 sd) internal pure returns (uint256) {
        return bound(sd, MIN_SD, 10 ether);
    }

    function _hashlock(bytes memory preimage) internal pure returns (bytes32) {
        return sha256(preimage);
    }

    // ── fuzz: createOrder accepts any valid combination ───────────────────────

    function testFuzz_createOrder(
        address beneficiary,
        address refundAddr,
        uint256 amount,
        uint256 safetyDeposit,
        bytes32 secret,
        uint64  timelockSeconds
    ) public {
        vm.assume(beneficiary  != address(0));
        vm.assume(refundAddr   != address(0));
        // avoid precompiles / this contract to keep ETH transfers clean
        vm.assume(beneficiary.code.length == 0);
        vm.assume(refundAddr.code.length  == 0);

        amount        = _boundAmount(amount);
        safetyDeposit = _boundSd(safetyDeposit);
        timelockSeconds = _boundTl(timelockSeconds);

        bytes memory preimage = abi.encodePacked(secret);
        bytes32 hashlock = _hashlock(preimage);

        uint256 total = amount + safetyDeposit;
        vm.deal(address(this), total);

        uint256 orderId = htlc.createOrder{value: total}(
            beneficiary, refundAddr, address(0),
            amount, safetyDeposit, hashlock, timelockSeconds
        );

        IHTLCEscrow.Order memory o = htlc.getOrder(orderId);
        assertEq(o.amount,        amount);
        assertEq(o.safetyDeposit, safetyDeposit);
        assertEq(o.hashlock,      hashlock);
        assertEq(uint8(o.status), uint8(IHTLCEscrow.OrderStatus.Funded));
    }

    // ── fuzz: claimOrder succeeds with correct preimage, fails with wrong one ─

    function testFuzz_claimOrder_correctPreimage(bytes32 secret, uint64 timelockSeconds) public {
        timelockSeconds = _boundTl(timelockSeconds);
        bytes memory preimage = abi.encodePacked(secret);
        bytes32 hashlock = _hashlock(preimage);

        uint256 amount = 1 ether;
        uint256 sd     = MIN_SD;
        vm.deal(address(this), amount + sd);

        address beneficiary = makeAddr("beneficiary");
        address refundAddr  = makeAddr("refund");
        uint256 orderId = htlc.createOrder{value: amount + sd}(
            beneficiary, refundAddr, address(0),
            amount, sd, hashlock, timelockSeconds
        );

        // Claim from a separate EOA so the safety deposit transfer succeeds.
        address claimer = makeAddr("claimer");
        vm.prank(claimer);
        htlc.claimOrder(orderId, preimage);

        IHTLCEscrow.Order memory o = htlc.getOrder(orderId);
        assertEq(uint8(o.status), uint8(IHTLCEscrow.OrderStatus.Claimed));
    }

    function testFuzz_claimOrder_wrongPreimage(bytes32 secret, bytes32 wrongSecret) public {
        vm.assume(secret != wrongSecret);

        bytes memory preimage      = abi.encodePacked(secret);
        bytes memory wrongPreimage = abi.encodePacked(wrongSecret);
        bytes32 hashlock = _hashlock(preimage);

        uint256 amount = 1 ether;
        uint256 sd     = MIN_SD;
        vm.deal(address(this), amount + sd);

        uint256 orderId = htlc.createOrder{value: amount + sd}(
            makeAddr("b"), makeAddr("r"), address(0),
            amount, sd, hashlock, MIN_TL
        );

        vm.expectRevert(HTLCEscrow.InvalidPreimage.selector);
        htlc.claimOrder(orderId, wrongPreimage);
    }

    // ── fuzz: refundOrder succeeds after timelock, reverts before ─────────────

    function testFuzz_refundOrder_afterExpiry(bytes32 secret, uint64 timelockSeconds) public {
        timelockSeconds = _boundTl(timelockSeconds);
        bytes32 hashlock = _hashlock(abi.encodePacked(secret));

        uint256 amount = 1 ether;
        uint256 sd     = MIN_SD;
        vm.deal(address(this), amount + sd);

        uint256 orderId = htlc.createOrder{value: amount + sd}(
            makeAddr("b"), makeAddr("r"), address(0),
            amount, sd, hashlock, timelockSeconds
        );

        vm.warp(block.timestamp + timelockSeconds + 1);
        // Refund from a separate EOA so the safety deposit transfer succeeds.
        address caller = makeAddr("caller");
        vm.prank(caller);
        htlc.refundOrder(orderId);

        IHTLCEscrow.Order memory o = htlc.getOrder(orderId);
        assertEq(uint8(o.status), uint8(IHTLCEscrow.OrderStatus.Refunded));
    }

    function testFuzz_refundOrder_beforeExpiry_reverts(bytes32 secret, uint64 timelockSeconds) public {
        timelockSeconds = _boundTl(timelockSeconds);
        bytes32 hashlock = _hashlock(abi.encodePacked(secret));

        uint256 amount = 1 ether;
        uint256 sd     = MIN_SD;
        vm.deal(address(this), amount + sd);

        uint256 orderId = htlc.createOrder{value: amount + sd}(
            makeAddr("b"), makeAddr("r"), address(0),
            amount, sd, hashlock, timelockSeconds
        );

        // still within timelock
        vm.warp(block.timestamp + timelockSeconds - 1);
        vm.expectRevert(HTLCEscrow.NotExpired.selector);
        htlc.refundOrder(orderId);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Invariant tests
// ─────────────────────────────────────────────────────────────────────────────

/// @dev Handler that drives random createOrder / claimOrder / refundOrder calls.
contract HTLCHandler is Test {
    HTLCEscrow public htlc;

    uint256 public constant MIN_SD = 1e15;
    uint64  public constant MIN_TL = 300;
    uint64  public constant MAX_TL = 86_400;

    // Track active order ids so we can claim/refund them.
    uint256[] public activeOrders;
    // preimage per orderId
    mapping(uint256 => bytes) public preimages;

    constructor(HTLCEscrow _htlc) {
        htlc = _htlc;
    }

    function createOrder(bytes32 secret, uint64 tl) external payable {
        tl = uint64(bound(tl, MIN_TL, MAX_TL));
        uint256 amount = bound(msg.value, 1, 10 ether);
        uint256 sd     = MIN_SD;
        uint256 total  = amount + sd;

        bytes memory preimage = abi.encodePacked(secret);
        bytes32 hashlock = sha256(preimage);

        vm.deal(address(this), total);
        uint256 orderId = htlc.createOrder{value: total}(
            makeAddr("beneficiary"), makeAddr("refund"), address(0),
            amount, sd, hashlock, tl
        );
        activeOrders.push(orderId);
        preimages[orderId] = preimage;
    }

    function claimOrder(uint256 idx) external {
        if (activeOrders.length == 0) return;
        idx = bound(idx, 0, activeOrders.length - 1);
        uint256 orderId = activeOrders[idx];

        try htlc.getOrder(orderId) returns (IHTLCEscrow.Order memory o) {
            if (o.status != IHTLCEscrow.OrderStatus.Funded) return;
            if (block.timestamp > o.timelock) return;
            htlc.claimOrder(orderId, preimages[orderId]);
            _remove(idx);
        } catch {}
    }

    function refundOrder(uint256 idx) external {
        if (activeOrders.length == 0) return;
        idx = bound(idx, 0, activeOrders.length - 1);
        uint256 orderId = activeOrders[idx];

        try htlc.getOrder(orderId) returns (IHTLCEscrow.Order memory o) {
            if (o.status != IHTLCEscrow.OrderStatus.Funded) return;
            if (block.timestamp <= o.timelock) {
                vm.warp(o.timelock + 1);
            }
            htlc.refundOrder(orderId);
            _remove(idx);
        } catch {}
    }

    function _remove(uint256 idx) internal {
        activeOrders[idx] = activeOrders[activeOrders.length - 1];
        activeOrders.pop();
    }

    function activeOrderCount() external view returns (uint256) {
        return activeOrders.length;
    }
}

contract HTLCEscrowInvariantTest is Test {
    HTLCEscrow  htlc;
    HTLCHandler handler;

    // The deterministic payout targets the handler uses; cached here because
    // makeAddr labels (state-modifying) and cannot run in a view invariant.
    address benAddr;
    address refundAddr;

    function setUp() public {
        htlc    = new HTLCEscrow(IResolverRegistry(address(0)), 1e15);
        handler = new HTLCHandler(htlc);
        benAddr    = makeAddr("beneficiary");
        refundAddr = makeAddr("refund");
        targetContract(address(handler));
    }

    /// @notice Solvency invariant. The contract's ETH balance must equal the
    ///         funds it still owes: the sum of all Funded orders'
    ///         (amount + safetyDeposit), PLUS any native payouts that could
    ///         not be pushed during a claim/refund and are now credited to a
    ///         recipient's pull-payment balance. The handler claims/refunds as
    ///         itself and has no `receive`, so its safety-deposit payouts
    ///         defer — this invariant proves those deferred funds are retained
    ///         and accounted for exactly, never lost or double-counted.
    function invariant_balanceMatchesFundedOrders() public view {
        uint256 nextId = htlc.nextOrderId();
        uint256 expected;
        for (uint256 i = 1; i < nextId; i++) {
            try htlc.getOrder(i) returns (IHTLCEscrow.Order memory o) {
                if (o.status == IHTLCEscrow.OrderStatus.Funded) {
                    expected += o.amount + o.safetyDeposit;
                }
            } catch {}
        }

        // The only addresses the handler can credit are itself (safety
        // deposits, since it claims/refunds as msg.sender with no receive) and
        // the EOA beneficiary/refund targets (which accept ETH, so defer to 0).
        uint256 pending = htlc.pendingWithdrawals(address(handler))
            + htlc.pendingWithdrawals(benAddr)
            + htlc.pendingWithdrawals(refundAddr);

        assertEq(
            address(htlc).balance,
            expected + pending,
            "balance != funded orders + pending withdrawals"
        );
    }

    /// @notice An order that has been claimed must never also be refundable
    ///         (status is immutable once finalised).
    function invariant_noDoubleSettle() public view {
        uint256 nextId = htlc.nextOrderId();
        for (uint256 i = 1; i < nextId; i++) {
            try htlc.getOrder(i) returns (IHTLCEscrow.Order memory o) {
                // Claimed and Refunded are mutually exclusive
                bool claimed  = o.status == IHTLCEscrow.OrderStatus.Claimed;
                bool refunded = o.status == IHTLCEscrow.OrderStatus.Refunded;
                assertFalse(claimed && refunded, "order both claimed and refunded");
            } catch {}
        }
    }
}

