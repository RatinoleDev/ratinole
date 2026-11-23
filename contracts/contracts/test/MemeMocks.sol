// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

// Mock contracts for the meme vault. FOR TESTS ONLY, never deploy.

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IMemeVenue} from "../meme/IMemeVenue.sol";
import {IPonsFactory, IPoolManager} from "../meme/PonsVenue.sol";
import {MockToken} from "./Mocks.sol";

interface IVaultLike {
    function buy(address token, uint256 ethIn, uint256 minTokensOut, uint256 deadline) external returns (uint256, uint256);
    function withdraw(address token, uint256 amount, address to) external;
}

/// @notice A venue that can be told to behave well or badly. It mints the tokens it sells and pays sales from
///         the ETH it was given.
contract MockMemeVenue is IMemeVenue {
    mapping(address => bool) public listed;
    uint256 public tokensPerEth = 1000 ether; // tokens for 1 ETH
    uint256 public buyFillBps = 10_000; // part of a buy's ETH that is used; the rest goes back
    uint256 public sellFillBps = 10_000; // part of a sale's tokens that is taken
    /// 0 honest · 1 keeps the ETH and gives nothing · 2 gives half · 3 calls back into the vault ·
    /// 4 tries to take more tokens than it was approved for
    uint8 public mode;

    receive() external payable {}

    function setSupported(address token, bool ok) external {
        listed[token] = ok;
    }

    function setRate(uint256 tokensPerEth_) external {
        tokensPerEth = tokensPerEth_;
    }

    function setFill(uint256 buyBps, uint256 sellBps) external {
        buyFillBps = buyBps;
        sellFillBps = sellBps;
    }

    function setMode(uint8 mode_) external {
        mode = mode_;
    }

    function isListed(address token) external view returns (bool) {
        return listed[token];
    }

    function buy(address token, uint256) external payable returns (uint256 tokensOut) {
        if (mode == 1) return 0;
        if (mode == 3) {
            // A venue that tries to use the vault while the vault is in the middle of a trade.
            IVaultLike(msg.sender).buy(token, 1, 1, type(uint256).max);
        }
        uint256 used = (msg.value * buyFillBps) / 10_000;
        tokensOut = (used * tokensPerEth) / 1 ether;
        if (mode == 2) tokensOut /= 2;
        MockToken(token).mint(msg.sender, tokensOut);
        if (msg.value > used) {
            (bool ok,) = msg.sender.call{value: msg.value - used}("");
            require(ok, "refund failed");
        }
    }

    function sell(address token, uint256 amount, uint256) external returns (uint256 ethOut) {
        uint256 take = (amount * sellFillBps) / 10_000;
        if (mode == 4) take = amount + 1;
        IERC20(token).transferFrom(msg.sender, address(this), take);
        if (mode == 1) return 0;
        ethOut = (take * 1 ether) / tokensPerEth;
        if (mode == 2) ethOut /= 2;
        (bool ok,) = msg.sender.call{value: ethOut}("");
        require(ok, "payout failed");
    }
}

/// @notice A wallet that refuses ETH, to see what a withdrawal to it does.
contract RefusesEth {
    receive() external payable {
        revert("no ETH here");
    }
}

/// @notice Stands in for the pons factory: one settable record per token.
contract MockPonsFactory {
    mapping(address => IPonsFactory.LaunchedToken) private records;
    uint256 public pushes;
    bool public pushWorks = true;

    function setLaunch(address token, address curve, address pairToken, uint8 phase, bool exists) external {
        IPonsFactory.LaunchedToken storage r = records[token];
        r.token = token;
        r.curve = curve;
        r.pairToken = pairToken;
        r.phase = phase;
        r.exists = exists;
        r.poolFee = 0;
        r.tickSpacing = 200;
    }

    function setPushWorks(bool ok) external {
        pushWorks = ok;
    }

    function getLaunchedToken(address token) external view returns (IPonsFactory.LaunchedToken memory) {
        return records[token];
    }

    function createGraduatedPool(address token) external {
        pushes++;
        require(pushWorks, "cannot seed the pool");
        records[token].phase = 2;
    }
}

