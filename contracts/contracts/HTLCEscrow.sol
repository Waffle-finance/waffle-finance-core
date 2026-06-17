// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

import {IHTLCEscrow} from "./interfaces/IHTLCEscrow.sol";
import {IResolverRegistry} from "./interfaces/IResolverRegistry.sol";

/// @title HTLCEscrow
/// @notice WaffleFinance v2 canonical Ethereum-side HTLC. Mirrors the
///         WaffleFinance Soroban HTLC; the two contracts together implement
///         atomic cross-chain swaps with these properties:
///
///         1. Funds locked by `createOrder` can only move under two
///            conditions:
///            - The beneficiary reveals a preimage whose digest matches
///              `hashlock` before `timelock`.
///            - Anyone calls `refundOrder` after `timelock` has expired;
///              the locked funds are returned to `refundAddress`.
///
///         2. There is no admin escape hatch, no `emergencyWithdraw`,
///            and no `pause`. The contract is non-custodial by construction:
///            even the deployer cannot move locked funds.
///
///         3. The optional `ResolverRegistry` integration is a SOFT hook
///            used to gate who may *create* orders (so the off-chain
///            order book stays sybil-resistant). It does NOT affect the
///            ability of users to claim or refund: those paths are
///            always permissionless.
///
/// @dev The contract verifies preimages using BOTH sha256 (interop with
///      Stellar/Soroban which uses sha256) and keccak256 (matching
///      classic Ethereum HTLC convention). Callers commit to a single
///      `hashlock` and the preimage is accepted iff *either* digest
///      matches it. This lets a single Soroban / Ethereum cross-chain
///      swap use one hashlock end-to-end while keeping the contract
///      compatible with EVM tooling that expects keccak.
contract HTLCEscrow is IHTLCEscrow, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------

    /// @notice Minimum timelock — protects users from accidentally
    ///         creating orders that expire before they can claim.
    uint64 public constant MIN_TIMELOCK = 300;        // 5 minutes
    /// @notice Maximum timelock — protects users from accidentally
    ///         locking funds for unreasonably long periods.
    uint64 public constant MAX_TIMELOCK = 24 * 60 * 60; // 24 hours

    /// @notice Gas stipend forwarded when pushing a native-ETH payout to a
    ///         recipient during claim/refund. Chosen to comfortably cover a
    ///         plain EOA receipt and the receive hooks of common smart-contract
    ///         wallets, while remaining bounded so that a recipient with
    ///         expensive or adversarial receive logic cannot consume the gas
    ///         the transaction needs to finalise the order. Any push that
    ///         exceeds this stipend (or reverts) falls back to the
    ///         pull-payment path — see {_payoutNative} and {withdraw}.
    /// @dev    The stipend is *not* a safety-critical parameter: because the
    ///         pull fallback always preserves the funds, a recipient that
    ///         needs more gas than this simply withdraws in a second step.
    uint256 public constant PAYOUT_GAS_STIPEND = 30_000;

    // ---------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------

    /// @notice Optional resolver registry. When non-zero, only an
    ///         active resolver can call `createOrder`. The registry
    ///         can be cleared by setting this to address(0). Once
    ///         cleared, `createOrder` is permissionless.
    /// @dev The registry pointer is immutable after construction. To
    ///      update it deploy a new HTLCEscrow and migrate.
    IResolverRegistry public immutable resolverRegistry;

    /// @notice The minimum safety deposit accepted by the contract.
    ///         The safety deposit incentivises whoever submits the
    ///         claim or refund transaction.
    uint256 public immutable minSafetyDeposit;

    /// @notice Auto-incrementing order id.
    uint256 private _nextOrderId = 1;

    /// @notice Order data, keyed by order id.
    mapping(uint256 => Order) private _orders;

    /// @notice Native ETH credited to an address whose push payout failed
    ///         during a claim/refund, awaiting collection via {withdraw}.
    /// @dev    This is a strictly per-recipient accounting of funds the
    ///         contract already holds — it is NOT a pooled, operator-movable
    ///         escrow. Only the credited address can pull its own balance, so
    ///         the contract remains non-custodial: no one (including the
    ///         deployer) can redirect or seize a credited payout.
    mapping(address => uint256) private _pendingWithdrawals;

    // ---------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------

    error InvalidAmount();
    error InvalidTimelock();
    error InvalidHashlock();
    error InvalidPreimage();
    error InvalidValue();
    error OrderNotFound();
    error OrderNotClaimable();
    error OrderNotRefundable();
    error NotExpired();
    error Expired();
    error SafetyDepositTooSmall();
    error ResolverNotAuthorised();
    error NativeTransferFailed();
    error NoPendingWithdrawal();

    // ---------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------

    /// @param _resolverRegistry Resolver registry to query when creating
    ///        orders. Pass `address(0)` to disable the gate entirely.
    /// @param _minSafetyDeposit Minimum safety deposit in wei.
    constructor(IResolverRegistry _resolverRegistry, uint256 _minSafetyDeposit) {
        resolverRegistry = _resolverRegistry;
        minSafetyDeposit = _minSafetyDeposit;
    }

    // ---------------------------------------------------------------
    // Core HTLC operations
    // ---------------------------------------------------------------

    /// @inheritdoc IHTLCEscrow
    function createOrder(
        address beneficiary,
        address refundAddress,
        address token,
        uint256 amount,
        uint256 safetyDeposit,
        bytes32 hashlock,
        uint64  timelockSeconds
    ) external payable nonReentrant returns (uint256 orderId) {
        if (amount == 0) revert InvalidAmount();
        if (beneficiary == address(0) || refundAddress == address(0)) revert InvalidAmount();
        if (hashlock == bytes32(0)) revert InvalidHashlock();
        if (timelockSeconds < MIN_TIMELOCK || timelockSeconds > MAX_TIMELOCK) revert InvalidTimelock();
        if (safetyDeposit < minSafetyDeposit) revert SafetyDepositTooSmall();

        if (address(resolverRegistry) != address(0)) {
            if (!resolverRegistry.isActive(msg.sender)) revert ResolverNotAuthorised();
        }

        // Pull funds.
        if (token == address(0)) {
            // Native ETH: msg.value must cover amount + safetyDeposit exactly.
            if (msg.value != amount + safetyDeposit) revert InvalidValue();
        } else {
            // ERC20: msg.value must be exactly safetyDeposit (in ETH) +
            // we pull `amount` of the token from msg.sender.
            if (msg.value != safetyDeposit) revert InvalidValue();
            IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        }

        unchecked {
            orderId = _nextOrderId++;
        }
        uint64 absoluteTimelock = uint64(block.timestamp) + timelockSeconds;

        _orders[orderId] = Order({
            sender: msg.sender,
            beneficiary: beneficiary,
            refundAddress: refundAddress,
            token: token,
            amount: amount,
            safetyDeposit: safetyDeposit,
            hashlock: hashlock,
            timelock: absoluteTimelock,
            createdAt: uint64(block.timestamp),
            finalisedAt: 0,
            status: OrderStatus.Funded,
            preimageKeccak: bytes32(0)
        });

        emit OrderCreated(
            orderId,
            msg.sender,
            beneficiary,
            token,
            amount,
            safetyDeposit,
            hashlock,
            absoluteTimelock
        );
    }

    /// @inheritdoc IHTLCEscrow
    function claimOrder(uint256 orderId, bytes memory preimage) external nonReentrant {
        Order storage order = _orders[orderId];
        if (order.status != OrderStatus.Funded) {
            // Either non-existent or already finalised; both look the same to the caller.
            if (order.amount == 0) revert OrderNotFound();
            revert OrderNotClaimable();
        }
        if (block.timestamp > order.timelock) revert Expired();

        // Verify hashlock. We accept both sha256 and keccak256 digests
        // so that a Soroban-side counterpart (sha256) and a classic EVM
        // counterparty (keccak256) can share the same on-chain hashlock.
        // Preimage must be exactly 32 bytes — any other length indicates
        // a malformed call and is rejected early to save gas.
        if (preimage.length != 32) revert InvalidPreimage();
        bytes32 sha = sha256(preimage);
        if (sha != order.hashlock && keccak256(preimage) != order.hashlock) revert InvalidPreimage();

        order.status = OrderStatus.Claimed;
        order.finalisedAt = uint64(block.timestamp);
        order.preimageKeccak = keccak256(preimage);

        uint256 amount = order.amount;
        uint256 safetyDeposit = order.safetyDeposit;

        // Locked amount → beneficiary.
        _payout(order.token, order.beneficiary, amount, orderId);
        // Safety deposit → whoever submitted the claim.
        if (safetyDeposit > 0) {
            _payout(address(0), msg.sender, safetyDeposit, orderId);
        }

        emit OrderClaimed(orderId, msg.sender, _bytesToBytes32(preimage), amount, safetyDeposit);
    }

    /// @inheritdoc IHTLCEscrow
    function refundOrder(uint256 orderId) external nonReentrant {
        Order storage order = _orders[orderId];
        if (order.status != OrderStatus.Funded) {
            if (order.amount == 0) revert OrderNotFound();
            revert OrderNotRefundable();
        }
        if (block.timestamp <= order.timelock) revert NotExpired();

        order.status = OrderStatus.Refunded;
        order.finalisedAt = uint64(block.timestamp);

        uint256 amount = order.amount;
        uint256 safetyDeposit = order.safetyDeposit;

        _payout(order.token, order.refundAddress, amount, orderId);
        if (safetyDeposit > 0) {
            _payout(address(0), msg.sender, safetyDeposit, orderId);
        }

        emit OrderRefunded(orderId, msg.sender, amount, safetyDeposit);
    }

    // ---------------------------------------------------------------
    // Pull-payment recovery
    // ---------------------------------------------------------------

    /// @inheritdoc IHTLCEscrow
    /// @dev Pull-payment counterpart to the push performed during
    ///      claim/refund. Follows checks-effects-interactions and is
    ///      `nonReentrant`: the credited balance is zeroed before the
    ///      transfer, so a reentrant call sees nothing to withdraw. The
    ///      transfer here forwards all remaining gas (unlike the bounded
    ///      stipend used on the push path), so a contract recipient with
    ///      legitimate receive logic can collect its funds and pay for that
    ///      cost itself. If the transfer still fails the credit is restored
    ///      and the call reverts, leaving funds recoverable on a later retry.
    function withdraw() external nonReentrant returns (uint256 amount) {
        amount = _pendingWithdrawals[msg.sender];
        if (amount == 0) revert NoPendingWithdrawal();

        _pendingWithdrawals[msg.sender] = 0;

        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        if (!ok) {
            _pendingWithdrawals[msg.sender] = amount;
            revert NativeTransferFailed();
        }

        emit Withdrawn(msg.sender, amount);
    }

    /// @inheritdoc IHTLCEscrow
    function pendingWithdrawals(address account) external view returns (uint256) {
        return _pendingWithdrawals[account];
    }

    // ---------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------

    /// @inheritdoc IHTLCEscrow
    function getOrder(uint256 orderId) external view returns (Order memory) {
        Order memory order = _orders[orderId];
        if (order.amount == 0) revert OrderNotFound();
        return order;
    }

    /// @notice Returns the next order id that will be assigned. Useful
    ///         for clients that want to compute the upcoming id without
    ///         simulating a transaction.
    function nextOrderId() external view returns (uint256) {
        return _nextOrderId;
    }

    // ---------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------

    /// @dev Routes a payout to its recipient. ERC20 transfers use SafeERC20
    ///      and revert on failure as before (a failing token transfer is not
    ///      a recoverable condition this contract can paper over). Native ETH
    ///      payouts go through {_payoutNative}, which never reverts so that a
    ///      valid claim/refund always settles.
    function _payout(address token, address to, uint256 amount, uint256 orderId) private {
        if (token == address(0)) {
            _payoutNative(to, amount, orderId);
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    /// @dev Pushes native ETH to `to` with a bounded gas stipend. If the push
    ///      fails for any reason — the recipient reverts, has no payable
    ///      fallback, or its receive hook exceeds {PAYOUT_GAS_STIPEND} — the
    ///      amount is credited to the recipient's pull-payment balance and a
    ///      {PayoutDeferred} event is emitted instead of reverting. This keeps
    ///      the claim/refund atomic (the preimage is still revealed on-chain,
    ///      the order is still finalised) while guaranteeing the funds remain
    ///      recoverable by, and only by, the intended recipient via {withdraw}.
    ///
    ///      Reentrancy is not a concern here: every external entry point that
    ///      moves funds ({claimOrder}, {refundOrder}, {withdraw}) is
    ///      `nonReentrant` and all order state is finalised before this call,
    ///      so the bounded stipend cannot be leveraged to re-enter and double
    ///      spend. The contract holds the ETH throughout — a deferred payout
    ///      is a bookkeeping credit, not an outbound transfer.
    function _payoutNative(address to, uint256 amount, uint256 orderId) private {
        (bool ok, ) = payable(to).call{value: amount, gas: PAYOUT_GAS_STIPEND}("");
        if (!ok) {
            _pendingWithdrawals[to] += amount;
            emit PayoutDeferred(orderId, to, amount);
        }
    }

    function _bytesToBytes32(bytes memory data) private pure returns (bytes32 result) {
        if (data.length == 0) return bytes32(0);
        assembly {
            result := mload(add(data, 32))
        }
    }

    // Reject stray ETH.
    receive() external payable {
        revert InvalidValue();
    }
}
