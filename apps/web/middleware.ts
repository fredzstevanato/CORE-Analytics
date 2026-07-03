import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

const COOKIE_NAME = "core_session";

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

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!api|_next|favicon.ico).*)"]
};
