// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {HTLCEscrow} from "../../contracts/HTLCEscrow.sol";
import {ResolverRegistry} from "../../contracts/ResolverRegistry.sol";
import {IHTLCEscrow} from "../../contracts/interfaces/IHTLCEscrow.sol";
import {IResolverRegistry} from "../../contracts/interfaces/IResolverRegistry.sol";

/// @title UpgradeSafetyTest
/// @notice Tests confirming that upgrade boundaries are enforced and unsafe
///         parameter mutations are blocked or flagged.
///
/// Addresses issue #698. Covers:
///   - `minSafetyDeposit` is immutable — cannot be changed post-deployment.
///   - `setResolverRegistry` is owner-only; non-owners are rejected.
///   - Zero-address registry is rejected (accidental clear prevention).
///   - Registry update emits `ResolverRegistryUpdated(prev, new)`.
///   - Ownership follows Ownable2Step: transfer requires a two-step accept.
///   - Pending owner can accept; stranger cannot accept.
///   - `renounceOwnership` is allowed by Ownable2Step but leaves the contract
///     without an owner, which means `setResolverRegistry` can never be called
///     again — tested as an explicit invariant.
///   - Contract-level invariants are preserved across an ownership handover.
contract UpgradeSafetyTest is Test {
    HTLCEscrow htlc;
    address owner;

    uint256 constant MIN_SD = 1e15;

    function setUp() public {
        owner = makeAddr("owner");
        vm.prank(owner);
        htlc = new HTLCEscrow(IResolverRegistry(address(0)), MIN_SD);
    }

    // ── 1. minSafetyDeposit is immutable ─────────────────────────────────────
    // There is no setter for minSafetyDeposit by design. The only way to change
    // it is to redeploy. We verify this by confirming the value matches what was
    // set at construction and that there is no function that could alter it.

    function test_minSafetyDeposit_matchesConstructorArg() public view {
        assertEq(htlc.minSafetyDeposit(), MIN_SD);
    }

    function test_minSafetyDeposit_immutable_noSetter() public {
        // Verify by confirming the ABI has no function selector that matches a
        // plausible setter name. We call two candidate selectors and expect
        // them to revert (no such function — falls through to the receive hook
        // which also reverts with InvalidValue).
        bytes memory setMin = abi.encodeWithSignature("setMinSafetyDeposit(uint256)", 1);
        (bool ok,) = address(htlc).call(setMin);
        assertFalse(ok, "setMinSafetyDeposit must not exist");

        bytes memory updateMin = abi.encodeWithSignature("updateMinSafetyDeposit(uint256)", 1);
        (bool ok2,) = address(htlc).call(updateMin);
        assertFalse(ok2, "updateMinSafetyDeposit must not exist");
    }

    // ── 2. MIN_TIMELOCK and MAX_TIMELOCK are constants ─────────────────────────

    function test_timelockConstants_areFixed() public view {
        assertEq(htlc.MIN_TIMELOCK(), 300);
        assertEq(htlc.MAX_TIMELOCK(), 86_400);
    }

    // ── 3. setResolverRegistry is owner-only ─────────────────────────────────

    function test_setResolverRegistry_onlyOwner_rejects_stranger() public {
        address stranger = makeAddr("stranger");
        IResolverRegistry newReg = IResolverRegistry(makeAddr("registry"));

        vm.prank(stranger);
        vm.expectRevert();
        htlc.setResolverRegistry(newReg);
    }

    function test_setResolverRegistry_owner_succeeds() public {
        address regAddr = makeAddr("registry");
        IResolverRegistry newReg = IResolverRegistry(regAddr);

        vm.prank(owner);
        htlc.setResolverRegistry(newReg);

        assertEq(address(htlc.resolverRegistry()), regAddr);
    }

    // ── 4. Zero-address registry is rejected ─────────────────────────────────

    function test_setResolverRegistry_zeroAddress_reverts() public {
        vm.prank(owner);
        vm.expectRevert(HTLCEscrow.InvalidAddress.selector);
        htlc.setResolverRegistry(IResolverRegistry(address(0)));
    }

    // ── 5. Registry update emits ResolverRegistryUpdated ─────────────────────

    function test_setResolverRegistry_emitsEvent() public {
        address prev    = address(htlc.resolverRegistry()); // address(0)
        address newAddr = makeAddr("registry");

        vm.prank(owner);
        vm.expectEmit(true, true, false, false);
        emit HTLCEscrow.ResolverRegistryUpdated(prev, newAddr);
        htlc.setResolverRegistry(IResolverRegistry(newAddr));
    }

    function test_setResolverRegistry_eventCarriesPreviousAndNew() public {
        address reg1 = makeAddr("reg1");
        address reg2 = makeAddr("reg2");

        vm.prank(owner);
        htlc.setResolverRegistry(IResolverRegistry(reg1));

        vm.prank(owner);
        vm.expectEmit(true, true, false, false);
        emit HTLCEscrow.ResolverRegistryUpdated(reg1, reg2);
        htlc.setResolverRegistry(IResolverRegistry(reg2));

        assertEq(address(htlc.resolverRegistry()), reg2);
    }

    // ── 6. Ownable2Step: ownership transfer requires two-step accept ──────────

    function test_ownershipTransfer_twoStep() public {
        address newOwner = makeAddr("newOwner");

        // Step 1: initiate transfer
        vm.prank(owner);
        htlc.transferOwnership(newOwner);

        // Owner is still the original owner; new owner is pending
        assertEq(htlc.owner(), owner);
        assertEq(htlc.pendingOwner(), newOwner);

        // Step 2: new owner accepts
        vm.prank(newOwner);
        htlc.acceptOwnership();

        assertEq(htlc.owner(), newOwner);
        assertEq(htlc.pendingOwner(), address(0));
    }

    function test_strangerCannotAcceptPendingOwnership() public {
        address newOwner = makeAddr("newOwner");
        address stranger = makeAddr("stranger");

        vm.prank(owner);
        htlc.transferOwnership(newOwner);

        vm.prank(stranger);
        vm.expectRevert();
        htlc.acceptOwnership();

        // Owner unchanged
        assertEq(htlc.owner(), owner);
    }

    function test_pendingOwnerCannotCallSetRegistryBeforeAccept() public {
        address newOwner = makeAddr("newOwner");
        vm.prank(owner);
        htlc.transferOwnership(newOwner);

        // newOwner has not accepted yet — owner() is still `owner`
        vm.prank(newOwner);
        vm.expectRevert();
        htlc.setResolverRegistry(IResolverRegistry(makeAddr("registry")));
    }

    // ── 7. After ownership handover, new owner can update registry ────────────

    function test_afterHandover_newOwnerCanSetRegistry() public {
        address newOwner = makeAddr("newOwner");

        vm.prank(owner);
        htlc.transferOwnership(newOwner);
        vm.prank(newOwner);
        htlc.acceptOwnership();

        address regAddr = makeAddr("registry");
        vm.prank(newOwner);
        htlc.setResolverRegistry(IResolverRegistry(regAddr));

        assertEq(address(htlc.resolverRegistry()), regAddr);
    }

    function test_afterHandover_previousOwnerCannotSetRegistry() public {
        address newOwner = makeAddr("newOwner");

        vm.prank(owner);
        htlc.transferOwnership(newOwner);
        vm.prank(newOwner);
        htlc.acceptOwnership();

        vm.prank(owner); // old owner
        vm.expectRevert();
        htlc.setResolverRegistry(IResolverRegistry(makeAddr("registry")));
    }

    // ── 8. Renouncing ownership locks setResolverRegistry permanently ─────────
    // This is an explicit upgrade boundary: after renounceOwnership() the registry
    // can never be updated, so operators must deploy a new contract if the registry
    // needs to change. This is an intentional, documented constraint.

    function test_renounceOwnership_locksRegistryForever() public {
        vm.prank(owner);
        htlc.renounceOwnership();

        assertEq(htlc.owner(), address(0));

        // Any attempt to set the registry must now revert
        vm.expectRevert();
        htlc.setResolverRegistry(IResolverRegistry(makeAddr("registry")));
    }

    // ── 9. Core invariants survive an ownership handover ──────────────────────
    // After a full ownership transfer, the non-custodial properties of the contract
    // (claim/refund permissionless, locked funds unreachable by owner) must hold.

    function test_coreInvariants_afterHandover() public {
        address newOwner = makeAddr("newOwner");

        // Transfer ownership
        vm.prank(owner);
        htlc.transferOwnership(newOwner);
        vm.prank(newOwner);
        htlc.acceptOwnership();

        // Create an order as a normal user
        address user    = makeAddr("user");
        address ben     = makeAddr("ben");
        address refAddr = makeAddr("ref");
        bytes32 secret  = bytes32(uint256(0xfeed));
        bytes memory preimage = abi.encodePacked(secret);
        bytes32 hashlock = sha256(preimage);

        vm.deal(user, 2 ether);
        vm.prank(user);
        uint256 orderId = htlc.createOrder{value: 2 ether}(
            ben, refAddr, address(0), 1 ether, 1 ether, hashlock, 300
        );

        // Owner cannot claim locked funds
        vm.prank(newOwner);
        vm.expectRevert(); // InvalidPreimage — owner doesn't know the preimage
        htlc.claimOrder(orderId, abi.encodePacked(bytes32(0)));

        // Correct beneficiary can still claim
        vm.prank(ben);
        htlc.claimOrder(orderId, preimage);

        IHTLCEscrow.Order memory o = htlc.getOrder(orderId);
        assertEq(uint8(o.status), uint8(IHTLCEscrow.OrderStatus.Claimed));
    }

    // ── 10. Fuzz: setResolverRegistry by non-owner always reverts ─────────────

    function testFuzz_setRegistry_nonOwner_alwaysReverts(address caller) public {
        vm.assume(caller != owner);
        vm.assume(caller != address(0));

        address regAddr = makeAddr("registry");
        vm.prank(caller);
        vm.expectRevert();
        htlc.setResolverRegistry(IResolverRegistry(regAddr));
    }
}
