// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IMemeVenue} from "./IMemeVenue.sol";

/// @notice The pons v2 launch factory (docs.ponsfamily.com/v2). One record per launch.
interface IPonsFactory {
    struct LaunchedToken {
        address token;
        address curve;
        address deployer;
        address creatorFeeRecipient;
        address pairToken; // zero = priced in native ETH
        uint256 graduationThreshold;
        uint24 poolFee;
        int24 tickSpacing;
        uint16 creatorTaxBps;
        bool buybackEnabled;
        uint8 phase; // 0 NotGraduated, 1 Swept, 2 PoolCreated, 3 Rescued
        uint256 sweptQuote;
        uint256 sweptTokens;
        uint256 sweptAt;
        bool exists;
    }

    function getLaunchedToken(address token) external view returns (LaunchedToken memory);
    /// @notice Moves a launch whose curve has sold out into its pool. Anyone may call it.
    function createGraduatedPool(address token) external;
}

/// @notice A launch's bonding curve. For a launch priced in ETH, `quoteIn` must equal the value sent.
interface IPonsCurve {
    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) external payable returns (uint256 tokensOut);
    function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) external returns (uint256 quoteOut);
}

/// @notice The parts of the Uniswap v4 PoolManager a swap needs.
interface IPoolManager {
    struct PoolKey {
        address currency0; // zero = native ETH
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    struct SwapParams {
        bool zeroForOne;
        int256 amountSpecified; // negative = exactly this much goes in
        uint160 sqrtPriceLimitX96;
    }

    function unlock(bytes calldata data) external returns (bytes memory);
    /// @return delta amount0 in the upper 128 bits, amount1 in the lower; negative = owed to the pool.
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256 delta);
    function sync(address currency) external;
    function settle() external payable returns (uint256 paid);
    function take(address currency, address to, uint256 amount) external;
}