/// @notice Stands in for a launch's curve, priced in ETH. It can be told to use only part of a buy.
contract MockPonsCurve {
    address public immutable token;
    uint256 public tokensPerEth = 1000 ether;
    uint256 public buyFillBps = 10_000;

    constructor(address token_) {
        token = token_;
    }

    receive() external payable {}

    function setFill(uint256 bps) external {
        buyFillBps = bps;
    }

    function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) external payable returns (uint256 tokensOut) {
        require(msg.value == quoteIn, "NativeValueMismatch");
        uint256 used = (quoteIn * buyFillBps) / 10_000;
        tokensOut = (used * tokensPerEth) / 1 ether;
        // The curve holds the price, not the quantity, to the minimum.
        require(tokensOut * quoteIn >= minTokensOut * used, "SlippageExceeded");
        MockToken(token).mint(recipient, tokensOut);
        if (quoteIn > used) {
            (bool ok,) = msg.sender.call{value: quoteIn - used}("");
            require(ok, "refund failed");
        }
    }

    function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) external returns (uint256 quoteOut) {
        IERC20(token).transferFrom(msg.sender, address(this), tokensIn);
        quoteOut = (tokensIn * 1 ether) / tokensPerEth;
        require(quoteOut >= minQuoteOut, "SlippageExceeded");
        (bool ok,) = recipient.call{value: quoteOut}("");
        require(ok, "payout failed");
    }
}

interface IUnlockCallback {
    function unlockCallback(bytes calldata data) external returns (bytes memory);
}

/// @notice Stands in for the Uniswap v4 PoolManager: one fixed price, and it insists on being paid what the
///         swap said, as the real one does.
contract MockPoolManager {
    uint256 public tokensPerEth = 1000 ether;
    IPoolManager.PoolKey public lastKey;
    bool private unlocked;
    address private synced;
    uint256 private syncedBalance;
    int256 private ethOwedToPool;
    int256 private tokensOwedToPool;
    address private tokenInPlay;

    receive() external payable {}

    function unlock(bytes calldata data) external returns (bytes memory result) {
        require(!unlocked, "AlreadyUnlocked");
        unlocked = true;
        result = IUnlockCallback(msg.sender).unlockCallback(data);
        require(ethOwedToPool == 0 && tokensOwedToPool == 0, "CurrencyNotSettled");
        unlocked = false;
    }

    function swap(IPoolManager.PoolKey memory key, IPoolManager.SwapParams memory params, bytes calldata)
        external
        returns (int256 delta)
    {
        require(unlocked, "ManagerLocked");
        require(params.amountSpecified < 0, "exact input only");
        lastKey = key;
        tokenInPlay = key.currency1;
        uint256 amountIn = uint256(-params.amountSpecified);
        int128 amount0;
        int128 amount1;
        if (params.zeroForOne) {
            uint256 out = (amountIn * tokensPerEth) / 1 ether;
            amount0 = -int128(int256(amountIn));
            amount1 = int128(int256(out));
        } else {
            uint256 out = (amountIn * 1 ether) / tokensPerEth;
            amount0 = int128(int256(out));
            amount1 = -int128(int256(amountIn));
        }
        ethOwedToPool -= amount0;
        tokensOwedToPool -= amount1;
        delta = (int256(amount0) << 128) | int256(uint256(uint128(amount1)));
    }

    function sync(address currency) external {
        synced = currency;
        syncedBalance = IERC20(currency).balanceOf(address(this));
    }

    function settle() external payable returns (uint256 paid) {
        if (msg.value > 0) {
            paid = msg.value;
            ethOwedToPool -= int256(paid);
        } else {
            paid = IERC20(synced).balanceOf(address(this)) - syncedBalance;
            tokensOwedToPool -= int256(paid);
        }
    }

    function take(address currency, address to, uint256 amount) external {
        if (currency == address(0)) {
            ethOwedToPool += int256(amount);
            (bool ok,) = to.call{value: amount}("");
            require(ok, "take failed");
        } else {
            tokensOwedToPool += int256(amount);
            MockToken(currency).mint(to, amount);
        }
    }
}
