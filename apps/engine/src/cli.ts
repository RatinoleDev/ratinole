/**
 * Manual engine commands, run without the queue:
 *   pnpm --filter @rationale/engine tick              run every owed agent now
 *   pnpm --filter @rationale/engine tick example      refresh the example backtest
 *   pnpm --filter @rationale/engine tick backtest ID  run one backtest
 */
import { prisma } from "@rationale/db";
import { redisConnection } from "./redis";
import { ensureExample, runBacktest } from "./runBacktest";
import { tick } from "./tick";

const [cmd, arg] = process.argv.slice(2);
const redis = redisConnection();
const deps = { prisma, redis };

async function main() {
  if (!cmd) console.log(await tick(deps));
  else if (cmd === "example") console.log(await ensureExample(deps));
  else if (cmd === "backtest" && arg) console.log(await runBacktest(arg, deps));
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
