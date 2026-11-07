import { NextResponse } from "next/server";
import { Db, openDb } from "./db";
import { Meta } from "./engine";
import { buildSnapshot } from "./snapshot";
import { TkError } from "./types";

export const database = (): Db => openDb();

export type Ctx = { db: Db; body: Record<string, unknown>; meta: Meta; params: Record<string, string> };

const MAX_BODY = 200_000;

/**
 * Wraps a route: reads JSON safely, turns rule violations into clear messages
 * with the right status, and never leaks internals on a real fault.
 */
export function route(
  fn: (ctx: Ctx, request: Request) => Promise<object>,
  opts: { withSnapshot?: boolean } = { withSnapshot: true },
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return async (request: Request, context: { params: Promise<any> }) => {
    try {
      let body: Record<string, unknown> = {};
      if (request.method !== "GET") {
        const length = Number(request.headers.get("content-length") ?? 0);
        if (length > MAX_BODY) throw new TkError("That request is too large.", "too_large", 413);
        const parsed = await request.json().catch(() => null);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
          throw new TkError("Invalid request.", "invalid", 400);
        body = parsed as Record<string, unknown>;
      }
      const db = database();
      const params = ((await context?.params) ?? {}) as Record<string, string>;
      const requestId =
        request.headers.get("idempotency-key") ??
        (typeof body.requestId === "string" ? body.requestId.slice(0, 80) : undefined);
      const result = await fn({ db, body, meta: { requestId }, params }, request);
      return NextResponse.json(
        opts.withSnapshot ? { ...result, snapshot: await buildSnapshot(db) } : result,
      );
    } catch (error) {
      if (error instanceof TkError)
        return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
      console.error("Praxis request failed:", error instanceof Error ? error.message : "unknown error");
      return NextResponse.json({ error: "Praxis couldn't complete that. Try again." }, { status: 500 });
    }
  };
}

export const str = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
export const int = (v: unknown) => (typeof v === "number" && Number.isInteger(v) ? v : undefined);
