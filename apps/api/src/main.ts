import { ENGINE_QUEUE } from "@rationale/config";
import { prisma } from "@rationale/db";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { readEnv } from "./env";
import { anthropicDrafter } from "./llm/anthropic";
import { buildServer } from "./server";

const env = readEnv();
const redis = new Redis(env.redisUrl, { maxRetriesPerRequest: 2 });
let redisDown = false;
redis.on("error", (err) => {
  if (!redisDown) console.error(JSON.stringify({ t: new Date().toISOString(), level: "error", msg: "redis unavailable", error: String(err) }));
  redisDown = true;
});
redis.on("ready", () => (redisDown = false));
const queue = new Queue(ENGINE_QUEUE, { connection: new Redis(env.redisUrl, { maxRetriesPerRequest: null }) });

const app = await buildServer({
  prisma,
  redis,
  env,
  enqueue: async (name, data, jobId) => {
    await queue.add(name, data, { jobId, attempts: 2, removeOnComplete: 1000, removeOnFail: 1000 });
  },
  drafterFor: (userId) =>
    env.anthropicApiKey ? anthropicDrafter({ apiKey: env.anthropicApiKey, model: env.llmModel, prisma, userId }) : null,
});

await app.listen({ port: env.port, host: "127.0.0.1" });
console.log(JSON.stringify({ t: new Date().toISOString(), level: "info", msg: "api listening", port: env.port, llm: env.anthropicApiKey ? env.llmModel : "off" }));

const stop = async () => {
  await app.close();
  await queue.close();
  await redis.quit();
  await prisma.$disconnect();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
