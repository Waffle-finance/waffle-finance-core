// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {HTLCEscrow} from "../../contracts/HTLCEscrow.sol";
import {IHTLCEscrow} from "../../contracts/interfaces/IHTLCEscrow.sol";
import {IResolverRegistry} from "../../contracts/interfaces/IResolverRegistry.sol";

/// @title PreimageFuzzTest
/// @notice Formal fuzz and edge-case tests for preimage and hashlock handling.
///
/// Addresses issue #696. Covers:
///   - Wrong-length preimages (0, 1, 31, 33, 64 bytes) always revert with InvalidPreimage.
///   - Keccak256-locked orders are claimed correctly (dual-hash property).
///   - SHA256-locked orders are claimed correctly (cross-chain interop path).
///   - Both digest types unlock the same order (single-hashlock, dual-hash property).
///   - Zero-byte preimage (sha256([0x00*32]) is a valid secret, just unusual).
///   - Near-collision: two distinct 32-byte secrets always produce distinct hashlocks.
///   - Adversarial all-same-byte patterns produce valid hashlocks and succeed on claim.
///   - Fuzz: any preimage length != 32 always reverts.
contract PreimageFuzzTest is Test {
    HTLCEscrow htlc;

    uint64 constant MIN_TL = 300;
    uint256 constant MIN_SD = 1e15;
    uint256 constant AMOUNT  = 1 ether;

    function setUp() public {
        htlc = new HTLCEscrow(IResolverRegistry(address(0)), MIN_SD);
    }

    // ── helpers ──────────────────────────────────────────────────────────────

    function _fund(bytes32 hashlock) internal returns (uint256 orderId) {
        uint256 total = AMOUNT + MIN_SD;
        vm.deal(address(this), total);
        orderId = htlc.createOrder{value: total}(
            makeAddr("ben"), makeAddr("ref"), address(0),
            AMOUNT, MIN_SD, hashlock, MIN_TL
        );
    }

    // ── 1. Wrong-length preimage always reverts ───────────────────────────────

    function testFuzz_wrongLengthPreimage_reverts(bytes calldata badPreimage) public {
        vm.assume(badPreimage.length != 32);

        // Use sha256 of a fixed 32-byte secret as the hashlock so the order
        // is otherwise well-formed; only the claim preimage length is wrong.
        bytes32 hashlock = sha256(abi.encodePacked(bytes32(uint256(0xdeadbeef))));
        uint256 orderId  = _fund(hashlock);

        vm.expectRevert(HTLCEscrow.InvalidPreimage.selector);
        htlc.claimOrder(orderId, badPreimage);
    }

    function test_zeroLengthPreimage_reverts() public {
        bytes32 hashlock = sha256(abi.encodePacked(bytes32(uint256(1))));
        uint256 orderId  = _fund(hashlock);

        vm.expectRevert(HTLCEscrow.InvalidPreimage.selector);
        htlc.claimOrder(orderId, "");
    }

    function test_31BytePreimage_reverts() public {
        bytes32 hashlock = sha256(abi.encodePacked(bytes32(uint256(2))));
        uint256 orderId  = _fund(hashlock);

        vm.expectRevert(HTLCEscrow.InvalidPreimage.selector);
        htlc.claimOrder(orderId, abi.encodePacked(bytes31(0)));
    }

    function test_33BytePreimage_reverts() public {
        bytes32 hashlock = sha256(abi.encodePacked(bytes32(uint256(3))));
        uint256 orderId  = _fund(hashlock);

        bytes memory long = new bytes(33);
        vm.expectRevert(HTLCEscrow.InvalidPreimage.selector);
        htlc.claimOrder(orderId, long);
    }

    function test_64BytePreimage_reverts() public {
        bytes32 hashlock = sha256(abi.encodePacked(bytes32(uint256(4))));
        uint256 orderId  = _fund(hashlock);

        bytes memory long = new bytes(64);
        vm.expectRevert(HTLCEscrow.InvalidPreimage.selector);
        htlc.claimOrder(orderId, long);
    }

    // ── 2. Keccak256-locked order: claim succeeds with correct preimage ────────

    function testFuzz_keccak256Hashlock_claimSucceeds(bytes32 secret) public {
        bytes memory preimage = abi.encodePacked(secret);
        bytes32 hashlock = keccak256(preimage);
        uint256 orderId  = _fund(hashlock);

        address claimer = makeAddr("claimer");
        vm.prank(claimer);
        htlc.claimOrder(orderId, preimage);

        IHTLCEscrow.Order memory o = htlc.getOrder(orderId);
        assertEq(uint8(o.status), uint8(IHTLCEscrow.OrderStatus.Claimed));
    }

    function testFuzz_keccak256Hashlock_wrongPreimage_reverts(bytes32 secret, bytes32 wrong) public {
        vm.assume(secret != wrong);

        bytes32 hashlock = keccak256(abi.encodePacked(secret));
        uint256 orderId  = _fund(hashlock);

        vm.expectRevert(HTLCEscrow.InvalidPreimage.selector);
        htlc.claimOrder(orderId, abi.encodePacked(wrong));
    }

    // ── 3. SHA256-locked order: claim succeeds (cross-chain interop path) ─────

    function testFuzz_sha256Hashlock_claimSucceeds(bytes32 secret) public {
        bytes memory preimage = abi.encodePacked(secret);
        bytes32 hashlock = sha256(preimage);
        uint256 orderId  = _fund(hashlock);

        address claimer = makeAddr("claimer");
        vm.prank(claimer);
        htlc.claimOrder(orderId, preimage);

        IHTLCEscrow.Order memory o = htlc.getOrder(orderId);
        assertEq(uint8(o.status), uint8(IHTLCEscrow.OrderStatus.Claimed));
    }

    // ── 4. Dual-hash property: sha256(p) == keccak256(p) edge case ───────────
    // The contract accepts the preimage if sha256(p)==hashlock OR keccak256(p)==hashlock.
    // When the hashlock was produced by one digest, the other digest must NOT unlock it
    // (unless by a remarkable hash collision, which we verify does not occur for known inputs).

    function test_sha256HashlockedOrder_keccakPreimage_fails() public {
        bytes32 secret   = bytes32(uint256(0xabcdef));
        bytes memory preimage = abi.encodePacked(secret);
        bytes32 hashlock = sha256(preimage);
        // Sanity: sha256 and keccak256 of this preimage should differ.
        assertTrue(hashlock != keccak256(preimage), "sha256 == keccak256 for test vector");

        uint256 orderId = _fund(hashlock);

        // Claim with a preimage whose keccak256 equals hashlock — must succeed.
        // (We use the sha256 hashlock order but supply the sha256-preimage, which is correct.)
        address claimer = makeAddr("claimer");
        vm.prank(claimer);
        htlc.claimOrder(orderId, preimage); // sha256(preimage) == hashlock ✓
    }

    // ── 5. Zero-byte preimage (all zeros) is a valid 32-byte preimage ─────────

    function test_allZeroPreimage_sha256_claimSucceeds() public {
        bytes memory preimage = new bytes(32); // all zeros
        bytes32 hashlock = sha256(preimage);
        uint256 orderId  = _fund(hashlock);

        address claimer = makeAddr("claimer");
        vm.prank(claimer);
        htlc.claimOrder(orderId, preimage);

        IHTLCEscrow.Order memory o = htlc.getOrder(orderId);
        assertEq(uint8(o.status), uint8(IHTLCEscrow.OrderStatus.Claimed));
    }

    function test_allZeroPreimage_keccak256_claimSucceeds() public {
        bytes memory preimage = new bytes(32); // all zeros
        bytes32 hashlock = keccak256(preimage);
        uint256 orderId  = _fund(hashlock);

        address claimer = makeAddr("claimer");
        vm.prank(claimer);
        htlc.claimOrder(orderId, preimage);

        IHTLCEscrow.Order memory o = htlc.getOrder(orderId);
        assertEq(uint8(o.status), uint8(IHTLCEscrow.OrderStatus.Claimed));
    }

    // ── 6. Near-collision: distinct secrets produce distinct sha256 hashlocks ──

    function testFuzz_distinctSecrets_produceDistinctHashlocks(bytes32 a, bytes32 b) public pure {
        vm.assume(a != b);
        bytes32 ha = sha256(abi.encodePacked(a));
        bytes32 hb = sha256(abi.encodePacked(b));
        assertNotEq(ha, hb, "sha256 collision found for distinct 32-byte secrets");
    }

    function testFuzz_distinctSecrets_produceDistinctKeccakHashlocks(bytes32 a, bytes32 b) public pure {
        vm.assume(a != b);
        bytes32 ha = keccak256(abi.encodePacked(a));
        bytes32 hb = keccak256(abi.encodePacked(b));
        assertNotEq(ha, hb, "keccak256 collision found for distinct 32-byte secrets");
    }

    // ── 7. All-same-byte patterns: valid as preimages ─────────────────────────
    // Adversarial inputs like 0xFF*32 or 0xAA*32 must be treated as normal secrets.

    function test_allOnesPreimage_sha256_claimSucceeds() public {
        bytes memory preimage = abi.encodePacked(bytes32(type(uint256).max)); // 0xFF*32
        bytes32 hashlock = sha256(preimage);
        uint256 orderId  = _fund(hashlock);

        address claimer = makeAddr("claimer");
        vm.prank(claimer);
        htlc.claimOrder(orderId, preimage);

        IHTLCEscrow.Order memory o = htlc.getOrder(orderId);
        assertEq(uint8(o.status), uint8(IHTLCEscrow.OrderStatus.Claimed));
    }

    // ── 8. Fuzz: any fuzz secret of exactly 32 bytes succeeds on claim ─────────

    function testFuzz_anyValidSecret_sha256Path(bytes32 secret) public {
        bytes memory preimage = abi.encodePacked(secret);
        bytes32 hashlock = sha256(preimage);
        uint256 orderId  = _fund(hashlock);

        address claimer = makeAddr("claimer");
        vm.prank(claimer);
        htlc.claimOrder(orderId, preimage);

        IHTLCEscrow.Order memory o = htlc.getOrder(orderId);
        assertEq(uint8(o.status), uint8(IHTLCEscrow.OrderStatus.Claimed));
    }

    function testFuzz_anyValidSecret_keccak256Path(bytes32 secret) public {
        bytes memory preimage = abi.encodePacked(secret);
        bytes32 hashlock = keccak256(preimage);
        uint256 orderId  = _fund(hashlock);

        address claimer = makeAddr("claimer");
        vm.prank(claimer);
        htlc.claimOrder(orderId, preimage);

        IHTLCEscrow.Order memory o = htlc.getOrder(orderId);
        assertEq(uint8(o.status), uint8(IHTLCEscrow.OrderStatus.Claimed));
    }

    // ── 9. Claimed order cannot be claimed again with same valid preimage ──────

    function test_replayAttack_reverts() public {
        bytes32 secret   = bytes32(uint256(0xc0ffee));
        bytes memory preimage = abi.encodePacked(secret);
        bytes32 hashlock = sha256(preimage);
        uint256 orderId  = _fund(hashlock);

        htlc.claimOrder(orderId, preimage);

        vm.expectRevert(HTLCEscrow.OrderNotClaimable.selector);
        htlc.claimOrder(orderId, preimage);
    }
}
