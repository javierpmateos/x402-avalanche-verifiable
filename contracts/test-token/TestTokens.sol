// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// Minimal EIP-3009 token for local tests. Not for production.
contract TestUSDC {
    string public name = "USDC";
    string public version = "2";
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(bytes32 => bool)) private _authorizationStates;

    bytes32 public constant TRANSFER_WITH_AUTHORIZATION_TYPEHASH =
        keccak256("TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)");

    event Transfer(address indexed from, address indexed to, uint256 value);
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);

    function mint(address to, uint256 value) external { balanceOf[to] += value; emit Transfer(address(0), to, value); }

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(abi.encode(
            keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak256(bytes(name)), keccak256(bytes(version)), block.chainid, address(this)));
    }

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool) {
        return _authorizationStates[authorizer][nonce];
    }

    function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter,
        uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) public {
        require(block.timestamp > validAfter, "not yet valid");
        require(block.timestamp < validBefore, "expired");
        require(!_authorizationStates[from][nonce], "authorization is used");
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), keccak256(abi.encode(
            TRANSFER_WITH_AUTHORIZATION_TYPEHASH, from, to, value, validAfter, validBefore, nonce))));
        address signer = ecrecover(digest, v, r, s);
        require(signer != address(0) && signer == from, "invalid signature");
        _authorizationStates[from][nonce] = true;
        emit AuthorizationUsed(from, nonce);
        require(balanceOf[from] >= value, "balance");
        balanceOf[from] -= value; balanceOf[to] += value;
        emit Transfer(from, to, value);
    }

    function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter,
        uint256 validBefore, bytes32 nonce, bytes memory signature) external {
        require(signature.length == 65, "sig length");
        bytes32 r; bytes32 s; uint8 v;
        assembly { r := mload(add(signature, 32)) s := mload(add(signature, 64)) v := byte(0, mload(add(signature, 96))) }
        transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, v, r, s);
    }
}

/// tryAggregate subset of Multicall3.
contract MiniMulticall3 {
    struct Call { address target; bytes callData; }
    struct Result { bool success; bytes returnData; }
    function tryAggregate(bool requireSuccess, Call[] calldata calls) external payable returns (Result[] memory returnData) {
        returnData = new Result[](calls.length);
        for (uint256 i = 0; i < calls.length; i++) {
            (bool ok, bytes memory ret) = calls[i].target.call(calls[i].callData);
            if (requireSuccess) require(ok, "call failed");
            returnData[i] = Result(ok, ret);
        }
    }
    function getEthBalance(address addr) external view returns (uint256) { return addr.balance; }
}
