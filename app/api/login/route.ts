import { NextResponse } from "next/server";
import {
  COOKIE,
  SESSION_SECONDS,
  sameText,
  sessionToken,
} from "@/lib/session";

export const dynamic = "force-dynamic";

const WRONG_DELAY_MS = 800;

export async function POST(request: Request) {
  const passcode = process.env.PRAXIS_PASSCODE;
  if (!passcode) return NextResponse.json({ ok: true });
  const body = await request.json().catch(() => null);
  const attempt = typeof body?.passcode === "string" ? body.passcode : "";
  if (!sameText(attempt, passcode)) {
    // Slows guessing without locking staff out in the middle of a rush.
    await new Promise((r) => setTimeout(r, WRONG_DELAY_MS));
    return NextResponse.json({ error: "Wrong passcode." }, { status: 401 });
  }
  const response = NextResponse.json({ ok: true });
  response.cookies.set(COOKIE, await sessionToken(passcode), {
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    maxAge: SESSION_SECONDS,
  });
  return response;
}
