import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const COOKIE_NAME = "core_session";

type SessionPayload = {
  id: string;
  email: string;
  role: string;
};

function getSessionSecret() {
  const secret = process.env.SESSION_SECRET?.trim();
  if (secret) return secret;
  if (process.env.NODE_ENV === "production") {
    return null;
  }
  return "dev-session-secret-change-me";
}

function decodeBase64Url(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padLength = (4 - (normalized.length % 4)) % 4;
  const padded = normalized + "=".repeat(padLength);
  return atob(padded);
}

function hexToBytes(hex: string) {
  if (hex.length % 2 !== 0) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    const byte = Number.parseInt(hex.slice(i, i + 2), 16);
    if (Number.isNaN(byte)) return null;
    bytes[i / 2] = byte;
  }
  return bytes;
}

async function verifySessionToken(token: string) {
  const secret = getSessionSecret();
  if (!secret) return false;
  const [body, signature] = token.split(".");
  if (!body || !signature) return false;

  const signatureBytes = hexToBytes(signature);
  if (!signatureBytes) return false;

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const expectedSignatureBuffer = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(body));
  const expectedSignature = new Uint8Array(expectedSignatureBuffer);

  if (expectedSignature.length !== signatureBytes.length) return false;
  let diff = 0;
  for (let i = 0; i < expectedSignature.length; i += 1) {
    diff |= expectedSignature[i]! ^ signatureBytes[i]!;
  }
  if (diff !== 0) return false;

  try {
    const parsed = JSON.parse(decodeBase64Url(body)) as SessionPayload;
    return Boolean(parsed?.id && parsed?.email && parsed?.role);
  } catch {
    return false;
  }
}

function redirectToLogin(request: NextRequest) {
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  return NextResponse.redirect(url);
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const protectedPath =
    pathname.startsWith("/dashboard") ||
    pathname.startsWith("/cases") ||
    pathname.startsWith("/evidences") ||
    pathname.startsWith("/extractions") ||
    pathname.startsWith("/search") ||
    pathname.startsWith("/timeline") ||
    pathname.startsWith("/chats") ||
    pathname.startsWith("/messages") ||
    pathname.startsWith("/transcriptions") ||
    pathname.startsWith("/custody") ||
    pathname.startsWith("/reports") ||
    pathname.startsWith("/graph");

  if (!protectedPath) return NextResponse.next();
  const token = request.cookies.get(COOKIE_NAME)?.value;
  if (!token) return redirectToLogin(request);

  const valid = await verifySessionToken(token);
  if (!valid) return redirectToLogin(request);

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next|favicon.ico).*)"]
};
