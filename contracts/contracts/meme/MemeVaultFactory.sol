// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {MemeVault, IMemeVenueList} from "./MemeVault.sol";

/// @title MemeVaultFactory
/// @notice Each wallet creates one MemeVault of its own here. The factory keeps two things for them: the
///         operator installed into NEW vaults, and the list of venues a vault's owner may choose from.
///
///         What the admin (a timelock run by a Safe) can and cannot do:
///          - It can list or unlist a venue, and change the operator for vaults created from then on.
///          - It cannot touch an existing vault. A vault's operator, its tokens, its budgets and its money are
///            its owner's alone. Unlisting a venue does not stop a vault that already uses it: its owner
///            removes the token, or keeps trading there.
///          - A newly listed venue is used by a vault only after that vault's owner allows a token on it.
contract MemeVaultFactory is IMemeVenueList {
    address public admin;
    address public pendingAdmin;
    address public defaultOperator;

    mapping(address => bool) public isVenue;
    address[] private _venues;

    mapping(address => address) public vaultOf;
    mapping(address => bool) public isVault;

    event VaultCreated(address indexed owner, address vault);
    event VenueSet(address indexed venue, bool listed);
    event DefaultOperatorChanged(address indexed previous, address indexed current);
    event AdminTransferStarted(address indexed pendingAdmin);
    event AdminTransferred(address indexed admin);

    error NotAdmin();
    error VaultExists(address vault);
    error ZeroAddress();
    error NotAContract(address venue);

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(address operator_, address admin_, address[] memory venues_) {
        if (admin_ == address(0)) revert ZeroAddress();
        admin = admin_;
        defaultOperator = operator_;
        emit DefaultOperatorChanged(address(0), operator_);
        for (uint256 i; i < venues_.length; ++i) _setVenue(venues_[i], true);
    }

    /// @notice Create the caller's vault. `dailyBuyLimitWei` is the most ETH the agent may spend on buys per
    ///         24 hours; the owner can change it later.
    function createVault(uint256 dailyBuyLimitWei) external returns (address vault) {
        address existing = vaultOf[msg.sender];
        if (existing != address(0)) revert VaultExists(existing);
        vault = address(new MemeVault(msg.sender, defaultOperator, dailyBuyLimitWei));
        vaultOf[msg.sender] = vault;
        isVault[vault] = true;
        emit VaultCreated(msg.sender, vault);
    }

    /// @notice List or unlist a venue. Existing vaults are not changed by either.
    function setVenue(address venue, bool listed) external onlyAdmin {
        _setVenue(venue, listed);
    }

    /// @notice Change the operator for vaults created from now on. Existing vaults are not affected.
    function setDefaultOperator(address operator_) external onlyAdmin {
        emit DefaultOperatorChanged(defaultOperator, operator_);
        defaultOperator = operator_;
    }

    /// @notice Every venue that is listed now.
    function venues() external view returns (address[] memory) {
        return _venues;
    }

    function transferAdmin(address next) external onlyAdmin {
        pendingAdmin = next;
        emit AdminTransferStarted(next);
    }

    function acceptAdmin() external {
        if (msg.sender != pendingAdmin) revert NotAdmin();
        admin = pendingAdmin;
        pendingAdmin = address(0);
        emit AdminTransferred(admin);
    }

    function _setVenue(address venue, bool listed) internal {
        if (venue == address(0)) revert ZeroAddress();
        if (listed && venue.code.length == 0) revert NotAContract(venue);
        if (isVenue[venue] != listed) {
            isVenue[venue] = listed;
            if (listed) {
                _venues.push(venue);
            } else {
                uint256 n = _venues.length;
                for (uint256 i; i < n; ++i) {
                    if (_venues[i] == venue) {
                        _venues[i] = _venues[n - 1];
                        _venues.pop();
                        break;
                    }
                }
            }
        }
        emit VenueSet(venue, listed);
    }
}
