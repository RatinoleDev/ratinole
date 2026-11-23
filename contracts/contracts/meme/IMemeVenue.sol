// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title IMemeVenue
/// @notice One place where a meme vault can trade a token against ETH. A venue is a small contract that knows
///         how one market works (a launchpad's curve, a pool) and holds nothing between transactions.
///
///         A vault never trusts a venue with more than the trade in hand: it sends the ETH of one buy, or
///         approves the tokens of one sale, and afterwards measures its own balances.
interface IMemeVenue {
    /// @notice Buy `token` with the ETH sent. The tokens go to the caller, and so does any ETH not spent.
    /// @param minTokensOut the least the caller accepts for ALL the ETH sent. When only part of the ETH can be
    ///        spent, the same price per token still has to be met.
    function buy(address token, uint256 minTokensOut) external payable returns (uint256 tokensOut);

    /// @notice Sell `amount` of `token`, taken from the caller (who approved it). The ETH goes to the caller.
    function sell(address token, uint256 amount, uint256 minEthOut) external returns (uint256 ethOut);

    /// @notice True when this venue knows the token as a genuine listing priced in ETH. It does not say that
    ///         a trade would go through right now.
    function isListed(address token) external view returns (bool);
}
