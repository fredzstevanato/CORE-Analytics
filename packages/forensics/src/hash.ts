import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export async function computeSha256FromBuffer(input: Buffer): Promise<string> {
  return createHash("sha256").update(input).digest("hex");
}

export async function computeSha256FromFile(filePath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
