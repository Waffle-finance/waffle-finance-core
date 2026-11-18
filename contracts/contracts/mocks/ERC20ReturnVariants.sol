// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ReturnsTrueERC20
/// @notice Standard ERC20 behaviour: transfer/transferFrom return `true` on
///         success and revert on failure. This is the happy-path variant that
///         SafeERC20 handles as the baseline.
contract ReturnsTrueERC20 {
    string  public name     = "ReturnsTrueToken";
    string  public symbol   = "RTT";
    uint8   public decimals = 18;
    uint256 public totalSupply;

    mapping(address => uint256)                     public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(uint256 initialSupply) {
        totalSupply       = initialSupply;
        balanceOf[msg.sender] = initialSupply;
        emit Transfer(address(0), msg.sender, initialSupply);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "RTT: balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to]         += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "RTT: balance");
        require(allowance[from][msg.sender] >= amount, "RTT: allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from]             -= amount;
        balanceOf[to]               += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

/// @title NoReturnERC20
/// @notice Non-standard ERC20 (e.g. USDT-style): transfer/transferFrom emit
///         no return value — the ABI decoder receives zero bytes. SafeERC20's
///         `safeTransferFrom` / `safeTransfer` handle this by treating empty
///         return data as a success signal, so the escrow must accept it.
contract NoReturnERC20 {
    string  public name     = "NoReturnToken";
    string  public symbol   = "NRT";
    uint8   public decimals = 18;
    uint256 public totalSupply;

    mapping(address => uint256)                     public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(uint256 initialSupply) {
        totalSupply           = initialSupply;
        balanceOf[msg.sender] = initialSupply;
        emit Transfer(address(0), msg.sender, initialSupply);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    /// @dev Intentionally no return statement — mimics USDT's void transfer.
    function transfer(address to, uint256 amount) external {
        require(balanceOf[msg.sender] >= amount, "NRT: balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to]         += amount;
        emit Transfer(msg.sender, to, amount);
    }

    /// @dev Intentionally no return statement.
    function transferFrom(address from, address to, uint256 amount) external {
        require(balanceOf[from] >= amount, "NRT: balance");
        require(allowance[from][msg.sender] >= amount, "NRT: allowance");
        allowance[from][msg.sender] -= amount;
        balanceOf[from]             -= amount;
        balanceOf[to]               += amount;
        emit Transfer(from, to, amount);
    }
}

/// @title ReturnsFalseERC20
/// @notice Pathological ERC20: transfer/transferFrom return `false` instead of
///         reverting to signal failure. SafeERC20 treats a `false` return as a
///         hard error and reverts, so the escrow must NOT silently consume an
///         order when a token explicitly signals failure via `false`.
contract ReturnsFalseERC20 {
    string  public name     = "ReturnsFalseToken";
    string  public symbol   = "RFT";
    uint8   public decimals = 18;
    uint256 public totalSupply;

    mapping(address => uint256)                     public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(uint256 initialSupply) {
        totalSupply           = initialSupply;
        balanceOf[msg.sender] = initialSupply;
        emit Transfer(address(0), msg.sender, initialSupply);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    /// @dev Always returns false — no tokens actually move.
    function transfer(address, uint256) external pure returns (bool) {
        return false;
    }

    /// @dev Always returns false — no tokens actually move.
    function transferFrom(address, address, uint256) external pure returns (bool) {
        return false;
    }
}
