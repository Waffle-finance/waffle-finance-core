// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IHTLCEscrow
/// @notice Public interface for the WaffleFinance v2 HTLC contract.
/// @dev The semantics mirror the WaffleFinance Soroban HTLC so that a swap
///      between Ethereum and Stellar enforces the same hash + time-lock
///      invariants on both chains.
interface IHTLCEscrow {
    /// @dev Lifecycle state of a single HTLC order.
    enum OrderStatus {
        Funded,
        Claimed,
        Refunded
    }

    /// @dev A single hash + time-locked order.
    struct Order {
        address sender;
        address beneficiary;
        address refundAddress;
        address token;          // address(0) == native ETH
        uint256 amount;
        uint256 safetyDeposit;
        bytes32 hashlock;       // sha256(preimage) when interoperating
                                // with the Soroban side; the contract
                                // verifies both sha256 AND keccak256 so
                                // resolver implementations can choose.
        uint64  timelock;       // unix seconds; refund allowed after.
        uint64  createdAt;
        uint64  finalisedAt;    // 0 while Funded
        OrderStatus status;
        bytes32 preimageKeccak; // 0 until claimed; the keccak digest of
                                // the revealed preimage (kept on-chain
                                // for cross-chain proofs).
    }

    event OrderCreated(
        uint256 indexed orderId,
        address indexed sender,
        address indexed beneficiary,
        address token,
        uint256 amount,
        uint256 safetyDeposit,
        bytes32 hashlock,
        uint64  timelock
    );

    event OrderClaimed(
        uint256 indexed orderId,
        address indexed claimer,
        bytes32 preimage,
        uint256 amount,
        uint256 safetyDeposit
    );

    event OrderRefunded(
        uint256 indexed orderId,
        address indexed caller,
        uint256 amount,
        uint256 safetyDeposit
    );

    /// @notice Emitted when a native-ETH payout could not be pushed to its
    ///         recipient (e.g. the recipient is a contract that reverts on
    ///         receive or exhausts the payout gas stipend) and was instead
    ///         credited to the recipient's pull-payment balance. The
    ///         associated claim/refund still finalises successfully; the
    ///         recipient (or anyone acting as that address) recovers the
    ///         funds permissionlessly via {withdraw}.
    event PayoutDeferred(
        uint256 indexed orderId,
        address indexed recipient,
        uint256 amount
    );

    /// @notice Emitted when a recipient pulls a previously-deferred native
    ///         payout via {withdraw}.
    event Withdrawn(address indexed recipient, uint256 amount);

    function createOrder(
        address beneficiary,
        address refundAddress,
        address token,
        uint256 amount,
        uint256 safetyDeposit,
        bytes32 hashlock,
        uint64  timelockSeconds
    ) external payable returns (uint256 orderId);

    function claimOrder(uint256 orderId, bytes memory preimage) external;
    function refundOrder(uint256 orderId) external;
    function getOrder(uint256 orderId) external view returns (Order memory);

    /// @notice Withdraw any native ETH credited to the caller after a payout
    ///         could not be pushed during a claim/refund. Reverts if the
    ///         caller has no pending balance, or if the transfer to the
    ///         caller fails (in which case the balance is preserved for a
    ///         later retry — funds are never stranded).
    /// @return amount The amount of wei withdrawn.
    function withdraw() external returns (uint256 amount);

    /// @notice The native ETH balance credited to `account` that is awaiting
    ///         withdrawal via {withdraw}.
    function pendingWithdrawals(address account) external view returns (uint256);
}
