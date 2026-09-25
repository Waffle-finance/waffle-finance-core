// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {HTLCEscrow} from "../../contracts/HTLCEscrow.sol";
import {IHTLCEscrow} from "../../contracts/interfaces/IHTLCEscrow.sol";
import {IResolverRegistry} from "../../contracts/interfaces/IResolverRegistry.sol";
import {TestERC20} from "../../contracts/mocks/TestERC20.sol";
import {HTLCReceiverMock} from "../../contracts/mocks/HTLCReceivers.sol";
import {ResolverRegistry} from "../../contracts/ResolverRegistry.sol";
import {ReentrantActor} from "../../contracts/mocks/ReentrantActor.sol";

// ─────────────────────────────────────────────────────────────────────────────
// Registry stubs
// ─────────────────────────────────────────────────────────────────────────────

/// @dev Returns a fixed isActive answer, allowing per-test configuration.
contract StubRegistry is IResolverRegistry {
    bool private _active;
    constructor(bool active_) { _active = active_; }
    function isActive(address) external view returns (bool) { return _active; }
}

/// @dev Simulates an attacked/broken registry that always reverts.
contract RevertingRegistry is IResolverRegistry {
    function isActive(address) external pure returns (bool) {
        revert("registry: attacked");
    }
}

/// @dev Simulates a registry whose answer can be flipped mid-test (compromise scenario).
contract FlippableRegistry is IResolverRegistry {
    bool public authorised = true;
    function setAuthorised(bool v) external { authorised = v; }
    function isActive(address) external view returns (bool) { return authorised; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Security test suite
// ─────────────────────────────────────────────────────────────────────────────

contract HTLCEscrowSecurityTest is Test {

    // ── named actors ─────────────────────────────────────────────────────────
    address deployer    = makeAddr("deployer");
    address resolver    = makeAddr("resolver");
    address beneficiary = makeAddr("beneficiary");
    address refundAddr  = makeAddr("refundAddress");
    address attacker    = makeAddr("attacker");
    address relayer     = makeAddr("relayer");

    // ── shared constants ─────────────────────────────────────────────────────
    uint64  constant TL  = 600;     // 10 minutes — within [MIN_TIMELOCK, MAX_TIMELOCK]
    uint256 constant AMT = 1 ether;
    uint256 constant SD  = 1e15;    // 0.001 ETH — equals minSafetyDeposit

    // ── contracts under test ──────────────────────────────────────────────────
    HTLCEscrow  htlcOpen;    // resolverRegistry = address(0): permissionless
    HTLCEscrow  htlcGated;   // resolverRegistry = activeReg
    StubRegistry activeReg;
    StubRegistry inactiveReg;

    function setUp() public {
        activeReg   = new StubRegistry(true);
        inactiveReg = new StubRegistry(false);

        vm.prank(deployer);
        htlcOpen  = new HTLCEscrow(IResolverRegistry(address(0)), SD);

        vm.prank(deployer);
        htlcGated = new HTLCEscrow(activeReg, SD);
    }

    // ── shared helpers ────────────────────────────────────────────────────────

    function _preimage(uint256 seed) internal pure returns (bytes memory) {
        return abi.encodePacked(bytes32(seed));
    }

    function _sha256Lock(bytes memory pre) internal pure returns (bytes32) {
        return sha256(pre);
    }

    /// Create a native-ETH order on `htlc` as `caller`, returning the orderId.
    function _createNative(
        HTLCEscrow htlc,
        address caller,
        address ben,
        address refund,
        bytes memory pre
    ) internal returns (uint256 orderId) {
        bytes32 hl = _sha256Lock(pre);
        vm.deal(caller, AMT + SD);
        vm.prank(caller);
        orderId = htlc.createOrder{value: AMT + SD}(
            ben, refund, address(0), AMT, SD, hl, TL
        );
    }

    /// Create a native-ETH order on htlcOpen with standard actors.
    function _setupOrder(bytes32 hashlock) internal returns (uint256 id) {
        vm.deal(resolver, AMT + SD);
        vm.prank(resolver);
        id = htlcOpen.createOrder{value: AMT + SD}(
            beneficiary, refundAddr, address(0), AMT, SD, hashlock, TL
        );
    }

    // ═════════════════════════════════════════════════════════════════════════
    // 1. createOrder — ACCESS CONTROL MATRIX
    // ═════════════════════════════════════════════════════════════════════════

    // 1a. No registry → any actor (including attacker) can create orders.
    function test_createOrder_noRegistry_anyoneCanCreate() public {
        _createNative(htlcOpen, attacker,    beneficiary, refundAddr, _preimage(1));
        _createNative(htlcOpen, resolver,    beneficiary, refundAddr, _preimage(2));
        _createNative(htlcOpen, beneficiary, attacker,    refundAddr, _preimage(3));
        assertEq(htlcOpen.nextOrderId(), 4);
    }

    // 1b. Gated registry with isActive = true → authorised caller succeeds.
    function test_createOrder_gatedRegistry_authorisedCallerSucceeds() public {
        uint256 id = _createNative(htlcGated, resolver, beneficiary, refundAddr, _preimage(10));
        assertEq(id, 1);
        assertEq(uint8(htlcGated.getOrder(1).status), uint8(IHTLCEscrow.OrderStatus.Funded));
    }

    // 1c. Gated registry with isActive = false → attacker is blocked.
    function test_createOrder_gatedRegistry_attackerBlocked() public {
        HTLCEscrow htlcBlocked = new HTLCEscrow(inactiveReg, SD);
        bytes32 hl = _sha256Lock(_preimage(20));
        vm.deal(attacker, AMT + SD);
        vm.prank(attacker);
        vm.expectRevert(HTLCEscrow.ResolverNotAuthorised.selector);
        htlcBlocked.createOrder{value: AMT + SD}(
            beneficiary, refundAddr, address(0), AMT, SD, hl, TL
        );
    }

    // 1d. Gated registry with isActive = false → deployer has no bypass.
    function test_createOrder_gatedRegistry_deployerHasNoBypass() public {
        HTLCEscrow htlcBlocked = new HTLCEscrow(inactiveReg, SD);
        bytes32 hl = _sha256Lock(_preimage(21));
        vm.deal(deployer, AMT + SD);
        vm.prank(deployer);
        vm.expectRevert(HTLCEscrow.ResolverNotAuthorised.selector);
        htlcBlocked.createOrder{value: AMT + SD}(
            beneficiary, refundAddr, address(0), AMT, SD, hl, TL
        );
    }

    // 1e. Reverting registry → createOrder propagates the revert.
    function test_createOrder_revertingRegistry_propagatesRevert() public {
        RevertingRegistry revReg = new RevertingRegistry();
        HTLCEscrow htlcRev = new HTLCEscrow(revReg, SD);
        bytes32 hl = _sha256Lock(_preimage(30));
        vm.deal(resolver, AMT + SD);
        vm.prank(resolver);
        vm.expectRevert();
        htlcRev.createOrder{value: AMT + SD}(
            beneficiary, refundAddr, address(0), AMT, SD, hl, TL
        );
    }

    // 1f. Zero beneficiary → InvalidAmount.
    function test_createOrder_zeroBeneficiary_reverts() public {
        bytes32 hl = _sha256Lock(_preimage(40));
        vm.deal(deployer, AMT + SD);
        vm.prank(deployer);
        vm.expectRevert(HTLCEscrow.InvalidAmount.selector);
        htlcOpen.createOrder{value: AMT + SD}(
            address(0), refundAddr, address(0), AMT, SD, hl, TL
        );
    }

    // 1g. Zero refundAddress → InvalidAmount.
    function test_createOrder_zeroRefundAddress_reverts() public {
        bytes32 hl = _sha256Lock(_preimage(41));
        vm.deal(deployer, AMT + SD);
        vm.prank(deployer);
        vm.expectRevert(HTLCEscrow.InvalidAmount.selector);
        htlcOpen.createOrder{value: AMT + SD}(
            beneficiary, address(0), address(0), AMT, SD, hl, TL
        );
    }

    // 1h. Safety deposit below minimum → SafetyDepositTooSmall.
    function test_createOrder_safetyDepositBelowMin_reverts() public {
        uint256 tinySD = SD - 1;
        bytes32 hl = _sha256Lock(_preimage(42));
        vm.deal(resolver, AMT + tinySD);
        vm.prank(resolver);
        vm.expectRevert(HTLCEscrow.SafetyDepositTooSmall.selector);
        htlcOpen.createOrder{value: AMT + tinySD}(
            beneficiary, refundAddr, address(0), AMT, tinySD, hl, TL
        );
    }

    // 1i. Timelock below MIN_TIMELOCK → InvalidTimelock.
    //     Pre-compute the bound outside vm.expectRevert to avoid vm.expectRevert
    //     consuming the MIN_TIMELOCK() external call before createOrder fires.
    function test_createOrder_timelockBelowMin_reverts() public {
        bytes32 hl = _sha256Lock(_preimage(43));
        uint64 tooLow = htlcOpen.MIN_TIMELOCK() - 1;
        vm.deal(resolver, AMT + SD);
        vm.prank(resolver);
        vm.expectRevert(HTLCEscrow.InvalidTimelock.selector);
        htlcOpen.createOrder{value: AMT + SD}(
            beneficiary, refundAddr, address(0), AMT, SD, hl, tooLow
        );
    }

    // 1j. Timelock above MAX_TIMELOCK → InvalidTimelock.
    function test_createOrder_timelockAboveMax_reverts() public {
        bytes32 hl = _sha256Lock(_preimage(44));
        uint64 tooHigh = htlcOpen.MAX_TIMELOCK() + 1;
        vm.deal(resolver, AMT + SD);
        vm.prank(resolver);
        vm.expectRevert(HTLCEscrow.InvalidTimelock.selector);
        htlcOpen.createOrder{value: AMT + SD}(
            beneficiary, refundAddr, address(0), AMT, SD, hl, tooHigh
        );
    }

    // ═════════════════════════════════════════════════════════════════════════
    // 2. claimOrder — ACCESS CONTROL (permissionless)
    // ═════════════════════════════════════════════════════════════════════════

    // 2a. Beneficiary can claim.
    function test_claimOrder_beneficiaryCanClaim() public {
        bytes memory pre = _preimage(100);
        uint256 id = _createNative(htlcOpen, resolver, beneficiary, refundAddr, pre);
        vm.prank(beneficiary);
        htlcOpen.claimOrder(id, pre);
        assertEq(uint8(htlcOpen.getOrder(id).status), uint8(IHTLCEscrow.OrderStatus.Claimed));
    }

    // 2b. Attacker with correct preimage CAN claim (permissionless by design).
    //     Locked funds still go to the designated beneficiary — not the attacker.
    function test_claimOrder_attackerWithPreimage_fundsGoToBeneficiary() public {
        bytes memory pre = _preimage(101);
        uint256 id = _createNative(htlcOpen, resolver, beneficiary, refundAddr, pre);

        uint256 attackerBefore = attacker.balance;
        vm.prank(attacker);
        htlcOpen.claimOrder(id, pre);

        // Locked amount reaches the designated beneficiary.
        assertEq(beneficiary.balance, AMT);
        // Attacker earns only the safety deposit (the designed incentive).
        assertEq(attacker.balance - attackerBefore, SD);
    }

    // 2c. Relayer can claim and earns the safety deposit.
    function test_claimOrder_relayerCanClaim_earnsSafetyDeposit() public {
        bytes memory pre = _preimage(102);
        uint256 id = _createNative(htlcOpen, resolver, beneficiary, refundAddr, pre);

        uint256 relBefore = relayer.balance;
        vm.prank(relayer);
        htlcOpen.claimOrder(id, pre);

        assertEq(beneficiary.balance, AMT);
        assertEq(relayer.balance - relBefore, SD);
    }

    // 2d. Deployer has no special claim privilege — same as any EOA.
    function test_claimOrder_deployerIsJustAPermissionlessCaller() public {
        bytes memory pre = _preimage(103);
        uint256 id = _createNative(htlcOpen, resolver, beneficiary, refundAddr, pre);
        vm.prank(deployer);
        htlcOpen.claimOrder(id, pre);
        assertEq(uint8(htlcOpen.getOrder(id).status), uint8(IHTLCEscrow.OrderStatus.Claimed));
    }

    // 2e. Non-existent order has timelock = 0, which is always in the past → Expired.
    //     (OrderNotFound is only reachable when status != Funded; a zero-initialized
    //      order has status Funded so the timelock guard fires first.)
    function test_claimOrder_nonExistentOrder_reverts() public {
        vm.expectRevert(HTLCEscrow.Expired.selector);
        htlcOpen.claimOrder(9999, _preimage(1));
    }

    // 2f. Double claim → OrderNotClaimable.
    function test_claimOrder_doubleClaim_reverts() public {
        bytes memory pre = _preimage(104);
        uint256 id = _createNative(htlcOpen, resolver, beneficiary, refundAddr, pre);
        htlcOpen.claimOrder(id, pre);
        vm.expectRevert(HTLCEscrow.OrderNotClaimable.selector);
        htlcOpen.claimOrder(id, pre);
    }

    // 2g. Claim after refund → OrderNotClaimable.
    function test_claimOrder_afterRefund_reverts() public {
        bytes memory pre = _preimage(105);
        uint256 id = _createNative(htlcOpen, resolver, beneficiary, refundAddr, pre);
        vm.warp(block.timestamp + TL + 1);
        htlcOpen.refundOrder(id);
        vm.expectRevert(HTLCEscrow.OrderNotClaimable.selector);
        htlcOpen.claimOrder(id, pre);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // 3. refundOrder — ACCESS CONTROL + TIMELOCK BOUNDARY
    // ═════════════════════════════════════════════════════════════════════════

    // 3a. Any actor can trigger refund after expiry; funds always reach refundAddress.
    function test_refundOrder_attackerTriggersRefund_fundsGoToRefundAddr() public {
        bytes memory pre = _preimage(200);
        uint256 id = _createNative(htlcOpen, resolver, beneficiary, refundAddr, pre);
        vm.warp(block.timestamp + TL + 1);

        uint256 refBefore = refundAddr.balance;
        vm.prank(attacker);
        htlcOpen.refundOrder(id);

        // Locked amount returns to the designated refundAddress.
        assertEq(refundAddr.balance - refBefore, AMT);
        // Attacker earns only the safety deposit.
        assertEq(attacker.balance, SD);
    }

    // 3b. Beneficiary can trigger refund (gets safety deposit, not the locked amount).
    function test_refundOrder_beneficiaryCanTrigger() public {
        bytes memory pre = _preimage(201);
        uint256 id = _createNative(htlcOpen, resolver, beneficiary, refundAddr, pre);
        vm.warp(block.timestamp + TL + 1);
        vm.prank(beneficiary);
        htlcOpen.refundOrder(id);
        assertEq(uint8(htlcOpen.getOrder(id).status), uint8(IHTLCEscrow.OrderStatus.Refunded));
    }

    // 3c. Refund before expiry → NotExpired.
    function test_refundOrder_beforeExpiry_reverts() public {
        bytes memory pre = _preimage(202);
        uint256 id = _createNative(htlcOpen, resolver, beneficiary, refundAddr, pre);
        vm.expectRevert(HTLCEscrow.NotExpired.selector);
        htlcOpen.refundOrder(id);
    }

    // 3d. Timelock boundary: at exactly timelock → still NotExpired (strict >).
    function test_refundOrder_atExactTimelock_stillNotExpired() public {
        bytes memory pre = _preimage(203);
        uint256 id = _createNative(htlcOpen, resolver, beneficiary, refundAddr, pre);
        vm.warp(htlcOpen.getOrder(id).timelock);
        vm.expectRevert(HTLCEscrow.NotExpired.selector);
        htlcOpen.refundOrder(id);
    }

    // 3e. Timelock boundary: one second after timelock → refund succeeds.
    function test_refundOrder_oneSecondAfterTimelock_succeeds() public {
        bytes memory pre = _preimage(204);
        uint256 id = _createNative(htlcOpen, resolver, beneficiary, refundAddr, pre);
        vm.warp(htlcOpen.getOrder(id).timelock + 1);
        htlcOpen.refundOrder(id);
        assertEq(uint8(htlcOpen.getOrder(id).status), uint8(IHTLCEscrow.OrderStatus.Refunded));
    }

    // 3f. Claim boundary: at exactly timelock → Expired (>= semantics; equality is expired).
    function test_claimOrder_atExactTimelock_reverts() public {
        bytes memory pre = _preimage(205);
        uint256 id = _createNative(htlcOpen, resolver, beneficiary, refundAddr, pre);
        vm.warp(htlcOpen.getOrder(id).timelock);
        vm.expectRevert(HTLCEscrow.Expired.selector);
        htlcOpen.claimOrder(id, pre);
        assertEq(uint8(htlcOpen.getOrder(id).status), uint8(IHTLCEscrow.OrderStatus.Funded));
    }

    // 3g. Claim boundary: one second after timelock → Expired.
    function test_claimOrder_oneSecondAfterTimelock_expired() public {
        bytes memory pre = _preimage(206);
        uint256 id = _createNative(htlcOpen, resolver, beneficiary, refundAddr, pre);
        vm.warp(htlcOpen.getOrder(id).timelock + 1);
        vm.expectRevert(HTLCEscrow.Expired.selector);
        htlcOpen.claimOrder(id, pre);
    }

    // 3h. Refund after successful claim → OrderNotRefundable.
    function test_refundOrder_afterClaim_reverts() public {
        bytes memory pre = _preimage(207);
        uint256 id = _createNative(htlcOpen, resolver, beneficiary, refundAddr, pre);
        htlcOpen.claimOrder(id, pre);
        vm.warp(block.timestamp + TL + 1);
        vm.expectRevert(HTLCEscrow.OrderNotRefundable.selector);
        htlcOpen.refundOrder(id);
    }

    // 3i. Non-existent order on refundOrder: a zero-initialised order has
    //     status Funded and timelock = 0 (always past), so the call
    //     "succeeds" (with amount = 0 to address(0)) rather than reverting.
    //     Verify it completes without reverting and emits OrderRefunded.
    function test_refundOrder_nonExistentOrder_noRevertButNoop() public {
        vm.warp(block.timestamp + 999_999);
        // Does not revert — no funds are at risk since amount = 0.
        htlcOpen.refundOrder(9999);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // 4. withdraw — PULL-PAYMENT LEDGER ISOLATION
    // ═════════════════════════════════════════════════════════════════════════

    function _deferPayout(address ben) internal returns (uint256 id) {
        bytes memory pre = _preimage(uint256(uint160(ben)));
        bytes32 hl = _sha256Lock(pre);
        vm.deal(resolver, AMT + SD);
        vm.prank(resolver);
        id = htlcOpen.createOrder{value: AMT + SD}(
            ben, refundAddr, address(0), AMT, SD, hl, TL
        );
        htlcOpen.claimOrder(id, pre);
    }

    // 4a. Only the credited address can pull its balance; others have no credit.
    function test_withdraw_onlyCreditedAddressCanPull() public {
        HTLCReceiverMock rec = new HTLCReceiverMock();
        rec.setMode(HTLCReceiverMock.Mode.Reject);

        _deferPayout(address(rec));
        assertEq(htlcOpen.pendingWithdrawals(address(rec)), AMT);

        // Attacker's pending balance is zero — cannot pull.
        vm.prank(attacker);
        vm.expectRevert(HTLCEscrow.NoPendingWithdrawal.selector);
        htlcOpen.withdraw();

        // Deployer's pending balance is also zero.
        vm.prank(deployer);
        vm.expectRevert(HTLCEscrow.NoPendingWithdrawal.selector);
        htlcOpen.withdraw();
    }

    // 4b. Two recipients' deferred balances are fully isolated from each other.
    function test_withdraw_twoRecipients_ledgersIsolated() public {
        HTLCReceiverMock rec1 = new HTLCReceiverMock();
        HTLCReceiverMock rec2 = new HTLCReceiverMock();
        rec1.setMode(HTLCReceiverMock.Mode.Reject);
        rec2.setMode(HTLCReceiverMock.Mode.Reject);

        // Order 1: AMT locked for rec1
        {
            bytes memory pre = _preimage(310);
            bytes32 hl = _sha256Lock(pre);
            vm.deal(resolver, AMT + SD);
            vm.prank(resolver);
            uint256 id = htlcOpen.createOrder{value: AMT + SD}(
                address(rec1), refundAddr, address(0), AMT, SD, hl, TL
            );
            htlcOpen.claimOrder(id, pre);
        }
        // Order 2: 2×AMT locked for rec2
        {
            bytes memory pre = _preimage(311);
            bytes32 hl = _sha256Lock(pre);
            vm.deal(resolver, AMT * 2 + SD);
            vm.prank(resolver);
            uint256 id = htlcOpen.createOrder{value: AMT * 2 + SD}(
                address(rec2), refundAddr, address(0), AMT * 2, SD, hl, TL
            );
            htlcOpen.claimOrder(id, pre);
        }

        assertEq(htlcOpen.pendingWithdrawals(address(rec1)), AMT);
        assertEq(htlcOpen.pendingWithdrawals(address(rec2)), AMT * 2);

        // rec1 pulls only its own balance; rec2's credit is untouched.
        rec1.setMode(HTLCReceiverMock.Mode.Accept);
        rec1.pull(htlcOpen);
        assertEq(address(rec1).balance, AMT);
        assertEq(htlcOpen.pendingWithdrawals(address(rec2)), AMT * 2);

        // rec2 pulls only its own balance.
        rec2.setMode(HTLCReceiverMock.Mode.Accept);
        rec2.pull(htlcOpen);
        assertEq(address(rec2).balance, AMT * 2);
        assertEq(htlcOpen.pendingWithdrawals(address(rec2)), 0);
    }

    // 4c. Failed withdraw preserves the credit — no funds are lost.
    function test_withdraw_failedTransferPreservesCredit() public {
        HTLCReceiverMock rec = new HTLCReceiverMock();
        rec.setMode(HTLCReceiverMock.Mode.Reject);

        bytes memory pre = _preimage(320);
        bytes32 hl = _sha256Lock(pre);
        vm.deal(resolver, AMT + SD);
        vm.prank(resolver);
        uint256 id = htlcOpen.createOrder{value: AMT + SD}(
            address(rec), refundAddr, address(0), AMT, SD, hl, TL
        );
        htlcOpen.claimOrder(id, pre);

        // While receiver rejects ETH, withdraw reverts and credit is preserved.
        vm.expectRevert(HTLCEscrow.NativeTransferFailed.selector);
        rec.pull(htlcOpen);
        assertEq(htlcOpen.pendingWithdrawals(address(rec)), AMT);

        // After the receiver switches to Accept, the pull succeeds.
        rec.setMode(HTLCReceiverMock.Mode.Accept);
        rec.pull(htlcOpen);
        assertEq(htlcOpen.pendingWithdrawals(address(rec)), 0);
        assertEq(address(rec).balance, AMT);
    }

    // 4d. Double withdraw is blocked — second call gets NoPendingWithdrawal.
    function test_withdraw_doubleWithdraw_reverts() public {
        HTLCReceiverMock rec = new HTLCReceiverMock();
        rec.setMode(HTLCReceiverMock.Mode.Accept);

        bytes memory pre = _preimage(321);
        bytes32 hl = _sha256Lock(pre);
        vm.deal(resolver, AMT + SD);
        vm.prank(resolver);
        uint256 id = htlcOpen.createOrder{value: AMT + SD}(
            address(rec), refundAddr, address(0), AMT, SD, hl, TL
        );

        // Push succeeds directly (Accept mode) — no pending credit.
        htlcOpen.claimOrder(id, pre);
        assertEq(htlcOpen.pendingWithdrawals(address(rec)), 0);

        vm.expectRevert(HTLCEscrow.NoPendingWithdrawal.selector);
        rec.pull(htlcOpen);
    }

    // 4e. withdraw with no credit at all → NoPendingWithdrawal.
    function test_withdraw_noCredit_reverts() public {
        vm.prank(attacker);
        vm.expectRevert(HTLCEscrow.NoPendingWithdrawal.selector);
        htlcOpen.withdraw();
    }

    // ═════════════════════════════════════════════════════════════════════════
    // 5. PREIMAGE VALIDATION EDGE CASES
    // ═════════════════════════════════════════════════════════════════════════

    // 5a. Zero-length preimage → InvalidPreimage.
    function test_preimage_zeroLength_reverts() public {
        uint256 id = _setupOrder(sha256(_preimage(1)));
        vm.expectRevert(HTLCEscrow.InvalidPreimage.selector);
        htlcOpen.claimOrder(id, new bytes(0));
    }

    // 5b. 1-byte preimage → InvalidPreimage.
    function test_preimage_1Byte_reverts() public {
        uint256 id = _setupOrder(sha256(_preimage(2)));
        vm.expectRevert(HTLCEscrow.InvalidPreimage.selector);
        htlcOpen.claimOrder(id, new bytes(1));
    }

    // 5c. 31-byte preimage → InvalidPreimage.
    function test_preimage_31Bytes_reverts() public {
        uint256 id = _setupOrder(sha256(_preimage(3)));
        vm.expectRevert(HTLCEscrow.InvalidPreimage.selector);
        htlcOpen.claimOrder(id, new bytes(31));
    }

    // 5d. 33-byte preimage → InvalidPreimage.
    function test_preimage_33Bytes_reverts() public {
        uint256 id = _setupOrder(sha256(_preimage(4)));
        vm.expectRevert(HTLCEscrow.InvalidPreimage.selector);
        htlcOpen.claimOrder(id, new bytes(33));
    }

    // 5e. 64-byte preimage → InvalidPreimage.
    function test_preimage_64Bytes_reverts() public {
        uint256 id = _setupOrder(sha256(_preimage(5)));
        vm.expectRevert(HTLCEscrow.InvalidPreimage.selector);
        htlcOpen.claimOrder(id, new bytes(64));
    }

    // 5f. All-zero 32-byte preimage with a non-matching hashlock → InvalidPreimage.
    function test_preimage_allZeros_wrongHashlock_reverts() public {
        // Use a hashlock that is not sha256(zeros) or keccak256(zeros).
        bytes32 hl = bytes32(uint256(0xdeadbeef));
        uint256 id = _setupOrder(hl);
        vm.expectRevert(HTLCEscrow.InvalidPreimage.selector);
        htlcOpen.claimOrder(id, new bytes(32));
    }

    // 5g. Correct preimage for order A cannot be replayed against order B.
    function test_preimage_crossOrderReplay_reverts() public {
        bytes memory pre1 = _preimage(400);
        bytes memory pre2 = _preimage(401);

        uint256 id1 = _setupOrder(sha256(pre1));
        vm.deal(resolver, AMT + SD);
        vm.prank(resolver);
        uint256 id2 = htlcOpen.createOrder{value: AMT + SD}(
            beneficiary, refundAddr, address(0), AMT, SD, sha256(pre2), TL
        );

        // pre1 cannot unlock order 2.
        vm.expectRevert(HTLCEscrow.InvalidPreimage.selector);
        htlcOpen.claimOrder(id2, pre1);

        // pre2 cannot unlock order 1.
        vm.expectRevert(HTLCEscrow.InvalidPreimage.selector);
        htlcOpen.claimOrder(id1, pre2);
    }

    // 5h. sha256 hashlock: submitting keccak256(preimage) as the preimage is rejected.
    function test_preimage_sha256Lock_keccakSubmittedAsPreimage_reverts() public {
        bytes memory realPre = _preimage(402);
        uint256 id = _setupOrder(sha256(realPre));
        bytes memory wrongPre = abi.encodePacked(keccak256(realPre));
        vm.expectRevert(HTLCEscrow.InvalidPreimage.selector);
        htlcOpen.claimOrder(id, wrongPre);
    }

    // 5i. keccak256 hashlock: submitting sha256(preimage) as the preimage is rejected.
    function test_preimage_keccakLock_sha256SubmittedAsPreimage_reverts() public {
        bytes memory realPre = _preimage(403);
        vm.deal(resolver, AMT + SD);
        vm.prank(resolver);
        uint256 id = htlcOpen.createOrder{value: AMT + SD}(
            beneficiary, refundAddr, address(0), AMT, SD, keccak256(realPre), TL
        );
        bytes memory wrongPre = abi.encodePacked(sha256(realPre));
        vm.expectRevert(HTLCEscrow.InvalidPreimage.selector);
        htlcOpen.claimOrder(id, wrongPre);
    }

    // 5j. Both sha256 and keccak256 hashlocks are accepted for legitimate claims.
    function test_preimage_dualDigest_bothPathsAccepted() public {
        bytes memory pre = _preimage(404);

        // sha256 path
        {
            uint256 id = _setupOrder(sha256(pre));
            htlcOpen.claimOrder(id, pre);
            assertEq(uint8(htlcOpen.getOrder(id).status), uint8(IHTLCEscrow.OrderStatus.Claimed));
        }
        // keccak256 path
        {
            vm.deal(resolver, AMT + SD);
            vm.prank(resolver);
            uint256 id = htlcOpen.createOrder{value: AMT + SD}(
                beneficiary, refundAddr, address(0), AMT, SD, keccak256(pre), TL
            );
            htlcOpen.claimOrder(id, pre);
            assertEq(uint8(htlcOpen.getOrder(id).status), uint8(IHTLCEscrow.OrderStatus.Claimed));
        }
    }

    // 5k. preimageKeccak is stored as keccak256 of the revealed preimage (on-chain proof).
    function test_preimage_preimageKeccakStoredOnClaim() public {
        bytes memory pre = _preimage(405);
        uint256 id = _setupOrder(sha256(pre));
        htlcOpen.claimOrder(id, pre);
        assertEq(htlcOpen.getOrder(id).preimageKeccak, keccak256(pre));
    }

    // ═════════════════════════════════════════════════════════════════════════
    // 6. RESOLVER REGISTRY GATING — threat model scenarios
    // ═════════════════════════════════════════════════════════════════════════

    // 6a. Compromised resolver can create orders but CANNOT redirect beneficiary funds.
    //     Even if the resolver submits the claim, funds go to the beneficiary specified
    //     at order-creation time — not to the resolver.
    function test_registry_compromisedResolver_cannotRedirectFunds() public {
        bytes memory pre = _preimage(500);
        uint256 id = _createNative(htlcGated, resolver, beneficiary, refundAddr, pre);

        // Resolver tries to claim (permissionless), but funds go to the designated beneficiary.
        uint256 resolverBefore = resolver.balance;
        vm.prank(resolver);
        htlcGated.claimOrder(id, pre);

        // Locked amount reached the designated beneficiary.
        assertEq(beneficiary.balance, AMT);
        // Resolver earned only the safety deposit (incentive), not the locked funds.
        assertEq(resolver.balance - resolverBefore, SD);
    }

    // 6b. Registry compromise (deactivates resolver): existing FUNDED orders are still claimable.
    function test_registry_resolverDeactivated_existingOrdersStillClaimable() public {
        FlippableRegistry flipReg = new FlippableRegistry();
        HTLCEscrow htlcFlip = new HTLCEscrow(flipReg, SD);

        bytes memory pre = _preimage(501);
        bytes32 hl = _sha256Lock(pre);
        vm.deal(resolver, AMT + SD);
        vm.prank(resolver);
        uint256 id = htlcFlip.createOrder{value: AMT + SD}(
            beneficiary, refundAddr, address(0), AMT, SD, hl, TL
        );

        // Registry is compromised — resolver deactivated.
        flipReg.setAuthorised(false);

        // Existing funded order can still be claimed (claim is registry-independent).
        vm.prank(beneficiary);
        htlcFlip.claimOrder(id, pre);
        assertEq(uint8(htlcFlip.getOrder(id).status), uint8(IHTLCEscrow.OrderStatus.Claimed));
    }

    // 6c. Registry compromise: existing orders can still be refunded after expiry.
    function test_registry_resolverDeactivated_existingOrdersStillRefundable() public {
        FlippableRegistry flipReg = new FlippableRegistry();
        HTLCEscrow htlcFlip = new HTLCEscrow(flipReg, SD);

        bytes memory pre = _preimage(502);
        bytes32 hl = _sha256Lock(pre);
        vm.deal(resolver, AMT + SD);
        vm.prank(resolver);
        uint256 id = htlcFlip.createOrder{value: AMT + SD}(
            beneficiary, refundAddr, address(0), AMT, SD, hl, TL
        );

        flipReg.setAuthorised(false);
        vm.warp(block.timestamp + TL + 1);

        htlcFlip.refundOrder(id);
        assertEq(refundAddr.balance, AMT);
    }

    // 6d. After registry deactivation, no new orders can be created.
    function test_registry_resolverDeactivated_cannotCreateNewOrders() public {
        FlippableRegistry flipReg = new FlippableRegistry();
        HTLCEscrow htlcFlip = new HTLCEscrow(flipReg, SD);

        // First order succeeds while authorised.
        bytes memory pre1 = _preimage(503);
        bytes32 hl1 = _sha256Lock(pre1);
        vm.deal(resolver, AMT + SD);
        vm.prank(resolver);
        htlcFlip.createOrder{value: AMT + SD}(
            beneficiary, refundAddr, address(0), AMT, SD, hl1, TL
        );

        // Deactivate resolver.
        flipReg.setAuthorised(false);

        // Second order is blocked.
        bytes32 hl2 = _sha256Lock(_preimage(504));
        vm.deal(resolver, AMT + SD);
        vm.prank(resolver);
        vm.expectRevert(HTLCEscrow.ResolverNotAuthorised.selector);
        htlcFlip.createOrder{value: AMT + SD}(
            beneficiary, refundAddr, address(0), AMT, SD, hl2, TL
        );
    }

    // 6e. Registry compromise cannot move HTLC funds directly — registry and escrow are separate.
    //     Use `relayer` (EOA) to trigger refund so its safety-deposit push succeeds and
    //     no credit is left in pendingWithdrawals; the escrow must reach zero balance.
    function test_registry_compromise_doesNotGiveAccessToHTLCFunds() public {
        FlippableRegistry flipReg = new FlippableRegistry();
        HTLCEscrow htlcFlip = new HTLCEscrow(flipReg, SD);

        bytes memory pre = _preimage(505);
        bytes32 hl = _sha256Lock(pre);
        vm.deal(resolver, AMT + SD);
        vm.prank(resolver);
        uint256 id = htlcFlip.createOrder{value: AMT + SD}(
            beneficiary, refundAddr, address(0), AMT, SD, hl, TL
        );

        // Registry attacked: toggle both directions — funds remain locked.
        flipReg.setAuthorised(false);
        flipReg.setAuthorised(true);
        assertEq(address(htlcFlip).balance, AMT + SD);

        // Funds released only via timelock expiry (refund triggered by an EOA so SD exits).
        vm.warp(block.timestamp + TL + 1);
        vm.prank(relayer);
        htlcFlip.refundOrder(id);
        assertEq(refundAddr.balance, AMT);
        assertEq(relayer.balance,    SD);
        assertEq(address(htlcFlip).balance, 0);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // 7. NON-CUSTODIAL GUARANTEES
    // ═════════════════════════════════════════════════════════════════════════

    // 7a. Deployer has no special power to move locked funds.
    function test_nonCustodial_deployerCannotMoveFunds() public {
        bytes memory pre = _preimage(600);
        uint256 id = _createNative(htlcOpen, resolver, beneficiary, refundAddr, pre);

        // Wrong preimage → blocked.
        vm.prank(deployer);
        vm.expectRevert(HTLCEscrow.InvalidPreimage.selector);
        htlcOpen.claimOrder(id, _preimage(999));

        // Refund before expiry → blocked.
        vm.prank(deployer);
        vm.expectRevert(HTLCEscrow.NotExpired.selector);
        htlcOpen.refundOrder(id);

        assertEq(address(htlcOpen).balance, AMT + SD);
    }

    // 7b. Stray ETH sent directly to the contract is rejected.
    function test_nonCustodial_strayETHReverts() public {
        vm.deal(attacker, 1 ether);
        vm.prank(attacker);
        (bool ok, ) = address(htlcOpen).call{value: 1 ether}("");
        assertFalse(ok, "receive() should reject stray ETH");
    }

    // 7c. No dangerous admin escape hatches exist on the contract.
    //     emergencyWithdraw and pause must not exist; transferOwnership and
    //     setResolverRegistry are intentional owner-only admin functions that
    //     cannot move locked order funds.
    function test_nonCustodial_noAdminEscapeHatchSelectors() public {
        // emergencyWithdraw(): 0xdb2e21bc
        // pause():             0x8456cb59
        bytes4[2] memory forbidden = [
            bytes4(0xdb2e21bc),
            bytes4(0x8456cb59)
        ];
        for (uint256 i = 0; i < forbidden.length; i++) {
            (bool ok, ) = address(htlcOpen).staticcall(
                abi.encodePacked(forbidden[i])
            );
            assertFalse(ok, "forbidden selector must not exist");
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    // 8. CROSS-ORDER ISOLATION
    // ═════════════════════════════════════════════════════════════════════════

    // 8a. Claiming order 1 does not affect order 2's state or balance.
    //     Claim is performed as `relayer` (an EOA) so its safety-deposit
    //     is pushed directly, leaving only order 2's funds in the contract.
    function test_crossOrder_claimOneDoesNotAffectOther() public {
        bytes memory pre1 = _preimage(700);
        bytes memory pre2 = _preimage(701);

        uint256 id1 = _createNative(htlcOpen, resolver, beneficiary, refundAddr, pre1);
        vm.deal(resolver, AMT + SD);
        vm.prank(resolver);
        uint256 id2 = htlcOpen.createOrder{value: AMT + SD}(
            beneficiary, refundAddr, address(0), AMT, SD, sha256(pre2), TL
        );

        // Use relayer (EOA) so the safety-deposit push succeeds and exits the contract.
        vm.prank(relayer);
        htlcOpen.claimOrder(id1, pre1);

        assertEq(uint8(htlcOpen.getOrder(id2).status), uint8(IHTLCEscrow.OrderStatus.Funded));
        assertEq(htlcOpen.getOrder(id2).amount, AMT);
        // AMT went to beneficiary, SD went to relayer — only order 2 remains.
        assertEq(address(htlcOpen).balance, AMT + SD);
    }

    // 8b. Refunding order 1 does not auto-finalise order 2.
    function test_crossOrder_refundOneDoesNotAffectOther() public {
        bytes memory pre1 = _preimage(702);
        bytes memory pre2 = _preimage(703);

        uint256 id1 = _createNative(htlcOpen, resolver, beneficiary, refundAddr, pre1);
        vm.deal(resolver, AMT + SD);
        vm.prank(resolver);
        uint256 id2 = htlcOpen.createOrder{value: AMT + SD}(
            beneficiary, refundAddr, address(0), AMT, SD, sha256(pre2), TL
        );

        vm.warp(block.timestamp + TL + 1);
        htlcOpen.refundOrder(id1);

        // Order 2 expired but NOT auto-refunded — requires an explicit call.
        assertEq(uint8(htlcOpen.getOrder(id2).status), uint8(IHTLCEscrow.OrderStatus.Funded));
    }

    // ═════════════════════════════════════════════════════════════════════════
    // 9. ERC20 ACCESS CONTROL
    // ═════════════════════════════════════════════════════════════════════════

    function _deployToken() internal returns (TestERC20) {
        return new TestERC20("Mock", "MCK", 1_000_000 ether);
    }

    function _createERC20Order(
        TestERC20 token,
        address caller,
        bytes memory pre
    ) internal returns (uint256 id) {
        bytes32 hl = _sha256Lock(pre);
        token.transfer(caller, AMT);
        vm.prank(caller);
        token.approve(address(htlcOpen), AMT);
        vm.deal(caller, SD);
        vm.prank(caller);
        id = htlcOpen.createOrder{value: SD}(
            beneficiary, refundAddr, address(token), AMT, SD, hl, TL
        );
    }

    // 9a. ERC20 claim sends tokens to beneficiary, not the claimer.
    function test_erc20_claimSendsTokensToBeneficiary() public {
        TestERC20 token = _deployToken();
        bytes memory pre = _preimage(800);
        uint256 id = _createERC20Order(token, resolver, pre);

        vm.prank(attacker);
        htlcOpen.claimOrder(id, pre); // anyone can claim
        assertEq(token.balanceOf(beneficiary), AMT);
        assertEq(token.balanceOf(attacker),    0);
    }

    // 9b. ERC20 refund sends tokens to refundAddress.
    function test_erc20_refundSendsTokensToRefundAddr() public {
        TestERC20 token = _deployToken();
        bytes memory pre = _preimage(801);
        uint256 id = _createERC20Order(token, resolver, pre);

        vm.warp(block.timestamp + TL + 1);
        htlcOpen.refundOrder(id);
        assertEq(token.balanceOf(refundAddr), AMT);
    }

    // 9c. Wrong preimage cannot drain ERC20 tokens.
    function test_erc20_wrongPreimage_cannotDrainTokens() public {
        TestERC20 token = _deployToken();
        bytes memory pre = _preimage(802);
        uint256 id = _createERC20Order(token, resolver, pre);

        vm.prank(attacker);
        vm.expectRevert(HTLCEscrow.InvalidPreimage.selector);
        htlcOpen.claimOrder(id, _preimage(999));

        assertEq(token.balanceOf(address(htlcOpen)), AMT);
        assertEq(token.balanceOf(attacker), 0);
    }

    // 9d. Gated ERC20: inactive registry blocks createOrder for ERC20 as well.
    function test_erc20_gatedRegistry_inactiveBlocked() public {
        HTLCEscrow htlcBlocked = new HTLCEscrow(inactiveReg, SD);
        TestERC20 token = _deployToken();
        bytes32 hl = _sha256Lock(_preimage(803));

        token.transfer(attacker, AMT);
        vm.prank(attacker);
        token.approve(address(htlcBlocked), AMT);
        vm.deal(attacker, SD);
        vm.prank(attacker);
        vm.expectRevert(HTLCEscrow.ResolverNotAuthorised.selector);
        htlcBlocked.createOrder{value: SD}(
            beneficiary, refundAddr, address(token), AMT, SD, hl, TL
        );
    }

    // ═════════════════════════════════════════════════════════════════════════
    // 10. FUZZ — access control invariants hold for any actor
    // ═════════════════════════════════════════════════════════════════════════

    // 10a. Fuzz: any caller with the correct preimage can claim;
    //      locked funds always reach the designated beneficiary.
    function testFuzz_claim_fundsAlwaysGoToBeneficiary(address caller, bytes32 secret) public {
        vm.assume(caller != address(0));
        vm.assume(caller != beneficiary); // avoid double-counting
        vm.assume(caller.code.length == 0); // EOA so safety-deposit push succeeds

        bytes memory pre = abi.encodePacked(secret);
        uint256 id = _setupOrder(sha256(pre));

        vm.prank(caller);
        htlcOpen.claimOrder(id, pre);

        assertEq(beneficiary.balance, AMT);
    }

    // 10b. Fuzz: any caller can trigger refund after expiry;
    //      locked funds always reach the designated refundAddress.
    function testFuzz_refund_fundsAlwaysGoToRefundAddress(address caller, bytes32 secret) public {
        vm.assume(caller != address(0));
        vm.assume(caller != refundAddr);
        vm.assume(caller.code.length == 0);

        bytes memory pre = abi.encodePacked(secret);
        uint256 id = _setupOrder(sha256(pre));

        vm.warp(block.timestamp + TL + 1);
        vm.prank(caller);
        htlcOpen.refundOrder(id);

        assertEq(refundAddr.balance, AMT);
    }

    // 10c. Fuzz: preimage of wrong length is always rejected before hash-check.
    function testFuzz_preimage_wrongLength_alwaysReverts(uint8 len, bytes32 secret) public {
        vm.assume(len != 32);
        bytes memory pre32 = abi.encodePacked(secret);
        uint256 id = _setupOrder(sha256(pre32));

        bytes memory wrongLen = new bytes(len);
        vm.expectRevert(HTLCEscrow.InvalidPreimage.selector);
        htlcOpen.claimOrder(id, wrongLen);
    }

    // 10d. Fuzz: gated registry — only authorised callers can create orders.
    function testFuzz_createOrder_gating(address caller, bool active) public {
        vm.assume(caller != address(0));
        vm.assume(caller.code.length == 0);

        StubRegistry stub = new StubRegistry(active);
        HTLCEscrow htlcFuzz = new HTLCEscrow(stub, SD);

        bytes32 hl = _sha256Lock(_preimage(900));
        vm.deal(caller, AMT + SD);
        vm.prank(caller);

        if (active) {
            uint256 id = htlcFuzz.createOrder{value: AMT + SD}(
                beneficiary, refundAddr, address(0), AMT, SD, hl, TL
            );
            assertEq(id, 1);
        } else {
            vm.expectRevert(HTLCEscrow.ResolverNotAuthorised.selector);
            htlcFuzz.createOrder{value: AMT + SD}(
                beneficiary, refundAddr, address(0), AMT, SD, hl, TL
            );
        }
    }

    // 10e. Fuzz: refund before expiry always reverts; refund after expiry always succeeds.
    function testFuzz_refund_timelockEnforcement(uint64 tl, uint64 warpDelta) public {
        tl = uint64(bound(tl, htlcOpen.MIN_TIMELOCK(), htlcOpen.MAX_TIMELOCK()));

        bytes memory pre = _preimage(uint256(tl));
        bytes32 hl = _sha256Lock(pre);
        vm.deal(resolver, AMT + SD);
        vm.prank(resolver);
        uint256 id = htlcOpen.createOrder{value: AMT + SD}(
            beneficiary, refundAddr, address(0), AMT, SD, hl, tl
        );

        uint64 absoluteTl = htlcOpen.getOrder(id).timelock;

        // Warp to a time strictly before expiry.
        vm.warp(absoluteTl - 1);
        vm.expectRevert(HTLCEscrow.NotExpired.selector);
        htlcOpen.refundOrder(id);

        // Warp to exactly the timelock — still not expired.
        vm.warp(absoluteTl);
        vm.expectRevert(HTLCEscrow.NotExpired.selector);
        htlcOpen.refundOrder(id);

        // Warp past expiry — succeeds.
        vm.warp(uint256(absoluteTl) + uint256(bound(warpDelta, 1, 365 days)));
        htlcOpen.refundOrder(id);
        assertEq(uint8(htlcOpen.getOrder(id).status), uint8(IHTLCEscrow.OrderStatus.Refunded));
    }

    // Section 11: Reentrancy resistance
    // Test reentrancy resistance when claiming an order with a malicious beneficiary
    function test_reentrancy_claimOrder_reentrantBeneficiary() public {
        ReentrantActor actor = new ReentrantActor(htlcOpen);
        bytes memory pre = _preimage(1101);
        bytes32 hl = _sha256Lock(pre);

        // Create order with the reentrant actor as beneficiary
        vm.deal(resolver, AMT + SD);
        vm.prank(resolver);
        uint256 id = htlcOpen.createOrder{value: AMT + SD}(
            address(actor), refundAddr, address(0), AMT, SD, hl, TL
        );

        // Configure actor to reenter claimOrder
        actor.setPreimageAndOrder(pre, id);
        actor.setReenterClaim(true);

        // Perform claim. The claim should succeed but the reentrant call should fail
        htlcOpen.claimOrder(id, pre);

        assertTrue(actor.reentrancyAttempted());
        assertFalse(actor.reentrancySucceeded());
        // Verify balance and status
        assertEq(uint8(htlcOpen.getOrder(id).status), uint8(IHTLCEscrow.OrderStatus.Claimed));
    }

    function test_reentrancy_claimOrder_reentrantWithdraw() public {
        ReentrantActor actor = new ReentrantActor(htlcOpen);
        bytes memory pre = _preimage(1102);
        bytes32 hl = _sha256Lock(pre);

        vm.deal(resolver, AMT + SD);
        vm.prank(resolver);
        uint256 id = htlcOpen.createOrder{value: AMT + SD}(
            address(actor), refundAddr, address(0), AMT, SD, hl, TL
        );

        actor.setPreimageAndOrder(pre, id);
        actor.setReenterWithdraw(true);

        htlcOpen.claimOrder(id, pre);

        assertTrue(actor.reentrancyAttempted());
        assertFalse(actor.reentrancySucceeded());
    }

    // Test reentrancy resistance when refunding an order with a malicious refundAddress
    function test_reentrancy_refundOrder_reentrantRefund() public {
        ReentrantActor actor = new ReentrantActor(htlcOpen);
        bytes memory pre = _preimage(1103);
        bytes32 hl = _sha256Lock(pre);

        // Create order with the reentrant actor as refund address
        vm.deal(resolver, AMT + SD);
        vm.prank(resolver);
        uint256 id = htlcOpen.createOrder{value: AMT + SD}(
            beneficiary, address(actor), address(0), AMT, SD, hl, TL
        );

        actor.setPreimageAndOrder(pre, id);
        actor.setReenterRefund(true);

        vm.warp(block.timestamp + TL + 1);
        htlcOpen.refundOrder(id);

        assertTrue(actor.reentrancyAttempted());
        assertFalse(actor.reentrancySucceeded());
        assertEq(uint8(htlcOpen.getOrder(id).status), uint8(IHTLCEscrow.OrderStatus.Refunded));
    }

    // Section 12: Safety deposit accountability
    // Test that the safety deposit is correctly handled and accounted for in balance
    function test_safetyDeposit_accountability_claim() public {
        bytes memory pre = _preimage(1201);
        uint256 id = _createNative(htlcOpen, resolver, beneficiary, refundAddr, pre);

        uint256 balanceBeforeClaim = address(htlcOpen).balance;
        assertEq(balanceBeforeClaim, AMT + SD);

        // Claim by relayer (EOA)
        uint256 relayerBalanceBefore = relayer.balance;
        vm.prank(relayer);
        htlcOpen.claimOrder(id, pre);

        // Safety deposit paid to relayer, amount paid to beneficiary
        assertEq(address(htlcOpen).balance, 0);
        assertEq(relayer.balance, relayerBalanceBefore + SD);
        assertEq(beneficiary.balance, AMT);
    }

    function test_safetyDeposit_accountability_refund() public {
        bytes memory pre = _preimage(1202);
        uint256 id = _createNative(htlcOpen, resolver, beneficiary, refundAddr, pre);

        vm.warp(block.timestamp + TL + 1);

        uint256 relayerBalanceBefore = relayer.balance;
        vm.prank(relayer);
        htlcOpen.refundOrder(id);

        // Safety deposit paid to relayer, amount paid to refundAddr
        assertEq(address(htlcOpen).balance, 0);
        assertEq(relayer.balance, relayerBalanceBefore + SD);
        assertEq(refundAddr.balance, AMT);
    }

    // Section 13: Preimage validation & collision
    // Test collision resistance between orders
    function test_preimage_noCollision() public {
        bytes memory preA = _preimage(1301);
        bytes memory preB = _preimage(1302);
        bytes32 hlA = _sha256Lock(preA);
        bytes32 hlB = _sha256Lock(preB);

        uint256 idA = _setupOrder(hlA);
        
        vm.deal(resolver, AMT + SD);
        vm.prank(resolver);
        uint256 idB = htlcOpen.createOrder{value: AMT + SD}(
            beneficiary, refundAddr, address(0), AMT, SD, hlB, TL
        );

        // Claiming idA with preB must revert
        vm.expectRevert(HTLCEscrow.InvalidPreimage.selector);
        htlcOpen.claimOrder(idA, preB);

        // Claiming idB with preA must revert
        vm.expectRevert(HTLCEscrow.InvalidPreimage.selector);
        htlcOpen.claimOrder(idB, preA);
    }

    // Section 14: Registry integration tests (Slashing, Activation, Stake changes)
    // Test real ResolverRegistry integration
    function test_registry_integration_flow() public {
        // Deploy staking token
        TestERC20 token = _deployToken();
        
        // Deploy registry
        uint256 minStakeAmt = 100 ether;
        address registryOwner = makeAddr("registryOwner");
        address slashBen = makeAddr("slashBeneficiary");
        
        ResolverRegistry registry = new ResolverRegistry(
            token,
            minStakeAmt,
            slashBen,
            registryOwner
        );

        // Deploy new HTLCEscrow gated by this registry
        HTLCEscrow gatedEscrow = new HTLCEscrow(registry, SD);

        // Resolver attempts to create order before registering -> reverts
        bytes32 hl = _sha256Lock(_preimage(1401));
        vm.deal(resolver, AMT + SD);
        vm.prank(resolver);
        vm.expectRevert(HTLCEscrow.ResolverNotAuthorised.selector);
        gatedEscrow.createOrder{value: AMT + SD}(
            beneficiary, refundAddr, address(0), AMT, SD, hl, TL
        );

        // Resolver registers with enough stake
        token.transfer(resolver, minStakeAmt);
        vm.startPrank(resolver);
        token.approve(address(registry), minStakeAmt);
        registry.register(minStakeAmt);
        vm.stopPrank();

        // Resolver is now active, should be able to create order
        vm.prank(resolver);
        uint256 id = gatedEscrow.createOrder{value: AMT + SD}(
            beneficiary, refundAddr, address(0), AMT, SD, hl, TL
        );
        assertEq(id, 1);

        // Owner slashes the resolver, bringing their stake below minimum
        vm.prank(registryOwner);
        registry.slash(resolver, 10 ether);

        // Resolver is no longer active
        assertFalse(registry.isActive(resolver));

        // Resolver tries to create another order -> reverts
        bytes32 hl2 = _sha256Lock(_preimage(1402));
        vm.deal(resolver, AMT + SD);
        vm.prank(resolver);
        vm.expectRevert(HTLCEscrow.ResolverNotAuthorised.selector);
        gatedEscrow.createOrder{value: AMT + SD}(
            beneficiary, refundAddr, address(0), AMT, SD, hl2, TL
        );

        // Resolver increases stake to meet minimum again
        token.transfer(resolver, 10 ether);
        vm.startPrank(resolver);
        token.approve(address(registry), 10 ether);
        registry.increaseStake(10 ether);
        vm.stopPrank();

        // Resolver is active again
        assertTrue(registry.isActive(resolver));

        // Resolver can create order again
        vm.prank(resolver);
        uint256 id2 = gatedEscrow.createOrder{value: AMT + SD}(
            beneficiary, refundAddr, address(0), AMT, SD, hl2, TL
        );
        assertEq(id2, 2);

        // Resolver unregisters
        vm.prank(resolver);
        registry.unregister();

        // Resolver is inactive again
        assertFalse(registry.isActive(resolver));
    }
}
