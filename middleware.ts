import { NextRequest, NextResponse } from "next/server";
import { COOKIE, isCrossSite, sameText, sessionToken } from "@/lib/session";

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|demo/).*)"],
};

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const api = pathname.startsWith("/api/");

  if (
    api &&
    request.method !== "GET" &&
    (request.headers.get("sec-fetch-site") === "cross-site" ||
      isCrossSite(request.headers.get("origin"), request.headers.get("host")))
  )
    return NextResponse.json({ error: "Not allowed." }, { status: 403 });

  const passcode = process.env.PRAXIS_PASSCODE;
  if (!passcode || pathname === "/login" || pathname === "/api/login")
    return NextResponse.next();

  const token = request.cookies.get(COOKIE)?.value ?? "";
  if (sameText(token, await sessionToken(passcode))) return NextResponse.next();
  if (api)
    return NextResponse.json({ error: "Sign in first." }, { status: 401 });
  return NextResponse.redirect(new URL("/login", request.url));
}
