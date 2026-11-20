// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

/// @title RatinoleTimelock
/// @notice OpenZeppelin's TimelockController, unchanged. It is the admin of the factory and the decision
///         registry; the Ratinole Safe is its proposer and executor, and every admin change waits `minDelay`
///         (3 days on mainnet, HANDOFF section 6.2) in public before it can run. Pass `admin = address(0)` so
///         the timelock administers itself.
contract RatinoleTimelock is TimelockController {
    constructor(uint256 minDelay, address[] memory proposers, address[] memory executors, address admin)
        TimelockController(minDelay, proposers, executors, admin)
    {}
}
