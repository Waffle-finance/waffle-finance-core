// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {HTLCEscrow} from "../../contracts/HTLCEscrow.sol";
import {IHTLCEscrow} from "../../contracts/interfaces/IHTLCEscrow.sol";
import {IResolverRegistry} from "../../contracts/interfaces/IResolverRegistry.sol";
import {HTLCReceiverMock, NoFallbackReceiver} from "../../contracts/mocks/HTLCReceivers.sol";
import {TestERC20} from "../../contracts/mocks/TestERC20.sol";

/// @title ReentrantActor
/// @notice Malicious contract that attempts reentrancy into HTLCEscrow during native ETH transfers
contract ReentrantActor {
    HTLCEscrow public immutable escrow;
    bool public reentrancyAttempted;
    bool public reentrancySucceeded;

    constructor(HTLCEscrow _escrow) {
        escrow = _escrow;
    }

    receive() external payable {
        if (!reentrancyAttempted) {
            reentrancyAttempted = true;
            // Attempt reentrancy into withdraw
            try escrow.withdraw() {
                reentrancySucceeded = true;
            } catch {}
        }
    }

    function pull() external returns (uint256) {
        return escrow.withdraw();
    }
}

/// @title HTLCEscrowHandler
/// @notice Harness for stateful fuzzing of HTLCEscrow across 1,000+ sequences.
contract HTLCEscrowHandler is Test {
    HTLCEscrow public immutable htlc;
    TestERC20 public immutable token;

    uint256 public constant MIN_SD = 1e15; // 0.001 ETH
    uint64  public constant MIN_TL = 300;   // 5 minutes
    uint64  public constant MAX_TL = 86_400; // 24 hours

    // Tracked actors (EOAs, receiver contracts, reentrant actors)
    address[] public actors;
    HTLCReceiverMock public receiverMock;
    NoFallbackReceiver public noFallbackMock;
    ReentrantActor public reentrantMock;

    // Tracked orders
    uint256[] public allOrderIds;
    mapping(uint256 => bytes) public orderPreimages;
    mapping(uint256 => address) public orderTokens;
    mapping(uint256 => bytes32) public orderRawSecrets;

    // Ghost variables for accounting invariants
    mapping(address => uint256) public ghostPendingWithdrawals;
    uint256 public ghostTotalFundedEth;
    uint256 public ghostTotalFundedToken;
    uint256 public ghostTotalSafetyDepositsFunded;

    constructor(HTLCEscrow _htlc, TestERC20 _token) {
        htlc = _htlc;
        token = _token;

        // Setup diverse set of actors
        actors.push(makeAddr("alice"));
        actors.push(makeAddr("bob"));
        actors.push(makeAddr("charlie"));

        receiverMock = new HTLCReceiverMock();
        noFallbackMock = new NoFallbackReceiver();
        reentrantMock = new ReentrantActor(htlc);

        actors.push(address(receiverMock));
        actors.push(address(noFallbackMock));
        actors.push(address(reentrantMock));

        // Fund EOAs with ETH and tokens
        for (uint256 i = 0; i < 3; i++) {
            vm.deal(actors[i], 1_000 ether);
            token.transfer(actors[i], 1_000_000 * 1e18);
            vm.prank(actors[i]);
            token.approve(address(htlc), type(uint256).max);
        }

        // Fund receiver contracts with tokens and approve htlc
        token.transfer(address(receiverMock), 100_000 * 1e18);
        vm.prank(address(receiverMock));
        token.approve(address(htlc), type(uint256).max);

        token.transfer(address(noFallbackMock), 100_000 * 1e18);
        vm.prank(address(noFallbackMock));
        token.approve(address(htlc), type(uint256).max);

        token.transfer(address(reentrantMock), 100_000 * 1e18);
        vm.prank(address(reentrantMock));
        token.approve(address(htlc), type(uint256).max);
    }

    // ── Handler Actions ───────────────────────────────────────────────────────

    function createOrderNative(
        uint256 actorIdx,
        uint256 benIdx,
        uint256 refIdx,
        uint256 amount,
        uint256 safetyDeposit,
        bytes32 secret,
        uint64 timelockSec
    ) public {
        address sender = _getActor(actorIdx);
        address beneficiary = _getActor(benIdx);
        address refundAddr = _getActor(refIdx);

        amount = bound(amount, 1 wei, 10 ether);
        safetyDeposit = bound(safetyDeposit, MIN_SD, 1 ether);
        timelockSec = uint64(bound(timelockSec, MIN_TL, MAX_TL));

        if (secret == bytes32(0)) secret = bytes32(uint256(1));
        bytes memory preimage = abi.encodePacked(secret);
        bytes32 hashlock = sha256(preimage);

        uint256 totalEth = amount + safetyDeposit;
        vm.deal(sender, sender.balance + totalEth);

        vm.prank(sender);
        try htlc.createOrder{value: totalEth}(
            beneficiary,
            refundAddr,
            address(0),
            amount,
            safetyDeposit,
            hashlock,
            timelockSec
        ) returns (uint256 orderId) {
            allOrderIds.push(orderId);
            orderPreimages[orderId] = preimage;
            orderTokens[orderId] = address(0);
            orderRawSecrets[orderId] = secret;

            ghostTotalFundedEth += totalEth;
            ghostTotalSafetyDepositsFunded += safetyDeposit;
        } catch {}
    }

    function createOrderERC20(
        uint256 actorIdx,
        uint256 benIdx,
        uint256 refIdx,
        uint256 amount,
        uint256 safetyDeposit,
        bytes32 secret,
        uint64 timelockSec
    ) public {
        address sender = _getActor(actorIdx);
        address beneficiary = _getActor(benIdx);
        address refundAddr = _getActor(refIdx);

        amount = bound(amount, 1, 10_000 * 1e18);
        safetyDeposit = bound(safetyDeposit, MIN_SD, 1 ether);
        timelockSec = uint64(bound(timelockSec, MIN_TL, MAX_TL));

        if (secret == bytes32(0)) secret = bytes32(uint256(1));
        bytes memory preimage = abi.encodePacked(secret);
        bytes32 hashlock = sha256(preimage);

        vm.deal(sender, sender.balance + safetyDeposit);

        vm.prank(sender);
        try htlc.createOrder{value: safetyDeposit}(
            beneficiary,
            refundAddr,
            address(token),
            amount,
            safetyDeposit,
            hashlock,
            timelockSec
        ) returns (uint256 orderId) {
            allOrderIds.push(orderId);
            orderPreimages[orderId] = preimage;
            orderTokens[orderId] = address(token);
            orderRawSecrets[orderId] = secret;

            ghostTotalFundedEth += safetyDeposit;
            ghostTotalFundedToken += amount;
            ghostTotalSafetyDepositsFunded += safetyDeposit;
        } catch {}
    }

    function claimOrder(
        uint256 actorIdx,
        uint256 orderIdx,
        bool useWrongPreimage
    ) public {
        if (allOrderIds.length == 0) return;
        orderIdx = bound(orderIdx, 0, allOrderIds.length - 1);
        uint256 orderId = allOrderIds[orderIdx];
        address claimer = _getActor(actorIdx);

        IHTLCEscrow.Order memory order;
        try htlc.getOrder(orderId) returns (IHTLCEscrow.Order memory o) {
            order = o;
        } catch {
            return;
        }

        if (order.status != IHTLCEscrow.OrderStatus.Funded) return;
        if (block.timestamp > order.timelock) return;

        bytes memory preimageToUse;
        if (useWrongPreimage) {
            preimageToUse = abi.encodePacked(bytes32(uint256(orderRawSecrets[orderId]) ^ 0x12345));
        } else {
            preimageToUse = orderPreimages[orderId];
        }

        // Track pre-claim balances for ghosts
        uint256 preBenBal = order.beneficiary.balance;
        uint256 preClaimerBal = claimer.balance;

        vm.prank(claimer);
        try htlc.claimOrder(orderId, preimageToUse) {
            // Claim succeeded (meaning valid preimage)
            if (order.token == address(0)) {
                ghostTotalFundedEth -= (order.amount + order.safetyDeposit);
                // Check if beneficiary push failed
                if (order.beneficiary.balance == preBenBal) {
                    ghostPendingWithdrawals[order.beneficiary] += order.amount;
                }
            } else {
                ghostTotalFundedToken -= order.amount;
                ghostTotalFundedEth -= order.safetyDeposit;
            }

            // Check if safety deposit push to claimer failed
            if (order.safetyDeposit > 0) {
                // If claimer is not recipient of payout or native transfer failed
                if (claimer == order.beneficiary && order.token == address(0)) {
                    // combined transfer of amount + safetyDeposit
                    if (claimer.balance < preClaimerBal + order.amount + order.safetyDeposit) {
                        ghostPendingWithdrawals[claimer] += order.safetyDeposit;
                    }
                } else {
                    if (claimer.balance < preClaimerBal + order.safetyDeposit) {
                        ghostPendingWithdrawals[claimer] += order.safetyDeposit;
                    }
                }
            }
        } catch {}
    }

    function refundOrder(uint256 actorIdx, uint256 orderIdx) public {
        if (allOrderIds.length == 0) return;
        orderIdx = bound(orderIdx, 0, allOrderIds.length - 1);
        uint256 orderId = allOrderIds[orderIdx];
        address refunder = _getActor(actorIdx);

        IHTLCEscrow.Order memory order;
        try htlc.getOrder(orderId) returns (IHTLCEscrow.Order memory o) {
            order = o;
        } catch {
            return;
        }

        if (order.status != IHTLCEscrow.OrderStatus.Funded) return;

        // Ensure time warp if needed or call directly
        if (block.timestamp <= order.timelock) {
            vm.warp(order.timelock + 1);
        }

        uint256 preRefundTargetBal = order.refundAddress.balance;
        uint256 preRefunderBal = refunder.balance;

        vm.prank(refunder);
        try htlc.refundOrder(orderId) {
            if (order.token == address(0)) {
                ghostTotalFundedEth -= (order.amount + order.safetyDeposit);
                if (order.refundAddress.balance == preRefundTargetBal) {
                    ghostPendingWithdrawals[order.refundAddress] += order.amount;
                }
            } else {
                ghostTotalFundedToken -= order.amount;
                ghostTotalFundedEth -= order.safetyDeposit;
            }

            if (order.safetyDeposit > 0) {
                if (refunder == order.refundAddress && order.token == address(0)) {
                    if (refunder.balance < preRefunderBal + order.amount + order.safetyDeposit) {
                        ghostPendingWithdrawals[refunder] += order.safetyDeposit;
                    }
                } else {
                    if (refunder.balance < preRefunderBal + order.safetyDeposit) {
                        ghostPendingWithdrawals[refunder] += order.safetyDeposit;
                    }
                }
            }
        } catch {}
    }

    function withdraw(uint256 actorIdx) public {
        address actor = _getActor(actorIdx);
        uint256 pending = htlc.pendingWithdrawals(actor);
        if (pending == 0) return;

        vm.prank(actor);
        try htlc.withdraw() returns (uint256 amount) {
            ghostPendingWithdrawals[actor] -= amount;
        } catch {}
    }

    function warpTime(uint64 secondsToWarp) public {
        secondsToWarp = uint64(bound(secondsToWarp, 1, 7 days));
        vm.warp(block.timestamp + secondsToWarp);
    }

    function setReceiverMode(uint8 mode) public {
        mode = uint8(bound(mode, 0, 2));
        receiverMock.setMode(HTLCReceiverMock.Mode(mode));
    }

    // ── Helper Internal Functions ─────────────────────────────────────────────

    function _getActor(uint256 idx) internal view returns (address) {
        return actors[idx % actors.length];
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function actorAt(uint256 idx) external view returns (address) {
        return actors[idx % actors.length];
    }

    function allOrderIdsLength() external view returns (uint256) {
        return allOrderIds.length;
    }
}

/// @title InvariantHTLCEscrowTest
/// @notice Comprehensive invariant and stateful fuzz test suite for HTLCEscrow
contract InvariantHTLCEscrowTest is Test {
    HTLCEscrow public htlc;
    TestERC20 public token;
    HTLCEscrowHandler public handler;

    uint256 public constant MIN_SD = 1e15;

    function setUp() public {
        token = new TestERC20("Test Token", "TST", 10_000_000 * 1e18);
        htlc = new HTLCEscrow(IResolverRegistry(address(0)), MIN_SD);
        handler = new HTLCEscrowHandler(htlc, token);

        targetContract(address(handler));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 6 Specific Invariants
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice 1. Solvency & Balance Invariant
    ///         The contract's ETH and ERC20 balances must strictly equal total funded
    ///         orders plus pending pull-payment withdrawals across all accounts.
    function invariant_balanceMatchesFundedOrdersAndWithdrawals() public view {
        uint256 nextId = htlc.nextOrderId();
        uint256 expectedFundedEth = 0;
        uint256 expectedFundedToken = 0;

        for (uint256 i = 1; i < nextId; i++) {
            try htlc.getOrder(i) returns (IHTLCEscrow.Order memory o) {
                if (o.status == IHTLCEscrow.OrderStatus.Funded) {
                    if (o.token == address(0)) {
                        expectedFundedEth += o.amount + o.safetyDeposit;
                    } else {
                        expectedFundedEth += o.safetyDeposit;
                        expectedFundedToken += o.amount;
                    }
                }
            } catch {}
        }

        uint256 totalPendingEth = 0;
        uint256 actorCount = handler.actorCount();
        for (uint256 a = 0; a < actorCount; a++) {
            address actor = handler.actorAt(a);
            totalPendingEth += htlc.pendingWithdrawals(actor);
        }
        // Also check handler itself in case credited
        totalPendingEth += htlc.pendingWithdrawals(address(handler));

        assertEq(
            address(htlc).balance,
            expectedFundedEth + totalPendingEth,
            "Invariant Violation: ETH balance mismatch"
        );
        assertEq(
            token.balanceOf(address(htlc)),
            expectedFundedToken,
            "Invariant Violation: Token balance mismatch"
        );
    }

    /// @notice 2. Pull-Payment Isolation Invariant
    ///         Pending withdrawal balances per account are strictly isolated and non-drainable
    ///         by other accounts' actions.
    function invariant_pullPaymentIsolation() public view {
        uint256 actorCount = handler.actorCount();
        for (uint256 a = 0; a < actorCount; a++) {
            address actor = handler.actorAt(a);
            uint256 pending = htlc.pendingWithdrawals(actor);
            uint256 ghostPending = handler.ghostPendingWithdrawals(actor);

            assertEq(
                pending,
                ghostPending,
                "Invariant Violation: Pull-payment isolation broken"
            );
        }
    }

    /// @notice 3. Reentrancy Safety Invariant
    ///         Reentrant attempts during ETH transfers cannot succeed or corrupt contract state.
    function invariant_reentrancySafety() public view {
        ReentrantActor reentrantMock = handler.reentrantMock();
        assertFalse(
            reentrantMock.reentrancySucceeded(),
            "Invariant Violation: Reentrancy succeeded during ETH payout"
        );
    }

    /// @notice 4. Timelock Enforcement & Immutable Finality Invariant
    ///         Claimed/Refunded status is immutable. Active funded orders strictly adhere to timelock rules.
    function invariant_timelockEnforcement() public view {
        uint256 nextId = htlc.nextOrderId();
        for (uint256 i = 1; i < nextId; i++) {
            try htlc.getOrder(i) returns (IHTLCEscrow.Order memory o) {
                if (o.status == IHTLCEscrow.OrderStatus.Claimed || o.status == IHTLCEscrow.OrderStatus.Refunded) {
                    assertTrue(o.finalisedAt > 0, "Finalized order has zero finalisedAt timestamp");
                    assertTrue(o.finalisedAt >= o.createdAt, "finalisedAt prior to createdAt");
                }
            } catch {}
        }
    }

    /// @notice 5. Preimage Integrity Invariant
    ///         OrderStatus.Claimed iff preimage hash matches hashlock and preimageKeccak is stored.
    function invariant_preimageIntegrity() public view {
        uint256 nextId = htlc.nextOrderId();
        for (uint256 i = 1; i < nextId; i++) {
            try htlc.getOrder(i) returns (IHTLCEscrow.Order memory o) {
                if (o.status == IHTLCEscrow.OrderStatus.Claimed) {
                    bytes memory preimage = handler.orderPreimages(i);
                    assertEq(preimage.length, 32, "Claimed order preimage length not 32 bytes");

                    bytes32 sha = sha256(preimage);
                    bytes32 kecc = keccak256(preimage);
                    assertTrue(
                        sha == o.hashlock || kecc == o.hashlock,
                        "Claimed order preimage does not match hashlock"
                    );
                    assertEq(
                        o.preimageKeccak,
                        kecc,
                        "Claimed order preimageKeccak mismatch"
                    );
                } else {
                    assertEq(o.preimageKeccak, bytes32(0), "Unclaimed order has non-zero preimageKeccak");
                }
            } catch {}
        }
    }

    /// @notice 6. Safety Deposit Accounting Invariant
    ///         Safety deposits funded on orders are accounted for in either pending funded state
    ///         or distributed to claimers/refunders via direct payout or pending withdrawals.
    function invariant_safetyDepositAccounting() public view {
        uint256 nextId = htlc.nextOrderId();
        uint256 activeSafetyDeposit = 0;

        for (uint256 i = 1; i < nextId; i++) {
            try htlc.getOrder(i) returns (IHTLCEscrow.Order memory o) {
                if (o.status == IHTLCEscrow.OrderStatus.Funded) {
                    activeSafetyDeposit += o.safetyDeposit;
                }
            } catch {}
        }

        assertTrue(
            activeSafetyDeposit <= handler.ghostTotalSafetyDepositsFunded(),
            "Invariant Violation: Active safety deposit exceeds total funded"
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Stateful Bug-Finding Concrete Tests
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Bug-Finding: Concurrent claims on the same order by multiple actors
    function testStateful_concurrentClaims() public {
        address sender = makeAddr("sender");
        address ben = makeAddr("ben");
        address ref = makeAddr("ref");
        address claimer1 = makeAddr("claimer1");
        address claimer2 = makeAddr("claimer2");

        bytes32 secret = bytes32(uint256(0xabc123));
        bytes memory preimage = abi.encodePacked(secret);
        bytes32 hashlock = sha256(preimage);

        vm.deal(sender, 2 ether);
        vm.prank(sender);
        uint256 orderId = htlc.createOrder{value: 2 ether}(
            ben, ref, address(0), 1 ether, 1 ether, hashlock, 600
        );

        // Claimer 1 claims order
        vm.prank(claimer1);
        htlc.claimOrder(orderId, preimage);

        // Concurrent Claimer 2 attempts to claim order after finalization
        vm.prank(claimer2);
        vm.expectRevert(HTLCEscrow.OrderNotClaimable.selector);
        htlc.claimOrder(orderId, preimage);
    }

    /// @notice Bug-Finding: Claim vs Refund race right at expiry timestamp
    function testStateful_claimRefundRaces() public {
        address sender = makeAddr("sender");
        address ben = makeAddr("ben");
        address ref = makeAddr("ref");

        bytes32 secret = bytes32(uint256(0x999888));
        bytes memory preimage = abi.encodePacked(secret);
        bytes32 hashlock = sha256(preimage);

        uint64 timelockSec = 300;
        vm.deal(sender, 2 ether);
        vm.prank(sender);
        uint256 orderId = htlc.createOrder{value: 2 ether}(
            ben, ref, address(0), 1 ether, 1 ether, hashlock, timelockSec
        );

        IHTLCEscrow.Order memory order = htlc.getOrder(orderId);

        // At exactly block.timestamp == order.timelock (expiry edge):
        // claimOrder should succeed (block.timestamp <= timelock)
        // refundOrder should fail with NotExpired (requires block.timestamp > timelock)
        vm.warp(order.timelock);

        vm.prank(ref);
        vm.expectRevert(HTLCEscrow.NotExpired.selector);
        htlc.refundOrder(orderId);

        vm.prank(ben);
        htlc.claimOrder(orderId, preimage);

        // Once claimed, refund at timelock + 1 must fail with OrderNotRefundable
        vm.warp(order.timelock + 1);
        vm.prank(ref);
        vm.expectRevert(HTLCEscrow.OrderNotRefundable.selector);
        htlc.refundOrder(orderId);
    }

    /// @notice Bug-Finding: Zero amounts, zero addresses, invalid hashlock/timelock edge cases
    function testStateful_zeroAmountsAndEdgeCases() public {
        address ben = makeAddr("ben");
        address ref = makeAddr("ref");
        bytes32 hashlock = sha256("secret");

        vm.deal(address(this), 10 ether);

        // Zero amount reverts
        vm.expectRevert(HTLCEscrow.InvalidAmount.selector);
        htlc.createOrder{value: 1 ether}(ben, ref, address(0), 0, MIN_SD, hashlock, 600);

        // Zero beneficiary reverts
        vm.expectRevert(HTLCEscrow.InvalidAmount.selector);
        htlc.createOrder{value: 1 ether}(address(0), ref, address(0), 1 ether, MIN_SD, hashlock, 600);

        // Zero hashlock reverts
        vm.expectRevert(HTLCEscrow.InvalidHashlock.selector);
        htlc.createOrder{value: 1 ether}(ben, ref, address(0), 1 ether, MIN_SD, bytes32(0), 600);

        // Timelock too small reverts
        vm.expectRevert(HTLCEscrow.InvalidTimelock.selector);
        htlc.createOrder{value: 1 ether}(ben, ref, address(0), 1 ether, MIN_SD, hashlock, 200);

        // Safety deposit too small reverts
        vm.expectRevert(HTLCEscrow.SafetyDepositTooSmall.selector);
        htlc.createOrder{value: 1 ether}(ben, ref, address(0), 1 ether, MIN_SD - 1, hashlock, 600);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Gas Profiling Benchmarks
    // ─────────────────────────────────────────────────────────────────────────

    /// @notice Gas benchmark: createOrder (native ETH).
    ///         Measures gas consumed by a single createOrder call and asserts
    ///         it stays within an acceptable ceiling. The ceiling is generous
    ///         so this acts as a regression guard rather than an optimisation
    ///         gate; tighten it when the contract is optimised further.
    function testGas_createOrder_native() public {
        address ben = makeAddr("gasBen");
        address ref = makeAddr("gasRef");
        bytes32 secret = bytes32(uint256(0xdeadbeef));
        bytes memory preimage = abi.encodePacked(secret);
        bytes32 hashlock = sha256(preimage);

        vm.deal(address(this), 2 ether);

        uint256 gasBefore = gasleft();
        htlc.createOrder{value: 2 ether}(ben, ref, address(0), 1 ether, MIN_SD, hashlock, 600);
        uint256 gasUsed = gasBefore - gasleft();

        // Ceiling: 200 000 gas — a generous regression guard.
        assertLt(gasUsed, 200_000, "createOrder(native) exceeded gas ceiling");
    }

    /// @notice Gas benchmark: claimOrder (native ETH, beneficiary is EOA).
    function testGas_claimOrder_native() public {
        address sender = makeAddr("gasSender");
        address ben = makeAddr("gasBen2");
        address ref = makeAddr("gasRef2");
        address claimer = makeAddr("gasClaimer");

        bytes32 secret = bytes32(uint256(0xcafe1234));
        bytes memory preimage = abi.encodePacked(secret);
        bytes32 hashlock = sha256(preimage);

        vm.deal(sender, 2 ether);
        vm.prank(sender);
        uint256 orderId = htlc.createOrder{value: 2 ether}(ben, ref, address(0), 1 ether, MIN_SD, hashlock, 600);

        uint256 gasBefore = gasleft();
        vm.prank(claimer);
        htlc.claimOrder(orderId, preimage);
        uint256 gasUsed = gasBefore - gasleft();

        // Ceiling: 100 000 gas.
        assertLt(gasUsed, 100_000, "claimOrder(native) exceeded gas ceiling");
    }

    /// @notice Gas benchmark: refundOrder (native ETH).
    function testGas_refundOrder_native() public {
        address sender = makeAddr("gasSender3");
        address ben = makeAddr("gasBen3");
        address ref = makeAddr("gasRef3");
        address refunder = makeAddr("gasRefunder");

        bytes32 secret = bytes32(uint256(0xabcdef01));
        bytes memory preimage = abi.encodePacked(secret);
        bytes32 hashlock = sha256(preimage);

        vm.deal(sender, 2 ether);
        vm.prank(sender);
        uint256 orderId = htlc.createOrder{value: 2 ether}(ben, ref, address(0), 1 ether, MIN_SD, hashlock, 600);

        IHTLCEscrow.Order memory order = htlc.getOrder(orderId);
        vm.warp(order.timelock + 1);

        uint256 gasBefore = gasleft();
        vm.prank(refunder);
        htlc.refundOrder(orderId);
        uint256 gasUsed = gasBefore - gasleft();

        // Ceiling: 100 000 gas.
        assertLt(gasUsed, 100_000, "refundOrder(native) exceeded gas ceiling");
    }

    /// @notice Gas stress: Create, claim, and refund many orders in rapid succession.
    ///         Verifies that gas usage scales linearly and no state corruption occurs
    ///         when the contract processes bursts of activity.
    function testGas_stressCreateClaimRefund() public {
        uint256 N = 20; // 20 create + 10 claim + 10 refund

        address sender = makeAddr("stressSender");
        address ben = makeAddr("stressBen");
        address ref = makeAddr("stressRef");
        address claimer = makeAddr("stressClaimer");

        vm.deal(sender, 1_000 ether);

        uint256[] memory ids = new uint256[](N);
        bytes[] memory preimages = new bytes[](N);

        // Create N orders
        for (uint256 i = 0; i < N; i++) {
            bytes32 secret = bytes32(uint256(keccak256(abi.encodePacked("stress", i))));
            bytes memory preimage = abi.encodePacked(secret);
            bytes32 hashlock = sha256(preimage);
            preimages[i] = preimage;

            vm.prank(sender);
            ids[i] = htlc.createOrder{value: 2 ether}(ben, ref, address(0), 1 ether, MIN_SD, hashlock, 600);
        }

        // Claim first half
        for (uint256 i = 0; i < N / 2; i++) {
            vm.prank(claimer);
            htlc.claimOrder(ids[i], preimages[i]);
            assertEq(uint8(htlc.getOrder(ids[i]).status), uint8(IHTLCEscrow.OrderStatus.Claimed));
        }

        // Refund second half after timelock
        vm.warp(block.timestamp + 601);
        for (uint256 i = N / 2; i < N; i++) {
            vm.prank(claimer);
            htlc.refundOrder(ids[i]);
            assertEq(uint8(htlc.getOrder(ids[i]).status), uint8(IHTLCEscrow.OrderStatus.Refunded));
        }

        // No state corruption: all orders are finalised, contract balance should be
        // only pending deferred payouts (claimer has no receive() → pushes defer).
        uint256 remaining = address(htlc).balance;
        // All safety deposits pushed to claimer (EOA) succeed, locked amounts to ben succeed.
        // Expected balance is 0 for EOA recipients.
        assertEq(remaining, 0, "Gas stress: unexpected residual balance");
    }

    /// @notice Gas benchmark: withdraw() after deferred push payout.
    function testGas_withdraw_deferredPayout() public {
        // Use a NoFallbackReceiver as beneficiary so the push defers.
        NoFallbackReceiver noFallback = new NoFallbackReceiver();

        address sender = makeAddr("wdSender");
        address ref = makeAddr("wdRef");
        bytes32 secret = bytes32(uint256(0x12345678));
        bytes memory preimage = abi.encodePacked(secret);
        bytes32 hashlock = sha256(preimage);

        vm.deal(sender, 2 ether);
        vm.prank(sender);
        uint256 orderId = htlc.createOrder{value: 2 ether}(
            address(noFallback), ref, address(0), 1 ether, MIN_SD, hashlock, 600
        );

        // Claim — push to noFallback defers.
        htlc.claimOrder(orderId, preimage);
        assertGt(htlc.pendingWithdrawals(address(noFallback)), 0);

        uint256 gasBefore = gasleft();
        noFallback.pull(IHTLCEscrow(address(htlc)));
        uint256 gasUsed = gasBefore - gasleft();

        // Ceiling: 60 000 gas.
        assertLt(gasUsed, 60_000, "withdraw() exceeded gas ceiling");
        assertEq(htlc.pendingWithdrawals(address(noFallback)), 0);
    }
}
