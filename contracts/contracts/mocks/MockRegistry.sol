// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IResolverRegistry} from "../interfaces/IResolverRegistry.sol";

contract MockRegistry is IResolverRegistry {
    bool private _defaultActive;
    mapping(address => bool) private _activeResolvers;
    bool private _shouldRevert;

    constructor(bool defaultActive_) {
        _defaultActive = defaultActive_;
    }

    function setDefaultActive(bool active_) external {
        _defaultActive = active_;
    }

    function setResolverActive(address resolver, bool active_) external {
        _activeResolvers[resolver] = active_;
    }

    function setShouldRevert(bool revert_) external {
        _shouldRevert = revert_;
    }

    function isActive(address resolver) external view override returns (bool) {
        if (_shouldRevert) {
            revert("MockRegistry: registry reverted");
        }
        if (_activeResolvers[resolver]) {
            return true;
        }
        return _defaultActive;
    }
}
