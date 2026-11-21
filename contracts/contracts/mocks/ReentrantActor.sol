// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IHTLCEscrow} from "../interfaces/IHTLCEscrow.sol";

contract ReentrantActor {
    IHTLCEscrow public immutable escrow;
    bool public reentrancyAttempted;
    bool public reentrancySucceeded;
    bytes public preimage;
    uint256 public orderId;
    bool public reenterWithdraw;
    bool public reenterClaim;
    bool public reenterRefund;
    bool public reenterCreate;

    // Stored parameters for a nested createOrder callback.
    address public createToken;
    address public createRecipient;
    uint256 public createAmount;
    uint256 public createExpiry;
    bytes32 public createHashlock;

    // Per-target outcome recording: which nested call was attempted and whether
    // it succeeded. Only the first attempt is recorded.
    bool public callbackAttempted;
    uint8 public callbackTarget; // 0=none, 1=withdraw, 2=claim, 3=refund, 4=create
    bool public callbackSucceeded;

    // Native receive hook configuration: the actor can burn its available gas
    // or revert so it also serves as a bounded-gas native payout recipient.
    bool public burnGasOnReceive;
    bool public revertOnReceive;
    uint256 public receivedTotal;

    constructor(IHTLCEscrow _escrow) {
        escrow = _escrow;
    }

    function setPreimageAndOrder(bytes calldata _preimage, uint256 _orderId) external {
        preimage = _preimage;
        orderId = _orderId;
    }

    function setReenterWithdraw(bool val) external {
        reenterWithdraw = val;
    }

    function setReenterClaim(bool val) external {
        reenterClaim = val;
    }

    function setReenterRefund(bool val) external {
        reenterRefund = val;
    }

    function setReenterCreate(
        bool val,
        address _token,
        address _recipient,
        uint256 _amount,
        uint256 _expiry,
        bytes32 _hashlock
    ) external {
        reenterCreate = val;
        createToken = _token;
        createRecipient = _recipient;
        createAmount = _amount;
        createExpiry = _expiry;
        createHashlock = _hashlock;
    }

    function setReceiveBehavior(bool _burnGas, bool _revert) external {
        burnGasOnReceive = _burnGas;
        revertOnReceive = _revert;
    }

    function resetCallbackState() external {
        reentrancyAttempted = false;
        reentrancySucceeded = false;
        callbackAttempted = false;
        callbackTarget = 0;
        callbackSucceeded = false;
    }

    receive() external payable {
        receivedTotal += msg.value;

        if (revertOnReceive) {
            revert("ReentrantActor: receive reverted");
        }

        if (burnGasOnReceive) {
            // Consume the entire remaining stipend so the outer send fails.
            uint256 gasToBurn = gasleft();
            while (gasToBurn > 0) {
                unchecked {
                    --gasToBurn;
                }
            }
        }

        if (!reentrancyAttempted) {
            reentrancyAttempted = true;
            if (reenterWithdraw) {
                _recordAttempt(1);
                try escrow.withdraw() {
                    _recordSuccess();
                } catch {}
            } else if (reenterClaim) {
                _recordAttempt(2);
                try escrow.claimOrder(orderId, preimage) {
                    _recordSuccess();
                } catch {}
            } else if (reenterRefund) {
                _recordAttempt(3);
                try escrow.refundOrder(orderId) {
                    _recordSuccess();
                } catch {}
            } else if (reenterCreate) {
                _recordAttempt(4);
                try
                    escrow.createOrder(
                        createToken,
                        createRecipient,
                        createAmount,
                        createExpiry,
                        createHashlock
                    )
                {
                    _recordSuccess();
                } catch {}
            }
        }
    }

    function _recordAttempt(uint8 target) internal {
        callbackAttempted = true;
        callbackTarget = target;
    }

    function _recordSuccess() internal {
        reentrancySucceeded = true;
        callbackSucceeded = true;
    }

    function pull() external returns (uint256) {
        return escrow.withdraw();
    }
}
