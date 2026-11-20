// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Uniswap V3 SwapRouter02 (used on Base, Ethereum, Arbitrum, Robinhood Chain, ...).
interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut);
}

/// @notice Chainlink price feed.
interface AggregatorV3Interface {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @notice Lets a vault tell its factory that its owner changed, so `vaultOf` follows the vault.
interface IVaultOwnerHook {
    function onOwnerChanged(address previousOwner, address newOwner) external;
}

/// @title AgentVault
/// @notice Forked from NOUNY's AgentVault (MIT). Ratinole adds a two-step ownership transfer and an optional
///         recovery wallet with a time delay (HANDOFF section 6.1); everything else is unchanged.
/// @notice Non-custodial vault owned by a single user. The NOUNY agent (operator) may only swap
///         between tokens the owner allows, and swap output always returns to this vault.
///
/// Guarantees for the owner:
///  - The operator can NEVER withdraw or send tokens out of the vault.
///  - The minimum output of every swap is computed on-chain from Chainlink oracles (not by the operator),
///    so the operator cannot sell cheap / get sandwiched beyond `maxSlippageBps`.
///  - Total swap value is capped per 24 hours (`dailyLimitUsd`).
///  - The owner can pause, replace/revoke the operator, and withdraw at any time, even while paused.
///  - Ownership moves only when the new owner accepts it, or when the owner's chosen recovery wallet claims it
///    after a delay the owner set; the owner can cancel a recovery during that delay.
contract AgentVault is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct TokenConfig {
        bool allowed;
        uint8 decimals;
        uint32 maxStaleness; // seconds; oracle prices older than this are rejected
        uint24 feeTier; // Uniswap pool fee for pairs with this token (0 = base token, e.g. the stablecoin)
        AggregatorV3Interface feed; // feed TOKEN/USD
    }

    uint16 public constant MAX_SLIPPAGE_CAP_BPS = 500; // hard cap 5%
    uint256 public constant WINDOW = 1 days;
    uint32 public constant MIN_RECOVERY_DELAY = 2 days;
    uint32 public constant MAX_RECOVERY_DELAY = 90 days;

    ISwapRouter02 public immutable router;
    /// @notice The factory that created this vault (told about owner changes), or the deployer.
    address public immutable factory;

    address public owner;
    address public pendingOwner;
    address public recovery; // optional; may claim ownership after `recoveryDelay`
    uint32 public recoveryDelay;
    uint64 public recoveryReadyAt; // 0 = no recovery in progress

    address public operator;
    bool public paused;
    uint16 public maxSlippageBps;
    uint256 public dailyLimitUsd; // 18 decimals
    uint256 public windowStart;
    uint256 public usedInWindowUsd; // 18 decimals

    mapping(address => TokenConfig) public tokens;
    address[] private tokenList;

    event TokenSet(address indexed token, address feed, uint32 maxStaleness, uint24 feeTier);
    event TokenRemoved(address indexed token);
    event OperatorChanged(address indexed previous, address indexed current);
    event LimitsChanged(uint16 maxSlippageBps, uint256 dailyLimitUsd);
    event PausedChanged(bool paused);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event OwnershipTransferStarted(address indexed currentOwner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event RecoverySet(address indexed recovery, uint32 delay);
    event RecoveryStarted(address indexed recovery, uint64 readyAt);
    event RecoveryCancelled();
    event Swapped(
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 valueUsd,
        uint256 minOutEnforced
    );

    error NotOwner();
    error NotOperator();
    error Paused();
    error TokenNotAllowed(address token);
    error SameToken();
    error ZeroAmount();
    error ZeroAddress();
    error BadFeeTier();
    error SlippageTooHigh();
    error DailyLimitExceeded(uint256 requestedUsd, uint256 remainingUsd);
    error BadOraclePrice(address token);
    error StaleOraclePrice(address token);
    error InsufficientOutput(uint256 received, uint256 minimum);
    error TooManyTokens();
    error PairNotAllowed();
    error NotPendingOwner();
    error NotRecovery();
    error BadRecoveryDelay();
    error RecoveryNotReady(uint64 readyAt);
    error BadRecoveryWallet();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(
        address owner_,
        address operator_,
        address router_,
        uint16 maxSlippageBps_,
        uint256 dailyLimitUsd_,
        address[] memory tokens_,
        address[] memory feeds_,
        uint32[] memory staleness_,
        uint24[] memory feeTiers_
    ) {
        if (owner_ == address(0) || router_ == address(0)) revert ZeroAddress();
        owner = owner_;
        factory = msg.sender;
        router = ISwapRouter02(router_);
        operator = operator_;
        _setLimits(maxSlippageBps_, dailyLimitUsd_);
        require(
            tokens_.length == feeds_.length && feeds_.length == staleness_.length && staleness_.length == feeTiers_.length,
            "length mismatch"
        );
        for (uint256 i; i < tokens_.length; ++i) _setToken(tokens_[i], feeds_[i], staleness_[i], feeTiers_[i]);
        emit OperatorChanged(address(0), operator_);
        emit OwnershipTransferred(address(0), owner_);
    }

    // ---------------------------------------------------------------- owner

    /// @notice Add or update a tradable token. `feeTier` pins the Uniswap pool used for pairs with this
    ///         token (0 for the base token); the operator cannot pick another pool.
    function setToken(address token, address feed, uint32 maxStaleness, uint24 feeTier) external onlyOwner {
        _setToken(token, feed, maxStaleness, feeTier);
    }

    function removeToken(address token) external onlyOwner {
        if (!tokens[token].allowed) revert TokenNotAllowed(token);
        delete tokens[token];
        for (uint256 i; i < tokenList.length; ++i) {
            if (tokenList[i] == token) {
                tokenList[i] = tokenList[tokenList.length - 1];
                tokenList.pop();
                break;
            }
        }
        emit TokenRemoved(token);
    }

    /// @notice Change the operator. `address(0)` = fully revoke agent access.
    function setOperator(address newOperator) external onlyOwner {
        emit OperatorChanged(operator, newOperator);
        operator = newOperator;
    }

    function setLimits(uint16 maxSlippageBps_, uint256 dailyLimitUsd_) external onlyOwner {
        _setLimits(maxSlippageBps_, dailyLimitUsd_);
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedChanged(paused_);
    }

    /// @notice Withdraw tokens at any time (also while paused). Owner only.
    function withdraw(address token, uint256 amount, address to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
        emit Withdrawn(token, to, amount);
    }

    // ---------------------------------------------------------------- ownership and recovery

    /// @notice Start handing the vault to `next`, who must call `acceptOwnership`. `address(0)` cancels.
    function transferOwnership(address next) external onlyOwner {
        pendingOwner = next;
        emit OwnershipTransferStarted(owner, next);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner || msg.sender == address(0)) revert NotPendingOwner();
        _setOwner(msg.sender);
    }

