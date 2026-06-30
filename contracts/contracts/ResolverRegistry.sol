// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

import {IResolverRegistry} from "./interfaces/IResolverRegistry.sol";

/// @title ResolverRegistry
/// @notice Open stake/slash registry for WaffleFinance resolvers. Resolvers
///         post a stake of a chosen ERC20 (typically a stablecoin or
///         the project's governance token) to become eligible to fill
///         swap orders.
///
///         Misbehaviour is slashed by the `owner`, which is intended to
///         be a multisig or DAO contract — NOT an EOA. The owner
///         CANNOT spend an honest resolver's stake; the only privileged
///         action is `slash`, which is gated by economic semantics
///         (off-chain governance) and emits an auditable event.
///
///         This contract is intentionally separate from the HTLC: a
///         compromise of the registry cannot move user funds. The HTLC
///         queries `isActive` only as a soft sybil filter for who may
///         create orders.
///
/// ─── Storage invariants ─────────────────────────────────────────────────────
///
///  I1. _resolverIndex[a] == 0  ⟺  a is NOT in _resolverList
///      (zero means "not present"; the mapping is 1-based so that the
///       default uint256 value unambiguously signals absence)
///
///  I2. For every a where _resolverIndex[a] != 0:
///        _resolverList[ _resolverIndex[a] - 1 ] == a
///      (the 1-based index round-trips back to the same address)
///
///  I3. _resolvers[a].resolver == a  whenever  _resolverIndex[a] != 0
///      (the resolver field mirrors the key for convenient off-chain use)
///
///  I4. _resolvers[a] == default  whenever  _resolverIndex[a] == 0
///      (no orphaned ResolverInfo records — register/unregister are atomic)
///
///  I5. _resolverList.length == number of addresses with _resolverIndex != 0
///
/// These invariants are maintained by ensuring every state-mutating function
/// follows strict Checks-Effects-Interactions order: ALL storage writes
/// (including both _resolvers and _resolverIndex/_resolverList) complete
/// before any external call is made.
/// ────────────────────────────────────────────────────────────────────────────
contract ResolverRegistry is IResolverRegistry, Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct ResolverInfo {
        address resolver;
        uint256 stake;
        uint64  registeredAt;
        uint64  lastSlashAt;
        uint256 totalSlashed;
        bool    active;
    }

    /// @notice ERC20 used for staking.
    IERC20 public immutable stakeAsset;

    /// @notice Minimum stake required to be `active`.
    uint256 public minStake;

    /// @notice Address that receives slashed stake.
    address public slashBeneficiary;

    /// @dev Keyed by resolver address.  Cleared entirely on unregister
    ///      (invariant I4).
    mapping(address => ResolverInfo) private _resolvers;

    /// @dev Packed array of all currently-registered resolver addresses.
    ///      Elements are never sparse — removal uses the swap-and-pop idiom
    ///      so the array is always contiguous (invariant I5).
    address[] private _resolverList;

    /// @dev 1-based index into _resolverList.  Zero means "not registered"
    ///      (invariant I1).  A 1-based scheme lets us distinguish "slot 0"
    ///      from "not present" without a separate boolean.
    mapping(address => uint256) private _resolverIndex;

    // ---------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------

    event Registered(address indexed resolver, uint256 stake);
    event StakeIncreased(address indexed resolver, uint256 added, uint256 newTotal);
    event Unregistered(address indexed resolver, uint256 stakeReturned);
    event Slashed(address indexed resolver, uint256 amount, address indexed beneficiary);
    event MinStakeUpdated(uint256 oldMinStake, uint256 newMinStake);
    event SlashBeneficiaryUpdated(address oldBeneficiary, address newBeneficiary);

    // ---------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------

    error InvalidAmount();
    error InvalidAddress();
    error AlreadyRegistered();
    error NotRegistered();
    error StakeBelowMinimum();

    // ---------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------

    constructor(
        IERC20 _stakeAsset,
        uint256 _minStake,
        address _slashBeneficiary,
        address _owner
    ) Ownable(_owner) {
        if (address(_stakeAsset) == address(0) || _slashBeneficiary == address(0) || _owner == address(0)) {
            revert InvalidAddress();
        }
        stakeAsset = _stakeAsset;
        minStake = _minStake;
        slashBeneficiary = _slashBeneficiary;
    }

    // ---------------------------------------------------------------
    // Resolver self-service
    // ---------------------------------------------------------------

    /// @notice Register as a resolver by posting `stake` of `stakeAsset`.
    ///
    /// @dev Effects-before-interactions order:
    ///      1. Checks  — revert if already registered or stake too small.
    ///      2. Effects — write _resolvers, push to _resolverList, set
    ///                   _resolverIndex.  After these writes all five
    ///                   storage invariants hold.
    ///      3. Interaction — safeTransferFrom pulls the tokens.
    ///
    ///      Pulling tokens AFTER writing state means a reentrant call (e.g.
    ///      via an ERC-777 tokensToSend hook) will see _resolverIndex != 0
    ///      and be rejected by the AlreadyRegistered guard, preventing a
    ///      double-registration.
    function register(uint256 stake) external nonReentrant {
        if (stake < minStake) revert StakeBelowMinimum();
        if (_resolverIndex[msg.sender] != 0) revert AlreadyRegistered();

        // ── Effects ──────────────────────────────────────────────────
        _resolvers[msg.sender] = ResolverInfo({
            resolver:      msg.sender,
            stake:         stake,
            registeredAt:  uint64(block.timestamp),
            lastSlashAt:   0,
            totalSlashed:  0,
            active:        true
        });

        _resolverList.push(msg.sender);
        // 1-based: length after push equals the new slot index.
        _resolverIndex[msg.sender] = _resolverList.length;

        // Invariant assertions (compile-out in production via optimizer;
        // kept here as self-documenting checks for auditors).
        assert(_resolverIndex[msg.sender] != 0);                        // I1
        assert(_resolverList[_resolverIndex[msg.sender] - 1] == msg.sender); // I2

        // ── Interaction ───────────────────────────────────────────────
        stakeAsset.safeTransferFrom(msg.sender, address(this), stake);

        emit Registered(msg.sender, stake);
    }

    /// @notice Increase an existing resolver's stake.
    ///
    /// @dev A resolver that was deactivated by slashing can call this to
    ///      exceed `minStake` again and regain active status.  Effects are
    ///      committed before the token pull (CEI order).
    function increaseStake(uint256 additional) external nonReentrant {
        if (additional == 0) revert InvalidAmount();
        if (_resolverIndex[msg.sender] == 0) revert NotRegistered();

        // ── Effects ──────────────────────────────────────────────────
        ResolverInfo storage info = _resolvers[msg.sender];
        info.stake += additional;
        // Reactivate if the new total meets or exceeds the minimum.
        // This restores resolvers that were deactivated by slash once they
        // top up their stake.
        if (info.stake >= minStake) {
            info.active = true;
        }

        // ── Interaction ───────────────────────────────────────────────
        stakeAsset.safeTransferFrom(msg.sender, address(this), additional);

        emit StakeIncreased(msg.sender, additional, info.stake);
    }

    /// @notice Withdraw the entire stake and remove the resolver.  The
    ///         caller forfeits their `active` status immediately.
    ///
    /// @dev Access control: self-service — only a registered resolver can call
    ///      this for themselves (`msg.sender` is used as the key throughout).
    ///      There is no owner function to forcibly unregister a resolver; the
    ///      owner can only slash their stake, not eject them.
    ///
    ///      Strict CEI order is critical here.  All state mutations —
    ///      clearing _resolvers, removing from _resolverList, and deleting
    ///      _resolverIndex — are committed BEFORE the outgoing safeTransfer.
    ///      This means:
    ///
    ///      • If safeTransfer reverts, the entire transaction reverts and
    ///        the resolver remains registered with their stake intact.
    ///        No partial state is left behind (invariants I1–I5 hold).
    ///
    ///      • If a reentrancy occurs inside safeTransfer (e.g. ERC-777),
    ///        _resolverIndex[msg.sender] is already 0, so any re-entry
    ///        that calls unregister or increaseStake will revert with
    ///        NotRegistered, and any re-entry that calls register will
    ///        find a clean slate (no orphaned entry).
    function unregister() external nonReentrant {
        uint256 idx = _resolverIndex[msg.sender];
        if (idx == 0) revert NotRegistered();

        // Cache stake before clearing storage.
        uint256 stakeToReturn = _resolvers[msg.sender].stake;

        // ── Effects (all storage writes before any external call) ─────
        //
        // 1. Remove from the packed list (swap-and-pop).
        //    _resolverIndex[msg.sender] is zeroed inside _removeFromList.
        _removeFromList(msg.sender, idx);

        // 2. Clear the ResolverInfo record.  This is done AFTER
        //    _removeFromList so the helper can still read the list safely,
        //    but still before the outgoing transfer (CEI satisfied).
        delete _resolvers[msg.sender];

        // Post-effect assertion: both index and info must be gone.
        assert(_resolverIndex[msg.sender] == 0); // I1 / I4

        // ── Interaction ───────────────────────────────────────────────
        if (stakeToReturn > 0) {
            stakeAsset.safeTransfer(msg.sender, stakeToReturn);
        }

        emit Unregistered(msg.sender, stakeToReturn);
    }

    // ---------------------------------------------------------------
    // Owner (DAO/multisig) actions
    // ---------------------------------------------------------------

    /// @notice Slash a registered resolver.  The owner is the only role
    ///         that can call this; the design intent is that `owner` is
    ///         a DAO or multisig that votes on slashing.
    ///
    /// @dev Access control: `onlyOwner` — only the DAO/multisig that controls
    ///      this registry. The owner CANNOT move funds out of `HTLCEscrow`;
    ///      the HTLC and registry are separate contracts. A registry compromise
    ///      therefore cannot steal user funds — at worst it can deactivate
    ///      resolvers, which only delays new order creation.
    ///
    ///      Slashing does NOT remove the resolver from the list. The
    ///      resolver remains registered (their address is in _resolverList
    ///      and _resolverIndex is non-zero) but `active` flips to false if
    ///      their remaining stake falls below `minStake`. The resolver can
    ///      call `increaseStake` to top up and regain active status.
    ///
    ///      CEI is observed: stake accounting and active-flag update happen
    ///      before the outgoing safeTransfer to slashBeneficiary.
    ///
    ///      Invariants maintained: I1–I5 are unchanged (slash only mutates
    ///      `_resolvers[resolver]`; it does not touch _resolverList or
    ///      _resolverIndex).
    function slash(address resolver, uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert InvalidAmount();
        if (_resolverIndex[resolver] == 0) revert NotRegistered();

        // ── Effects ──────────────────────────────────────────────────
        ResolverInfo storage info = _resolvers[resolver];
        uint256 take = amount > info.stake ? info.stake : amount;
        info.stake       -= take;
        info.totalSlashed += take;
        info.lastSlashAt   = uint64(block.timestamp);
        if (info.stake < minStake) {
            info.active = false;
        }

        // ── Interaction ───────────────────────────────────────────────
        if (take > 0) {
            stakeAsset.safeTransfer(slashBeneficiary, take);
        }

        emit Slashed(resolver, take, slashBeneficiary);
    }

    function setMinStake(uint256 newMinStake) external onlyOwner {
        emit MinStakeUpdated(minStake, newMinStake);
        minStake = newMinStake;
    }

    function setSlashBeneficiary(address newBeneficiary) external onlyOwner {
        if (newBeneficiary == address(0)) revert InvalidAddress();
        emit SlashBeneficiaryUpdated(slashBeneficiary, newBeneficiary);
        slashBeneficiary = newBeneficiary;
    }

    // ---------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------

    /// @inheritdoc IResolverRegistry
    function isActive(address resolver) external view returns (bool) {
        return _resolvers[resolver].active && _resolvers[resolver].stake >= minStake;
    }

    /// @notice Return the full ResolverInfo for `resolver`.
    ///         Returns a zero-value struct for unregistered addresses.
    function get(address resolver) external view returns (ResolverInfo memory) {
        return _resolvers[resolver];
    }

    /// @notice Return the list of all currently-registered resolver addresses.
    ///         The order is not stable — removals use swap-and-pop.
    function list() external view returns (address[] memory) {
        return _resolverList;
    }

    /// @notice Return the number of currently-registered resolvers.
    ///         Equivalent to list().length but cheaper (no array copy).
    ///
    /// @dev    This view is the primary invariant check for tests: after
    ///         any sequence of register/unregister/slash calls,
    ///         getResolverCount() must equal the number of addresses for
    ///         which _resolverIndex[a] != 0.
    function getResolverCount() external view returns (uint256) {
        return _resolverList.length;
    }

    /// @notice Alias kept for backwards compatibility.
    function listLength() external view returns (uint256) {
        return _resolverList.length;
    }

    /// @notice Return full ResolverInfo for every currently-active resolver.
    ///         A resolver is active when its `active` flag is true AND its
    ///         stake meets or exceeds the current `minStake`, matching the
    ///         logic used by `isActive`.
    ///
    /// @dev    Off-chain view helper. Iterates the full resolver list in
    ///         memory — avoid calling on-chain in a gas-limited context.
    ///         Coordinators and monitoring tools use this for a single-call
    ///         snapshot instead of N individual `get()` calls.
    ///
    ///         The returned array may be shorter than `getResolverCount()` if
    ///         some registered resolvers are currently inactive due to slashing
    ///         or a `minStake` increase.
    function getActiveResolvers() external view returns (ResolverInfo[] memory) {
        uint256 len = _resolverList.length;
        uint256 snap = minStake; // cache to avoid repeated SLOADs
        uint256 activeCount = 0;

        for (uint256 i = 0; i < len; i++) {
            ResolverInfo storage info = _resolvers[_resolverList[i]];
            if (info.active && info.stake >= snap) {
                activeCount++;
            }
        }

        ResolverInfo[] memory result = new ResolverInfo[](activeCount);
        uint256 j = 0;
        for (uint256 i = 0; i < len; i++) {
            ResolverInfo storage info = _resolvers[_resolverList[i]];
            if (info.active && info.stake >= snap) {
                result[j++] = info;
            }
        }
        return result;
    }

    /// @notice Return ResolverInfo for each address in `resolvers`.
    ///         Unregistered addresses return a zero-value struct (all fields
    ///         are zero / false / address(0)), matching the behaviour of
    ///         `get()` for unknown addresses.
    ///
    /// @dev    Lets coordinators and front-ends fetch info for a known set of
    ///         resolver addresses in a single RPC call instead of N individual
    ///         `get()` calls.  Safe to call with an empty array.
    function getBatchInfo(address[] calldata resolvers)
        external
        view
        returns (ResolverInfo[] memory)
    {
        ResolverInfo[] memory result = new ResolverInfo[](resolvers.length);
        for (uint256 i = 0; i < resolvers.length; i++) {
            result[i] = _resolvers[resolvers[i]];
        }
        return result;
    }

    // ---------------------------------------------------------------
    // Internal helpers
    // ---------------------------------------------------------------

    /// @dev Swap-and-pop removal from _resolverList in O(1).
    ///
    ///      Invariant maintenance:
    ///        • The swapped-in address (previously at the last slot) has its
    ///          _resolverIndex updated to reflect its new position.
    ///        • _resolverIndex[resolver] is set to 0 BEFORE the pop so that
    ///          it is always zero for any address not currently in the list,
    ///          even if a reentrant read occurred mid-operation (invariant I1).
    ///
    ///      Bounds:
    ///        • `idx` is always in [1, _resolverList.length] because it comes
    ///          directly from _resolverIndex and is checked non-zero by the
    ///          caller.  The assertion below makes this explicit for auditors.
    function _removeFromList(address resolver, uint256 idx) private {
        uint256 listLen = _resolverList.length;

        // Guard: idx must be a valid 1-based index into the current list.
        assert(idx >= 1 && idx <= listLen);
        // Cross-check: the slot this index points to must hold `resolver`
        // (invariant I2 — detect any prior corruption immediately).
        assert(_resolverList[idx - 1] == resolver);

        uint256 lastIdx = listLen - 1; // 0-based index of last element
        uint256 slotIdx = idx - 1;     // 0-based index of the slot to vacate

        if (slotIdx != lastIdx) {
            // Move the last element into the vacated slot.
            address swapped = _resolverList[lastIdx];
            _resolverList[slotIdx] = swapped;
            // Update the moved resolver's index to its new 1-based position.
            _resolverIndex[swapped] = idx; // idx == slotIdx + 1
        }

        // Zero the departing resolver's index BEFORE pop so the mapping is
        // never transiently inconsistent (even within a single call frame).
        delete _resolverIndex[resolver];

        _resolverList.pop();
    }
}
