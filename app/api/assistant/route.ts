import { NextResponse } from "next/server";
import { ModelMessage } from "ai";
import { openRouterModel, runAgent } from "@/lib/agent";
import { brief } from "@/lib/service";
import { acquire } from "@/lib/limit";
import { load } from "@/lib/store";

export const dynamic = "force-dynamic";

const MAX_TURNS = 12;
const MAX_LENGTH = 1000;

function parse(value: unknown): ModelMessage[] | null {
  if (!Array.isArray(value) || !value.length || value.length > MAX_TURNS)
    return null;
  const valid = value.every(
    (m) =>
      (m?.role === "user" || m?.role === "assistant") &&
      typeof m.content === "string" &&
      m.content.trim() &&
      m.content.length <= MAX_LENGTH,
  );
  if (!valid || value.at(-1).role !== "user") return null;
  return value.map(({ role, content }) => ({ role, content }));
}

export async function POST(request: Request) {
  let messages: ModelMessage[] | null;
  try {
    messages = parse((await request.json())?.messages);
  } catch {
    messages = null;
  }
  if (!messages)
    return NextResponse.json({ error: "Invalid question." }, { status: 400 });

  const release = acquire();
  if (!release)
    return NextResponse.json(
      { error: "Too many questions at once. Wait a moment and try again." },
      { status: 429 },
    );

  try {
    const service = await load();
    const now = Date.now();
    const local = { answer: brief(service, now), mode: "local" };
    if (!process.env.OPENROUTER_API_KEY || !service.configured)
      return NextResponse.json(local);
    try {
      const { text, proposal } = await runAgent({
        service,
        now,
        messages,
        model: openRouterModel(),
      });
      if (!text && !proposal) return NextResponse.json(local);
      return NextResponse.json({
        answer: text || "This change is ready for your approval.",
        mode: "openrouter",
        proposal,
      });
    } catch (error) {
      console.error(
        "Assistant unavailable:",
        error instanceof Error ? error.name : "unknown error",
      );
      return NextResponse.json(local);
    }
  } catch {
    return NextResponse.json(
      { error: "Praxis could not read this kitchen's data." },
      { status: 500 },
    );
  } finally {
    release();
  }
}
