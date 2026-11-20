// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AgentVault, IVaultOwnerHook} from "./AgentVault.sol";

/// @title AgentVaultFactory
/// @notice Forked from NOUNY's AgentVaultFactory (MIT). Ratinole changes: the admin is set at deployment (a
///         TimelockController run by a Safe, HANDOFF section 6.2), and `vaultOf` follows a vault when its
///         ownership moves (section 6.1).
/// @notice `vaultOf` is a list for the website, not a record of ownership: who owns a vault is only ever what
///         the vault itself says. Nothing in this factory can stop a vault's owner from using their vault.
/// @notice Each wallet creates one AgentVault of its own. The factory holds the default token list
///         (tokens, Chainlink feeds, staleness limits and pinned pool fee tiers) and the NOUNY operator
///         installed into NEW vaults.
///
///         The token list is fixed at deployment and can never be changed, so the admin cannot point new
///         vaults at a malicious oracle or pool. Only the default operator can be rotated (e.g. after a bot
///         key compromise), and that never affects existing vaults — their owners control their own operator.
contract AgentVaultFactory is IVaultOwnerHook {
    address public immutable router;
    address public admin;
    address public pendingAdmin;
    address public defaultOperator;

    address[] private _tokens;
    address[] private _feeds;
    uint32[] private _staleness;
    uint24[] private _feeTiers;

    mapping(address => address) public vaultOf;
    mapping(address => bool) public isVault;

    event VaultCreated(address indexed owner, address vault);
    event VaultOwnerChanged(address indexed vault, address indexed previousOwner, address indexed newOwner);
    event VaultListed(address indexed owner, address indexed vault);
    event DefaultOperatorChanged(address indexed previous, address indexed current);
    event AdminTransferStarted(address indexed pendingAdmin);
    event AdminTransferred(address indexed admin);

    error NotAdmin();
    error VaultExists(address vault);
    error NotVault();
    error NotVaultOwner();
    error ZeroAddress();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(
        address router_,
        address operator_,
        address[] memory tokens_,
        address[] memory feeds_,
        uint32[] memory staleness_,
        uint24[] memory feeTiers_,
        address admin_
    ) {
        require(
            tokens_.length == feeds_.length && feeds_.length == staleness_.length && staleness_.length == feeTiers_.length,
            "length mismatch"
        );
        require(tokens_.length <= 20, "too many tokens");
        if (router_ == address(0) || admin_ == address(0)) revert ZeroAddress();
        router = router_;
        admin = admin_;
        defaultOperator = operator_;
        _tokens = tokens_;
        _feeds = feeds_;
        _staleness = staleness_;
        _feeTiers = feeTiers_;
        emit DefaultOperatorChanged(address(0), operator_);
    }

    /// @notice Create a vault for the caller. Limits: max slippage (bps) & swap value per 24h (USD, 18 decimals).
    function createVault(uint16 maxSlippageBps, uint256 dailyLimitUsd) external returns (address vault) {
        // One vault per wallet. A listing left behind by a vault that now belongs to someone else does not count.
        address listed = vaultOf[msg.sender];
        if (listed != address(0) && AgentVault(listed).owner() == msg.sender) revert VaultExists(listed);
        vault = address(
            new AgentVault(
                msg.sender, defaultOperator, router, maxSlippageBps, dailyLimitUsd, _tokens, _feeds, _staleness, _feeTiers
            )
        );
        vaultOf[msg.sender] = vault;
        isVault[vault] = true;
        emit VaultCreated(msg.sender, vault);
    }

    /// @notice Called by a vault when its ownership moves. It never refuses: a wallet that already has a vault
    ///         of its own listed keeps that listing, and can list the vault it received with `listVault`.
    function onOwnerChanged(address previousOwner, address newOwner) external {
        if (!isVault[msg.sender]) revert NotVault();
        if (vaultOf[previousOwner] == msg.sender) delete vaultOf[previousOwner];
        address listed = vaultOf[newOwner];
        if (listed == address(0) || AgentVault(listed).owner() != newOwner) vaultOf[newOwner] = msg.sender;
        emit VaultOwnerChanged(msg.sender, previousOwner, newOwner);
    }

    /// @notice List one of the caller's own vaults under their wallet. For a wallet that came to own a second
    ///         vault (by transfer or recovery) and wants the website to show that one.
    function listVault(address vault) external {
        if (!isVault[vault]) revert NotVault();
        if (AgentVault(vault).owner() != msg.sender) revert NotVaultOwner();
        vaultOf[msg.sender] = vault;
        emit VaultListed(msg.sender, vault);
    }

    /// @notice Rotate the operator used for vaults created from now on. Existing vaults are not affected.
    function setDefaultOperator(address operator_) external onlyAdmin {
        emit DefaultOperatorChanged(defaultOperator, operator_);
        defaultOperator = operator_;
    }

    function getDefaults()
        external
        view
        returns (address operator, address[] memory tokens, address[] memory feeds, uint32[] memory staleness, uint24[] memory feeTiers)
    {
        return (defaultOperator, _tokens, _feeds, _staleness, _feeTiers);
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
}
