// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IMemeVenue} from "./IMemeVenue.sol";

/// @notice What a meme vault asks its factory: is this venue one the factory's admin has listed?
interface IMemeVenueList {
    function isVenue(address venue) external view returns (bool);
}

/// @title MemeVault
/// @notice A vault for trading launchpad tokens ("meme coins") against ETH. It belongs to one wallet, for good.
///         The agent (operator) can buy and sell only the tokens the owner has allowed, only through the venue
///         the owner allowed each one on, and only within the amounts the owner set.
///
/// What the owner can count on:
///  - The operator can NEVER withdraw. Nothing it can call sends ETH or tokens anywhere but into a trade whose
///    result comes back to this vault.
///  - The operator can spend, on each token, at most the budget the owner gave that token, and across all
///    tokens at most `dailyBuyLimitWei` per 24-hour window (fixed windows, not rolling).
///  - The owner can withdraw everything, pause, change or remove the operator, and remove a token, at any time.
///    Withdrawing works while paused.
///
/// What this vault does NOT promise, and the older AgentVault does:
///  - There is no price oracle for these tokens, so the vault cannot check on its own that a price is fair. The
///    least a trade must return is set by the operator. A stolen operator key could therefore trade badly on
///    purpose, and lose up to the budgets the owner set. Budgets are the limit of that loss; set them with that
///    in mind.
///  - Tokens of this kind can lose all their value, and a token's own market can stop working. The vault cannot
///    protect against a bad token: the owner chooses which tokens to allow.
///  - The owner cannot be changed. There is no hand-over and no recovery wallet: keep the wallet safe, or
///    withdraw to another one.
contract MemeVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct TokenRule {
        address venue; // where this token is traded; zero = not allowed
        uint256 budgetLeftWei; // ETH the operator may still spend buying it
    }

    uint256 public constant WINDOW = 1 days;
    uint256 public constant MAX_TOKENS = 50;

    address public immutable owner;
    /// @notice The factory that created this vault. Its list says which venues may be chosen.
    address public immutable factory;

    address public operator;
    bool public paused;
    uint256 public dailyBuyLimitWei;
    uint256 public windowStart;
    uint256 public usedInWindowWei;

    mapping(address => TokenRule) public rules;
    address[] private tokenList;

    event TokenAllowed(address indexed token, address indexed venue, uint256 budgetWei);
    event TokenRemoved(address indexed token);
    event OperatorChanged(address indexed previous, address indexed current);
    event DailyBuyLimitChanged(uint256 dailyBuyLimitWei);
    event PausedChanged(bool paused);
    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event Bought(address indexed token, address indexed venue, uint256 ethSpent, uint256 tokensOut);
    event Sold(address indexed token, address indexed venue, uint256 tokensIn, uint256 ethOut);

    error NotOwner();
    error NotOperator();
    error Paused();
    error ZeroAddress();
    error ZeroAmount();
    error OrderExpired(uint256 deadline);
    error TokenNotAllowed(address token);
    error VenueNotListed(address venue);
    error VenueDoesNotSupport(address token);
    error TooManyTokens();
    error BudgetExceeded(uint256 requestedWei, uint256 leftWei);
    error DailyLimitExceeded(uint256 requestedWei, uint256 remainingWei);
    error NothingBought();
    error NothingSold();
    error InsufficientOutput(uint256 received, uint256 minimum);
    error VenueTookTooMuch();
    error EthTransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address owner_, address operator_, uint256 dailyBuyLimitWei_) {
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_;
        factory = msg.sender;
        operator = operator_;
        dailyBuyLimitWei = dailyBuyLimitWei_;
        emit OperatorChanged(address(0), operator_);
        emit DailyBuyLimitChanged(dailyBuyLimitWei_);
    }

    /// @notice ETH comes in three ways: the owner's deposits, the proceeds of a sale, and ETH a buy did not use.
    receive() external payable {
        emit Deposited(msg.sender, msg.value);
    }

    // ---------------------------------------------------------------- owner

    /// @notice Allow the agent to trade `token` on `venue`, and set how much ETH it may still spend buying it.
    ///         Calling it again for the same token replaces both. A budget of zero lets the agent sell what the
    ///         vault holds but buy no more.
    function allowToken(address token, address venue, uint256 budgetWei) external onlyOwner {
        if (token == address(0) || venue == address(0)) revert ZeroAddress();
        if (!IMemeVenueList(factory).isVenue(venue)) revert VenueNotListed(venue);
        if (!IMemeVenue(venue).isListed(token)) revert VenueDoesNotSupport(token);
        if (rules[token].venue == address(0)) {
            if (tokenList.length >= MAX_TOKENS) revert TooManyTokens();
            tokenList.push(token);
        }
        rules[token] = TokenRule({venue: venue, budgetLeftWei: budgetWei});
        emit TokenAllowed(token, venue, budgetWei);
    }

    /// @notice Stop the agent trading `token` altogether. Tokens the vault holds stay in it until withdrawn.
    function removeToken(address token) external onlyOwner {
        if (rules[token].venue == address(0)) revert TokenNotAllowed(token);
        delete rules[token];
        uint256 n = tokenList.length;
        for (uint256 i; i < n; ++i) {
            if (tokenList[i] == token) {
                tokenList[i] = tokenList[n - 1];
                tokenList.pop();
                break;
            }
        }
        emit TokenRemoved(token);
    }

    /// @notice Change the operator. `address(0)` switches the agent off entirely.
    function setOperator(address newOperator) external onlyOwner {
        emit OperatorChanged(operator, newOperator);
        operator = newOperator;
    }

    function setDailyBuyLimit(uint256 dailyBuyLimitWei_) external onlyOwner {
        dailyBuyLimitWei = dailyBuyLimitWei_;
        emit DailyBuyLimitChanged(dailyBuyLimitWei_);
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedChanged(paused_);
    }

    /// @notice Withdraw ETH (`token` = zero address) or any token, at any time, also while paused. Owner only.
    function withdraw(address token, uint256 amount, address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (token == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert EthTransferFailed();
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
        emit Withdrawn(token, to, amount);
    }

    // ---------------------------------------------------------------- operator (the agent)

    /// @notice Buy `token` with up to `ethIn` of the vault's ETH, on the venue the owner allowed it on.
    /// @param minTokensOut the least accepted for the whole of `ethIn`. If the venue can only spend part of
    ///        it (a launch about to sell out), the same price per token must still be met.
    /// @param deadline the order is refused after this time (unix seconds), so that one left unsent can never
    ///        go through later at a time nobody chose.
    function buy(address token, uint256 ethIn, uint256 minTokensOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 tokensOut, uint256 ethSpent)
    {
        TokenRule storage rule = _checkOrder(token, deadline);
        if (ethIn == 0 || minTokensOut == 0) revert ZeroAmount();
        if (ethIn > rule.budgetLeftWei) revert BudgetExceeded(ethIn, rule.budgetLeftWei);
        uint256 remaining = remainingDailyWei();
        if (ethIn > remaining) revert DailyLimitExceeded(ethIn, remaining);

        address venue = rule.venue;
        uint256 ethBefore = address(this).balance;
        uint256 tokensBefore = IERC20(token).balanceOf(address(this));
        IMemeVenue(venue).buy{value: ethIn}(token, minTokensOut);
        uint256 ethAfter = address(this).balance;

        // Measured here, not taken from what the venue reports.
        ethSpent = ethBefore > ethAfter ? ethBefore - ethAfter : 0;
        tokensOut = IERC20(token).balanceOf(address(this)) - tokensBefore;
        if (tokensOut == 0 || ethSpent == 0) revert NothingBought();
        // The price asked for, held to for the part that was filled: tokensOut / ethSpent >= minTokensOut / ethIn.
        if (tokensOut * ethIn < minTokensOut * ethSpent) revert InsufficientOutput(tokensOut, minTokensOut);

        rule.budgetLeftWei -= ethSpent;
        _consumeDaily(ethSpent);
        emit Bought(token, venue, ethSpent, tokensOut);
    }

    /// @notice Sell `amount` of `token` for ETH, on the venue the owner allowed it on. The ETH stays in the vault.
    function sell(address token, uint256 amount, uint256 minEthOut, uint256 deadline)
        external
        nonReentrant
        returns (uint256 ethOut)
    {
        TokenRule storage rule = _checkOrder(token, deadline);
        if (amount == 0 || minEthOut == 0) revert ZeroAmount();

        address venue = rule.venue;
        uint256 ethBefore = address(this).balance;
        uint256 tokensBefore = IERC20(token).balanceOf(address(this));
        IERC20(token).forceApprove(venue, amount);
        IMemeVenue(venue).sell(token, amount, minEthOut);
        IERC20(token).forceApprove(venue, 0);

        uint256 tokensAfter = IERC20(token).balanceOf(address(this));
        uint256 sold = tokensBefore > tokensAfter ? tokensBefore - tokensAfter : 0;
        if (sold > amount) revert VenueTookTooMuch();
        ethOut = address(this).balance - ethBefore;
        if (sold == 0 || ethOut == 0) revert NothingSold();
        // As for a buy: the price asked for holds for whatever part was sold.
        if (ethOut * amount < minEthOut * sold) revert InsufficientOutput(ethOut, minEthOut);

        emit Sold(token, venue, sold, ethOut);
    }

    // ---------------------------------------------------------------- views

    function allowedTokens() external view returns (address[] memory) {
        return tokenList;
    }

    /// @notice ETH the agent may still spend on buys in the current 24-hour window.
    function remainingDailyWei() public view returns (uint256) {
        if (block.timestamp >= windowStart + WINDOW) return dailyBuyLimitWei;
        return dailyBuyLimitWei > usedInWindowWei ? dailyBuyLimitWei - usedInWindowWei : 0;
    }

    // ---------------------------------------------------------------- internal

    function _checkOrder(address token, uint256 deadline) internal view returns (TokenRule storage rule) {
        if (msg.sender != operator || operator == address(0)) revert NotOperator();
        if (block.timestamp > deadline) revert OrderExpired(deadline);
        if (paused) revert Paused();
        rule = rules[token];
        if (rule.venue == address(0)) revert TokenNotAllowed(token);
    }

    function _consumeDaily(uint256 spentWei) internal {
        if (block.timestamp >= windowStart + WINDOW) {
            windowStart = block.timestamp;
            usedInWindowWei = 0;
        }
        usedInWindowWei += spentWei;
    }
}
