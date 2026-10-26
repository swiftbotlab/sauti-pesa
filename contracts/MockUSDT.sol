// SPDX-License-Identifier: Apache-2.0
pragma solidity 0.8.28;

/// Test-only USDT look-alike for the local devnet (6 decimals, like USDT). Worthless by design.
/// Only the deployer can mint. Written for this project; no third-party code.
contract MockUSDT {
    string public constant name = "Test Tether USD (devnet)";
    string public constant symbol = "USDT";
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    address public immutable minter;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor() { minter = msg.sender; }

    function mint(address to, uint256 value) external {
        require(msg.sender == minter, "only minter");
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _move(msg.sender, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= value, "allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - value;
        _move(from, to, value);
        return true;
    }

    function _move(address from, address to, uint256 value) internal {
        require(to != address(0), "zero to");
        require(balanceOf[from] >= value, "balance");
        unchecked { balanceOf[from] -= value; }
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}