    /// @notice Choose a wallet that can claim the vault if the owner key is lost, after `delay` seconds.
    ///         `address(0)` turns recovery off. Any recovery in progress is cancelled.
    function setRecovery(address wallet, uint32 delay) external onlyOwner {
        if (wallet != address(0) && (delay < MIN_RECOVERY_DELAY || delay > MAX_RECOVERY_DELAY)) revert BadRecoveryDelay();
        if (wallet == owner) revert BadRecoveryWallet();
        recovery = wallet;
        recoveryDelay = wallet == address(0) ? 0 : delay;
        recoveryReadyAt = 0;
        emit RecoverySet(wallet, recoveryDelay);
    }

    /// @notice The recovery wallet starts its claim; it can complete it once the delay has passed.
    function startRecovery() external {
        if (msg.sender != recovery || recovery == address(0)) revert NotRecovery();
        recoveryReadyAt = uint64(block.timestamp) + recoveryDelay;
        emit RecoveryStarted(msg.sender, recoveryReadyAt);
    }

    /// @notice The owner stops a recovery claim during the delay.
    function cancelRecovery() external onlyOwner {
        recoveryReadyAt = 0;
        emit RecoveryCancelled();
    }

    function completeRecovery() external {
        if (msg.sender != recovery || recovery == address(0)) revert NotRecovery();
        uint64 readyAt = recoveryReadyAt;
        if (readyAt == 0 || block.timestamp < readyAt) revert RecoveryNotReady(readyAt);
        _setOwner(msg.sender);
    }

    // ---------------------------------------------------------------- operator (agent)

    /// @notice Single-hop swap through Uniswap V3. Output is always sent to this vault.
    /// @param feeTier must equal the pool fee pinned for this pair (the higher of the two tokens' tiers),
    ///        so a compromised operator cannot route through a thin or expensive pool.
    /// @param minOutFromOperator the operator's minimum; the contract uses the STRICTER of this
    ///        value and the oracle-based minimum.
    function swap(address tokenIn, address tokenOut, uint24 feeTier, uint256 amountIn, uint256 minOutFromOperator)
        external
        nonReentrant
        returns (uint256 amountOut)
    {
        if (msg.sender != operator || operator == address(0)) revert NotOperator();
        if (paused) revert Paused();
        if (tokenIn == tokenOut) revert SameToken();
        if (amountIn == 0) revert ZeroAmount();
        TokenConfig memory cin = tokens[tokenIn];
        TokenConfig memory cout = tokens[tokenOut];
        if (!cin.allowed) revert TokenNotAllowed(tokenIn);
        if (!cout.allowed) revert TokenNotAllowed(tokenOut);
        // Every swap is against the base token (fee tier 0, the stablecoin), so it always uses the pinned
        // <token>/<base> pool. Token-to-token pairs often have no pool at the pinned tier, and a compromised
        // operator could create a thin one to route through (review I-1).
        if (cin.feeTier != 0 && cout.feeTier != 0) revert PairNotAllowed();
        uint24 pinned = cin.feeTier > cout.feeTier ? cin.feeTier : cout.feeTier;
        if (pinned == 0 || feeTier != pinned) revert BadFeeTier();

        // USD value (18 decimals) & daily limit
        uint256 priceIn = _price(tokenIn, cin);
        uint256 priceOut = _price(tokenOut, cout);
        uint256 valueUsd = (amountIn * priceIn) / (10 ** cin.decimals);
        _consumeDaily(valueUsd);

        // oracle-based minimum output
        uint256 expectedOut = (valueUsd * (10 ** cout.decimals)) / priceOut;
        uint256 minOut = (expectedOut * (10_000 - maxSlippageBps)) / 10_000;
        if (minOutFromOperator > minOut) minOut = minOutFromOperator;

        uint256 before = IERC20(tokenOut).balanceOf(address(this));
        IERC20(tokenIn).forceApprove(address(router), amountIn);
        router.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: feeTier,
                recipient: address(this),
                amountIn: amountIn,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        );
        IERC20(tokenIn).forceApprove(address(router), 0);

