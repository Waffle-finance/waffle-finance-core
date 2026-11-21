// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IHTLCEscrow} from "../interfaces/IHTLCEscrow.sol";

/// @title HTLCReceiverMock
/// @notice Configurable native-ETH recipient used to exercise the HTLCEscrow
///         payout fallback. The `mode` controls how the contract behaves when
///         it receives ETH:
///
///         - Accept: returns immediately (cheap) → direct push succeeds.
///         - Reject: reverts → direct push fails and is deferred to the
///                   pull-payment path; a later {withdraw} also reverts until
///                   the mode is changed, modelling a destination that
///                   legitimately cannot accept ETH.
///         - Guzzle: burns far more than the push gas stipend before
///                   succeeding → the bounded push fails and is deferred, but
///                   a {withdraw} (which forwards all gas) completes.
contract HTLCReceiverMock {
    enum Mode {
        Accept,
        Reject,
        Guzzle,
        // Consume approximately the push gas stipend before succeeding, so the
        // bounded push fails but a later {withdraw} (all gas forwarded) works.
        GuzzleExact,
        // Revert on receive until flipped to accept, so the credited recipient
        // can withdraw exactly once after the mode is changed.
        RejectThenAccept,
        // Attempt to re-enter the escrow's {withdraw} during the push.
        ReenterOnReceive
    }

    Mode public mode;

    /// @dev Storage sink used to burn gas in Guzzle / GuzzleExact modes.
    uint256 private _sink;

    /// @notice Escrow targeted by the {ReenterOnReceive} callback.
    IHTLCEscrow public reenterTarget;

    /// @notice Whether the nested {withdraw} attempted during receive
    ///         succeeded. Recorded so tests can assert the guard held.
    bool public reenterSucceeded;

    /// @notice Number of times a nested {withdraw} was attempted.
    uint256 public reenterAttempts;

    function setMode(Mode m) external {
        mode = m;
    }

    /// @notice Configure the escrow that {ReenterOnReceive} calls back into.
    function setReenterTarget(IHTLCEscrow escrow) external {
        reenterTarget = escrow;
    }

    receive() external payable {
        if (mode == Mode.Reject) {
            revert("HTLCReceiverMock: rejected");
        }
        if (mode == Mode.RejectThenAccept) {
            revert("HTLCReceiverMock: reject-then-accept");
        }
        if (mode == Mode.Guzzle) {
            // Write storage repeatedly to consume well over PAYOUT_GAS_STIPEND.
            uint256 acc = _sink;
            for (uint256 i = 0; i < 64; i++) {
                acc += i + 1;
                _sink = acc;
            }
        }
        if (mode == Mode.GuzzleExact) {
            // Burn a bounded amount of gas: enough to exhaust the push stipend
            // but small enough that a full-gas {withdraw} still completes.
            uint256 acc = _sink;
            for (uint256 i = 0; i < 8; i++) {
                acc += i + 1;
                _sink = acc;
            }
        }
        if (mode == Mode.ReenterOnReceive) {
            reenterAttempts += 1;
            if (address(reenterTarget) != address(0)) {
                // The nested call must not corrupt the outer settlement; a
                // revert here is expected and swallowed so the push succeeds.
                try reenterTarget.withdraw() returns (uint256) {
                    reenterSucceeded = true;
                } catch {
                    reenterSucceeded = false;
                }
            }
        }
        // Accept: fall through; the contract balance reflects the receipt.
    }

    /// @notice Pull a previously-deferred payout from the escrow. `msg.sender`
    ///         seen by the escrow is this contract, i.e. the credited address.
    function pull(IHTLCEscrow escrow) external returns (uint256) {
        return escrow.withdraw();
    }
}

/// @title RecordingReceiverMock
/// @notice Minimal payable receiver that accepts every native-ETH transfer
///         and records the total amount received in a public counter. Used
///         to assert exact payout amounts without relying on balance diffs
///         that can be muddied by gas accounting in the calling test.
contract RecordingReceiverMock {
    /// @notice Cumulative amount of native ETH received across all transfers.
    uint256 public totalReceived;

    receive() external payable {
        totalReceived += msg.value;
    }
}

/// @title NoFallbackReceiver
/// @notice A contract with neither a `receive` nor a payable `fallback`, so
///         any plain native-ETH transfer reverts. Models the classic
///         "contract that cannot accept ETH" beneficiary.
contract NoFallbackReceiver {
    function pull(IHTLCEscrow escrow) external returns (uint256) {
        return escrow.withdraw();
    }
}

/// @title RevertingERC20
/// @notice Minimal ERC-20 whose transfer/transferFrom always revert. Used to
///         assert escrow settlement handles a token that refuses to move
///         funds without corrupting accounting.
contract RevertingERC20 {
    string public constant name = "RevertingERC20";
    string public constant symbol = "RVT";
    uint8 public constant decimals = 18;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function totalSupply() external pure returns (uint256) {
        return 0;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address, uint256) external pure returns (bool) {
        revert("RevertingERC20: transfer disabled");
    }

    function transferFrom(address, address, uint256) external pure returns (bool) {
        revert("RevertingERC20: transferFrom disabled");
    }
}

/// @title ReenteringERC20
/// @notice Minimal ERC-20 whose {transfer} calls back into the escrow's
///         lifecycle methods. Each callback mode targets a different external
///         function so reentrancy guards can be exercised during settlement.
contract ReenteringERC20 {
    string public constant name = "ReenteringERC20";
    string public constant symbol = "RNT";
    uint8 public constant decimals = 18;

    enum Callback {
        None,
        Create,
        Claim,
        Refund,
        Withdraw
    }

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    /// @notice Escrow targeted by the callback.
    IHTLCEscrow public escrow;
    /// @notice Which lifecycle function the next {transfer} should call.
    Callback public callback;
    /// @notice Whether the most recent nested call succeeded.
    bool public lastCallbackSucceeded;
    /// @notice Number of nested callbacks attempted.
    uint256 public callbackAttempts;

    function setEscrow(IHTLCEscrow e) external {
        escrow = e;
    }

    function setCallback(Callback c) external {
        callback = c;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function totalSupply() external pure returns (uint256) {
        return 0;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        _maybeCallback();
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            allowance[from][msg.sender] = allowed - amount;
        }
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        _maybeCallback();
        return true;
    }

    function _maybeCallback() internal {
        Callback c = callback;
        if (c == Callback.None || address(escrow) == address(0)) {
            return;
        }
        callbackAttempts += 1;
        // Nested calls are expected to revert; swallow so the outer transfer
        // completes and accounting can be asserted afterwards.
        try this._dispatch(c) {
            lastCallbackSucceeded = true;
        } catch {
            lastCallbackSucceeded = false;
        }
    }

    /// @dev External self-call so the nested escrow call can be wrapped in a
    ///      try/catch (internal calls cannot be).
    function _dispatch(Callback c) external {
        require(msg.sender == address(this), "ReenteringERC20: self only");
        if (c == Callback.Create) {
            escrow.createOrder(address(this), 0, 0, bytes32(0), 0);
        } else if (c == Callback.Claim) {
            escrow.claim(bytes32(0), bytes32(0));
        } else if (c == Callback.Refund) {
            escrow.refund(bytes32(0));
        } else if (c == Callback.Withdraw) {
            escrow.withdraw();
        }
    }
}
