import { PrismaClient } from "@prisma/client";

export * from "@prisma/client";

const g = globalThis as unknown as { __prisma?: PrismaClient };

/** One Prisma client per process. */
export const prisma: PrismaClient = g.__prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") g.__prisma = prisma;
