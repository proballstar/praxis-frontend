import { tk } from "@/lib/tk/api";
import { route, str, int } from "@/lib/tk/server";
import { TkError } from "@/lib/tk/types";

export const dynamic = "force-dynamic";

/** Record a real start, completion, correction or overrun. Nothing completes on a timer. */
export const POST = route(async ({ db, body, meta, params }) => {
  const action = body.action;
  if (action !== "start" && action !== "done" && action !== "reopen" && action !== "extend")
    throw new TkError("Unknown action.", "invalid", 422);
  return {
    result: await tk.task(
      db,
      {
        taskId: params.id,
        action,
        scope: body.scope === "batch" ? "batch" : "task",
        managerOverride: body.managerOverride === true,
        reason: str(body.reason),
        minutes: int(body.minutes),
      },
      meta,
    ),
  };
});