        // check the real balance, not the amount the router reports
        amountOut = IERC20(tokenOut).balanceOf(address(this)) - before;
        if (amountOut < minOut) revert InsufficientOutput(amountOut, minOut);

        emit Swapped(tokenIn, tokenOut, amountIn, amountOut, valueUsd, minOut);
    }

    // ---------------------------------------------------------------- views

    function allowedTokens() external view returns (address[] memory) {
        return tokenList;
    }

    /// @notice Remaining daily limit (USD, 18 decimals).
    function remainingDailyUsd() external view returns (uint256) {
        if (block.timestamp >= windowStart + WINDOW) return dailyLimitUsd;
        return dailyLimitUsd > usedInWindowUsd ? dailyLimitUsd - usedInWindowUsd : 0;
    }

    /// @notice Token price in USD (18 decimals) according to the oracle.
    function priceUsd(address token) external view returns (uint256) {
        TokenConfig memory c = tokens[token];
        if (!c.allowed) revert TokenNotAllowed(token);
        return _price(token, c);
    }

    // ---------------------------------------------------------------- internal

    /// @dev A new owner starts clean: no pending transfer and no recovery wallet from the previous owner.
    function _setOwner(address next) internal {
        address previous = owner;
        owner = next;
        pendingOwner = address(0);
        recovery = address(0);
        recoveryDelay = 0;
        recoveryReadyAt = 0;
        emit OwnershipTransferred(previous, next);
        if (factory.code.length > 0) IVaultOwnerHook(factory).onOwnerChanged(previous, next);
    }

    function _setToken(address token, address feed, uint32 maxStaleness, uint24 feeTier) internal {
        if (token == address(0) || feed == address(0)) revert ZeroAddress();
        if (feeTier != 0 && feeTier != 100 && feeTier != 500 && feeTier != 3000 && feeTier != 10000) revert BadFeeTier();
        if (!tokens[token].allowed) {
            if (tokenList.length >= 20) revert TooManyTokens();
            tokenList.push(token);
        }
        tokens[token] = TokenConfig({
            allowed: true,
            decimals: IERC20Metadata(token).decimals(),
            maxStaleness: maxStaleness,
            feeTier: feeTier,
            feed: AggregatorV3Interface(feed)
        });
        // The feed must answer when the token is registered, but its price need not be fresh: stock feeds pause
        // for ~2 days every weekend, and freshness is enforced on every swap anyway (review L-1).
        (, int256 answer,,,) = AggregatorV3Interface(feed).latestRoundData();
        if (answer <= 0 || AggregatorV3Interface(feed).decimals() > 36) revert BadOraclePrice(token);
        emit TokenSet(token, feed, maxStaleness, feeTier);
    }

    function _setLimits(uint16 maxSlippageBps_, uint256 dailyLimitUsd_) internal {
        if (maxSlippageBps_ > MAX_SLIPPAGE_CAP_BPS) revert SlippageTooHigh();
        maxSlippageBps = maxSlippageBps_;
        dailyLimitUsd = dailyLimitUsd_;
        emit LimitsChanged(maxSlippageBps_, dailyLimitUsd_);
    }

    function _price(address token, TokenConfig memory c) internal view returns (uint256) {
        (, int256 answer,, uint256 updatedAt,) = c.feed.latestRoundData();
        if (answer <= 0) revert BadOraclePrice(token);
        if (updatedAt > block.timestamp || block.timestamp - updatedAt > c.maxStaleness) revert StaleOraclePrice(token);
        uint8 d = c.feed.decimals();
        return d <= 18 ? uint256(answer) * 10 ** (18 - d) : uint256(answer) / 10 ** (d - 18);
    }

    function _consumeDaily(uint256 valueUsd) internal {
        if (block.timestamp >= windowStart + WINDOW) {
            windowStart = block.timestamp;
            usedInWindowUsd = 0;
        }
        uint256 remaining = dailyLimitUsd > usedInWindowUsd ? dailyLimitUsd - usedInWindowUsd : 0;
        if (valueUsd > remaining) revert DailyLimitExceeded(valueUsd, remaining);
        usedInWindowUsd += valueUsd;
    }
}
