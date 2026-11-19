import { Redis } from "ioredis";
import { env } from "./env";

/** BullMQ needs maxRetriesPerRequest: null on its connections. */
export function redisConnection(): Redis {
  return new Redis(env.redisUrl(), { maxRetriesPerRequest: null });
}
