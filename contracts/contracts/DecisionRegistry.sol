// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @title DecisionRegistry
/// @notice Each hour the Ratinole engine posts one Merkle root over every decision its agents made that hour
///         (HANDOFF section 6.3). Anyone can then check that a decision shown on the site is the one that was
///         recorded: rebuild its leaf, take the proof from the API, and call `verify`.
///
///         Leaf (OpenZeppelin standard, double hashed):
///           keccak256(bytes.concat(keccak256(abi.encode(decisionId, agentId, hour, contentHash))))
///         with `decisionId` and `agentId` as bytes32 and `contentHash` the keccak256 of the stored decision.
///         Pairs are hashed sorted, as `MerkleProof` expects.
///
///         A posted root can never be changed or removed. The poster (the engine's key) can only add roots for
///         hours that have passed; the admin (a TimelockController run by a Safe) can only rotate the poster.
contract DecisionRegistry {
    struct Entry {
        bytes32 root;
        uint32 count;
        uint64 postedAt;
    }

    address public admin;
    address public pendingAdmin;
    address public poster;
    uint64 public lastHour;
    mapping(uint64 => Entry) public entries; // hour (unix seconds, a multiple of 3600) => root

    event RootPosted(uint64 indexed hour, bytes32 root, uint32 count);
    event PosterChanged(address indexed previous, address indexed current);
    event AdminTransferStarted(address indexed pendingAdmin);
    event AdminTransferred(address indexed admin);

    error NotAdmin();
    error NotPoster();
    error ZeroAddress();
    error BadHour(uint64 hour);
    error AlreadyPosted(uint64 hour);
    error EmptyRoot();

    constructor(address admin_, address poster_) {
        if (admin_ == address(0) || poster_ == address(0)) revert ZeroAddress();
        admin = admin_;
        poster = poster_;
        emit AdminTransferred(admin_);
        emit PosterChanged(address(0), poster_);
    }

    /// @notice Record the root for `hour`. Hours must be on the hour and not in the future; each only once.
    function post(uint64 hour, bytes32 root, uint32 count) external {
        if (msg.sender != poster) revert NotPoster();
        if (hour % 1 hours != 0 || hour > block.timestamp) revert BadHour(hour);
        if (root == bytes32(0) || count == 0) revert EmptyRoot();
        if (entries[hour].postedAt != 0) revert AlreadyPosted(hour);
        entries[hour] = Entry({root: root, count: count, postedAt: uint64(block.timestamp)});
        if (hour > lastHour) lastHour = hour;
        emit RootPosted(hour, root, count);
    }

    /// @notice True when `leaf` is part of the root posted for `hour`.
    function verify(uint64 hour, bytes32 leaf, bytes32[] calldata proof) external view returns (bool) {
        bytes32 root = entries[hour].root;
        return root != bytes32(0) && MerkleProof.verifyCalldata(proof, root, leaf);
    }

    function setPoster(address next) external {
        if (msg.sender != admin) revert NotAdmin();
        if (next == address(0)) revert ZeroAddress();
        emit PosterChanged(poster, next);
        poster = next;
    }

    function transferAdmin(address next) external {
        if (msg.sender != admin) revert NotAdmin();
        pendingAdmin = next;
        emit AdminTransferStarted(next);
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin || msg.sender == address(0)) revert NotAdmin();
        admin = msg.sender;
        pendingAdmin = address(0);
        emit AdminTransferred(msg.sender);
    }
}
