import { randomBytes, scryptSync, timingSafeEqual, createHmac, createCipheriv, createDecipheriv, createHash } from "node:crypto";

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const derived = scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const [salt, key] = storedHash.split(":");
  if (!salt || !key) return false;
  const derived = scryptSync(password, salt, 64).toString("hex");
  const a = Buffer.from(derived, "hex");
  const b = Buffer.from(key, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function signPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

function deriveAesKey(secret: string) {
  return createHash("sha256").update(secret).digest();
}

export function encryptText(plainText: string, secret: string): string {
  const iv = randomBytes(12);
  const key = deriveAesKey(secret);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${encrypted.toString("base64url")}`;
}

export function decryptText(payload: string, secret: string): string {
  const [prefix, version, ivRaw, tagRaw, contentRaw] = payload.split(":");
  if (prefix !== "enc" || version !== "v1" || !ivRaw || !tagRaw || !contentRaw) {
    throw new Error("Formato de segredo criptografado invalido.");
  }
  const key = deriveAesKey(secret);
  const iv = Buffer.from(ivRaw, "base64url");
  const tag = Buffer.from(tagRaw, "base64url");
  const encrypted = Buffer.from(contentRaw, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return plain.toString("utf8");
}
