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
        Guzzle
    }

    Mode public mode;

    /// @dev Storage sink used to burn gas in Guzzle mode.
    uint256 private _sink;

    function setMode(Mode m) external {
        mode = m;
    }

    receive() external payable {
        if (mode == Mode.Reject) {
            revert("HTLCReceiverMock: rejected");
        }
        if (mode == Mode.Guzzle) {
            // Write storage repeatedly to consume well over PAYOUT_GAS_STIPEND.
            uint256 acc = _sink;
            for (uint256 i = 0; i < 64; i++) {
                acc += i + 1;
                _sink = acc;
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

/// @title NoFallbackReceiver
/// @notice A contract with neither a `receive` nor a payable `fallback`, so
///         any plain native-ETH transfer reverts. Models the classic
///         "contract that cannot accept ETH" beneficiary.
contract NoFallbackReceiver {
    function pull(IHTLCEscrow escrow) external returns (uint256) {
        return escrow.withdraw();
    }
}
