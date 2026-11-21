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

/// @title FeeOnTransferERC20
/// @notice Non-standard ERC20 that deducts a fee on every transfer: the
///         recipient receives `amount - fee` while the sender is debited the
///         full `amount`. The fee is burned (totalSupply shrinks).
/// @dev Escrow semantics: SUPPORTED via actual-received-balance accounting.
///      The escrow must measure its balance delta around `safeTransferFrom`
///      and record liabilities against the amount actually received, never
///      against the nominal `amount` requested. Otherwise an order could be
///      recorded with liabilities greater than the escrow's token balance.
contract FeeOnTransferERC20 {
    string  public name     = "FeeOnTransferToken";
    string  public symbol   = "FOT";
    uint8   public decimals = 18;
    uint256 public totalSupply;

    /// @notice Fee taken on every transfer, in basis points (1/10_000).
    uint256 public immutable feeBps;

    mapping(address => uint256)                     public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(uint256 initialSupply, uint256 feeBps_) {
        require(feeBps_ <= 10_000, "FOT: fee");
        feeBps                = feeBps_;
        totalSupply           = initialSupply;
        balanceOf[msg.sender] = initialSupply;
        emit Transfer(address(0), msg.sender, initialSupply);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "FOT: allowance");
        allowance[from][msg.sender] -= amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "FOT: balance");
        uint256 fee      = (amount * feeBps) / 10_000;
        uint256 received = amount - fee;

        balanceOf[from] -= amount;
        balanceOf[to]   += received;
        totalSupply     -= fee;

        emit Transfer(from, to, received);
        if (fee > 0) {
            emit Transfer(from, address(0), fee);
        }
    }
}

/// @title RebasingERC20
/// @notice Non-standard ERC20 whose balances change without transfers: a
///         privileged `rebase` call scales every holder's balance by a
///         multiplier. `balanceOf` is therefore not stable across blocks.
/// @dev Escrow semantics: REJECTED. The escrow cannot guarantee that recorded
///      liabilities remain covered by its actual token balance when balances
///      can shrink out-of-band, so rebasing tokens are explicitly unsupported.
///      Integrators must not use this token with the escrow; the escrow's
///      balance-delta accounting would observe a negative delta on rebase and
///      must revert rather than record an under-collateralised order.
contract RebasingERC20 {
    string  public name     = "RebasingToken";
    string  public symbol   = "RBT";
    uint8   public decimals = 18;
    uint256 public totalSupply;

    /// @notice Current rebase multiplier, scaled by 1e18 (1e18 == 1.0x).
    uint256 public multiplier = 1e18;

    mapping(address => uint256)                     public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Rebase(uint256 oldMultiplier, uint256 newMultiplier);

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

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "RBT: allowance");
        allowance[from][msg.sender] -= amount;
        _transfer(from, to, amount);
        return true;
    }

    /// @notice Scales all balances by `newMultiplier / oldMultiplier`.
    /// @dev Test helper: applies the multiplier to the caller's own balance
    ///      only, which is sufficient to model out-of-band balance changes.
    function rebase(uint256 newMultiplier) external {
        require(newMultiplier > 0, "RBT: multiplier");
        uint256 old = multiplier;
        uint256 bal = balanceOf[msg.sender];
        balanceOf[msg.sender] = (bal * newMultiplier) / old;
        multiplier            = newMultiplier;
        emit Rebase(old, newMultiplier);
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "RBT: balance");
        balanceOf[from] -= amount;
        balanceOf[to]   += amount;
        emit Transfer(from, to, amount);
    }
}
