import { PrismaClient } from "@prisma/client";
import { config as dotenvConfig } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function ensureDatabaseEnv() {
  if (process.env.DATABASE_URL) return;

  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "..", ".env"),
    resolve(process.cwd(), "..", "..", ".env"),
    resolve(currentDir, "..", "..", "..", ".env")
  ];

  for (const envPath of candidates) {
    if (!existsSync(envPath)) continue;
    dotenvConfig({ path: envPath });
    if (process.env.DATABASE_URL) return;
  }
}

ensureDatabaseEnv();

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: ["error", "warn"]
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
