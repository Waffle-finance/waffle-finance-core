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

    receive() external payable {
        if (!reentrancyAttempted) {
            reentrancyAttempted = true;
            if (reenterWithdraw) {
                try escrow.withdraw() {
                    reentrancySucceeded = true;
                } catch {}
            } else if (reenterClaim) {
                try escrow.claimOrder(orderId, preimage) {
                    reentrancySucceeded = true;
                } catch {}
            } else if (reenterRefund) {
                try escrow.refundOrder(orderId) {
                    reentrancySucceeded = true;
                } catch {}
            }
        }
    }

    function pull() external returns (uint256) {
        return escrow.withdraw();
    }
}
