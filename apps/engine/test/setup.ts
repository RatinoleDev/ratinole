// Point Prisma at the test database before any test imports it.
import { readFileSync } from "node:fs";

function fromEnvFile(name: string): string | undefined {
  try {
    const line = readFileSync(new URL("../../../.env", import.meta.url), "utf8")
      .split("\n")
      .find((l) => l.startsWith(`${name}=`));
    return line?.slice(name.length + 1).trim() || undefined;
  } catch {
    return undefined;
  }
}

const testUrl = process.env.TEST_DATABASE_URL ?? fromEnvFile("TEST_DATABASE_URL");
if (testUrl) process.env.DATABASE_URL = testUrl;
else delete process.env.DATABASE_URL;