/// @title PonsVenue
/// @notice Trades pons v2 launches against ETH, wherever the launch is in its life: on its bonding curve
///         before it graduates, and in its Uniswap v4 pool afterwards. A vault using this venue does not have
///         to do anything when a token graduates.
///
///         Nothing here is chosen by the caller except the token and the amounts. Which curve and which pool a
///         token trades in is read from the pons factory's own record of the launch, so a caller cannot be
///         sent through a look-alike market. The venue keeps no ETH and no tokens between calls, and one call
///         cannot run inside another.
///
///         It only knows launches priced in native ETH. Launches priced in another token are not supported.
contract PonsVenue is IMemeVenue, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint8 private constant PHASE_CURVE = 0;
    uint8 private constant PHASE_SWEPT = 1;
    uint8 private constant PHASE_POOL = 2;
    /// @dev The price limits of a Uniswap pool, one step inside: "swap as far as the amount goes".
    uint160 private constant MIN_SQRT_PRICE_LIMIT = 4295128739 + 1;
    uint160 private constant MAX_SQRT_PRICE_LIMIT = 1461446703485210103287273052203988822378723970342 - 1;

    IPonsFactory public immutable ponsFactory;
    IPoolManager public immutable poolManager;
    /// @notice The pons hook every graduated pool of this factory is created with.
    address public immutable hook;

    error NotSupported(address token);
    error NotTradable(address token, uint8 phase);
    error NotPoolManager();
    error InsufficientOutput(uint256 received, uint256 minimum);
    error EthTransferFailed();
    error ZeroAddress();

    constructor(address ponsFactory_, address poolManager_, address hook_) {
        if (ponsFactory_ == address(0) || poolManager_ == address(0) || hook_ == address(0)) revert ZeroAddress();
        ponsFactory = IPonsFactory(ponsFactory_);
        poolManager = IPoolManager(poolManager_);
        hook = hook_;
    }

    /// @dev ETH arrives here from the curve (the part of a buy it did not use) and from nowhere else that
    ///      matters: whatever is here at the end of a call goes back to that call's sender.
    receive() external payable {}

    // ---------------------------------------------------------------- IMemeVenue

    function isListed(address token) public view returns (bool) {
        IPonsFactory.LaunchedToken memory launch = ponsFactory.getLaunchedToken(token);
        return launch.exists && launch.token == token && launch.pairToken == address(0) && launch.curve != address(0);
    }

    function buy(address token, uint256 minTokensOut) external payable nonReentrant returns (uint256 tokensOut) {
        IPonsFactory.LaunchedToken memory launch = _tradable(token);
        if (launch.phase == PHASE_CURVE) {
            // The curve fills what it still has to sell and returns the rest of the ETH here. It holds the
            // price to `minTokensOut` for the part it fills.
            tokensOut = IPonsCurve(launch.curve).buy{value: msg.value}(msg.value, minTokensOut, msg.sender);
        } else {
            tokensOut = abi.decode(
                poolManager.unlock(abi.encode(true, token, launch.tickSpacing, launch.poolFee, msg.value, msg.sender)), (uint256)
            );
            if (tokensOut < minTokensOut) revert InsufficientOutput(tokensOut, minTokensOut);
        }
        _refund(msg.sender);
    }

    function sell(address token, uint256 amount, uint256 minEthOut) external nonReentrant returns (uint256 ethOut) {
        IPonsFactory.LaunchedToken memory launch = _tradable(token);
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        if (launch.phase == PHASE_CURVE) {
            IERC20(token).forceApprove(launch.curve, amount);
            ethOut = IPonsCurve(launch.curve).sell(amount, minEthOut, msg.sender);
            IERC20(token).forceApprove(launch.curve, 0);
        } else {
            ethOut = abi.decode(
                poolManager.unlock(abi.encode(false, token, launch.tickSpacing, launch.poolFee, amount, msg.sender)), (uint256)
            );
            if (ethOut < minEthOut) revert InsufficientOutput(ethOut, minEthOut);
        }
        // Tokens a market did not take go back, so that nothing is ever left here.
        uint256 left = IERC20(token).balanceOf(address(this));
        if (left > 0) IERC20(token).safeTransfer(msg.sender, left);
        _refund(msg.sender);
    }

    // ---------------------------------------------------------------- Uniswap v4

    /// @notice Called by the PoolManager in the middle of `unlock`. The swap, the payment and the collection
    ///         all happen here, and the PoolManager refuses to finish unless they balance.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (bool isBuy, address token, int24 tickSpacing, uint24 fee, uint256 amountIn, address recipient) =
            abi.decode(data, (bool, address, int24, uint24, uint256, address));

        // Native ETH is the zero address, so it is always currency0 and the launch token currency1.
        IPoolManager.PoolKey memory key =
            IPoolManager.PoolKey({currency0: address(0), currency1: token, fee: fee, tickSpacing: tickSpacing, hooks: hook});
        int256 delta = poolManager.swap(
            key,
            IPoolManager.SwapParams({
                zeroForOne: isBuy,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: isBuy ? MIN_SQRT_PRICE_LIMIT : MAX_SQRT_PRICE_LIMIT
            }),
            ""
        );
        int128 ethDelta = int128(delta >> 128);
        int128 tokenDelta = int128(delta);

        uint256 out;
        if (isBuy) {
            // ETH is owed to the pool, tokens are owed to the buyer.
            if (ethDelta > 0 || tokenDelta < 0) revert NotTradable(token, PHASE_POOL);
            poolManager.settle{value: uint256(uint128(-ethDelta))}();
            out = uint256(uint128(tokenDelta));
            if (out > 0) poolManager.take(token, recipient, out);
        } else {
            if (tokenDelta > 0 || ethDelta < 0) revert NotTradable(token, PHASE_POOL);
            poolManager.sync(token);
            IERC20(token).safeTransfer(address(poolManager), uint256(uint128(-tokenDelta)));
            poolManager.settle();
            out = uint256(uint128(ethDelta));
            if (out > 0) poolManager.take(address(0), recipient, out);
        }
        return abi.encode(out);
    }

    // ---------------------------------------------------------------- internal

    /// @dev The launch's record, with the launch somewhere it can be traded. A launch whose curve has sold out
    ///      but whose pool does not exist yet is pushed into its pool first: anyone may do that.
    function _tradable(address token) internal returns (IPonsFactory.LaunchedToken memory launch) {
        launch = ponsFactory.getLaunchedToken(token);
        if (!launch.exists || launch.token != token || launch.pairToken != address(0) || launch.curve == address(0)) {
            revert NotSupported(token);
        }
        if (launch.phase == PHASE_SWEPT) {
            try ponsFactory.createGraduatedPool(token) {} catch {}
            launch = ponsFactory.getLaunchedToken(token);
        }
        if (launch.phase != PHASE_CURVE && launch.phase != PHASE_POOL) revert NotTradable(token, launch.phase);
    }

    function _refund(address to) internal {
        uint256 left = address(this).balance;
        if (left > 0) {
            (bool ok,) = to.call{value: left}("");
            if (!ok) revert EthTransferFailed();
        }
    }
}
