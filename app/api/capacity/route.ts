import { tk } from "@/lib/tk/api";
import { route, str, int } from "@/lib/tk/server";
import { TkError } from "@/lib/tk/types";

export const dynamic = "force-dynamic";

export const POST = route(async ({ db, body, meta }) => {
  const kind = body.kind === "pool" ? "pool" : body.kind === "station" ? "station" : null;
  if (!kind) throw new TkError("Choose a station or a staff group.", "invalid", 422);
  return {
    result: await tk.capacity(
      db,
      { kind, id: str(body.id, 40), unitsOut: int(body.unitsOut) ?? -1, minutes: int(body.minutes) },
      meta,
    ),
  };
});
