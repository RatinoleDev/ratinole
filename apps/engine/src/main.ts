/**
 * Engine process: a BullMQ worker that runs the hourly tick, per-agent jobs,
 * backtests and the daily example backtest. Writes a heartbeat to Redis.
 */
import { ENGINE_QUEUE } from "@rationale/config";
import { prisma } from "@rationale/db";
import { Queue, Worker, type Job } from "bullmq";
import { env } from "./env";
import { log } from "./log";
import { hyperliquidFunding } from "./market/funding";
import { startLivePrices } from "./market/live";
import { redisConnection } from "./redis";
import { FreshDataPendingError, hourFloor } from "./runAgent";
import { ensureExample, runBacktest } from "./runBacktest";
import { retryDelayMs, runAgentAndRecord, tick } from "./tick";
import { OrderPendingError, withoutUrls } from "./vault/chain";
import { liveChainFromEnv } from "./vault/setup";

const redis = redisConnection();
const queue = new Queue(ENGINE_QUEUE, { connection: redisConnection() });
const deps = { prisma, redis, funding: hyperliquidFunding, chain: liveChainFromEnv() };

async function handle(job: Job): Promise<unknown> {
  switch (job.name) {
    case "tick":
      return tick({ ...deps, queue });
    case "agent":
      try {
        return await runAgentAndRecord(job.data.agentId, job.data.upToHour, deps);
      } catch (err) {
        if (err instanceof FreshDataPendingError) log("info", "waiting for candle", { agentId: job.data.agentId, attempt: job.attemptsMade + 1 });
        else if (err instanceof OrderPendingError) log("info", "waiting for an order to confirm", { agentId: job.data.agentId, attempt: job.attemptsMade + 1 });
        else {
          await prisma.engineRun.updateMany({ where: { hour: new Date(job.data.upToHour) }, data: { errors: { increment: 1 } } });
          log("error", "agent job failed", { agentId: job.data.agentId, error: withoutUrls(err) });
        }
        // What is thrown is stored with the job. The two "not yet" signals carry no addresses; anything else goes
        // on without RPC addresses, which can hold an access key.
        if (err instanceof FreshDataPendingError || err instanceof OrderPendingError) throw err;
        throw new Error(withoutUrls(err));
      }
    case "backtest":
      return runBacktest(job.data.backtestId, deps);
    case "example":
      return ensureExample(deps);
    default:
      log("warn", "unknown job", { name: job.name });
      return null;
  }
}

async function start() {
  await queue.upsertJobScheduler("hourly-tick", { pattern: `${env.runMinute()} * * * *`, tz: "UTC" }, { name: "tick", data: {} });
  await queue.upsertJobScheduler("daily-example", { pattern: "23 4 * * *", tz: "UTC" }, { name: "example", data: {} });

  const worker = new Worker(ENGINE_QUEUE, handle, { connection: redisConnection(), concurrency: 4, settings: { backoffStrategy: retryDelayMs } });
  worker.on("failed", (job, err) => {
    const waiting = err instanceof FreshDataPendingError || err instanceof OrderPendingError;
    if (!waiting) log("warn", "job failed", { name: job?.name, id: job?.id, error: withoutUrls(err) });
    // A job that waited to the end without an answer must not vanish silently: the next hourly run picks it up.
    else if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) log("warn", "gave up waiting; the next hourly run will finish it", { name: job.name, id: job.id, why: err.message });
  });

  const live = startLivePrices(redis);

  const beat = () => redis.set("engine:heartbeat", new Date().toISOString()).catch(() => undefined);
  await beat();
  const timer = setInterval(beat, 30_000);

  // Catch up anything missed while the engine was down, and make sure the example exists.
  const hour = hourFloor(Date.now());
  await queue.add("tick", {}, { jobId: `tick-startup-${Date.now()}`, removeOnComplete: 100 });
  await queue.add("example", {}, { jobId: `example-startup-${hour}`, removeOnComplete: 100, removeOnFail: 100 });
  log("info", "engine started", { queue: ENGINE_QUEUE, runMinute: env.runMinute() });

  const stop = async () => {
    log("info", "engine stopping");
    clearInterval(timer);
    live.stop();
    await worker.close();
    await queue.close();
    await redis.quit();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

start().catch((err) => {
  log("error", "engine failed to start", { error: String(err) });
  process.exit(1);
});
