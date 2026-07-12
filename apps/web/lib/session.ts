import { cookies } from "next/headers";
import { timingSafeEqual } from "node:crypto";
import { signPayload } from "@core/shared";

export type SessionUser = {
  id: string;
  email: string;
  name: string;
  role: string;
};

const COOKIE_NAME = "core_session";

function parseBooleanEnv(value: string | undefined): boolean | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return null;
}

function shouldUseSecureCookie() {
  const explicit = parseBooleanEnv(process.env.SESSION_COOKIE_SECURE);
  if (explicit !== null) return explicit;

  const baseUrl = process.env.APP_BASE_URL?.trim().toLowerCase() ?? "";
  if (baseUrl.startsWith("https://")) return true;

  return false;
}

function getSessionSecret() {
  const secret = process.env.SESSION_SECRET?.trim();
  if (secret) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error("SESSION_SECRET obrigatorio em producao.");
  }
  return "dev-session-secret-change-me";
}

function encodeBase64(value: string) {
  return Buffer.from(value, "utf-8").toString("base64url");
}

function decodeBase64(value: string) {
  return Buffer.from(value, "base64url").toString("utf-8");
}

export function createSessionToken(payload: SessionUser): string {
  const body = encodeBase64(JSON.stringify(payload));
  const sig = signPayload(body, getSessionSecret());
  return `${body}.${sig}`;
}

export function parseSessionToken(token: string): SessionUser | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = signPayload(body, getSessionSecret());
  const expectedBuffer = Buffer.from(expected, "utf8");
  const receivedBuffer = Buffer.from(sig, "utf8");
  if (expectedBuffer.length !== receivedBuffer.length) return null;
  if (!timingSafeEqual(expectedBuffer, receivedBuffer)) return null;
  try {
    const parsed = JSON.parse(decodeBase64(body)) as SessionUser;
    if (!parsed?.id || !parsed?.email || !parsed?.role) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function setSessionCookie(user: SessionUser) {
  const store = await cookies();
  const token = createSessionToken(user);
  store.set(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: shouldUseSecureCookie(),
    path: "/",
    maxAge: 60 * 60 * 24 * 7
  });
}

export async function clearSessionCookie() {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const raw = store.get(COOKIE_NAME)?.value;
  if (!raw) return null;
  return parseSessionToken(raw);
}
