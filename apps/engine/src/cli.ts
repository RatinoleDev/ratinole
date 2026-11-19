/**
 * Manual engine commands, run without the queue:
 *   pnpm --filter @rationale/engine tick              run every owed agent now
 *   pnpm --filter @rationale/engine tick example      refresh the example backtest
 *   pnpm --filter @rationale/engine tick backtest ID  run one backtest
 *   pnpm --filter @rationale/engine tick stats        recompute every agent's running stats
 */
import { prisma } from "@rationale/db";
import { hyperliquidFunding } from "./market/funding";
import { redisConnection } from "./redis";
import { recomputeStats } from "./runAgent";
import { ensureExample, runBacktest } from "./runBacktest";
import { tick } from "./tick";

const [cmd, arg] = process.argv.slice(2);
const redis = redisConnection();
const deps = { prisma, redis, funding: hyperliquidFunding };

async function main() {
  if (!cmd) console.log(await tick(deps));
  else if (cmd === "example") console.log(await ensureExample(deps));
  else if (cmd === "backtest" && arg) console.log(await runBacktest(arg, deps));
  else if (cmd === "stats") console.log({ agents: await recomputeStats(prisma) });
  else throw new Error(`Unknown command ${cmd}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await redis.quit();
    await prisma.$disconnect();
  });
