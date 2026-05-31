import { config as dotenvConfig } from "dotenv";
import { existsSync } from "node:fs";
import path from "node:path";

const candidates = [
  path.resolve(process.cwd(), ".env"),
  path.resolve(process.cwd(), "..", ".env"),
  path.resolve(process.cwd(), "..", "..", ".env")
];

for (const envPath of candidates) {
  if (!existsSync(envPath)) continue;
  dotenvConfig({ path: envPath });
  if (process.env.DATABASE_URL || process.env.REDIS_URL || process.env.WHISPER_BIN) {
    break;
  }
}
