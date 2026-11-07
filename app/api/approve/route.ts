import { tk } from "@/lib/tk/api";
import { cleanChanges } from "@/lib/tk/changes";
import { route, int } from "@/lib/tk/server";
import { TkError } from "@/lib/tk/types";

export const dynamic = "force-dynamic";

/** Applies changes a person approved. Refused if the board changed since they were shown. */
export const POST = route(async ({ db, body, meta }) => {
  const baseRev = int(body.baseRev);
  if (baseRev === undefined) throw new TkError("This approval is missing its board version.", "invalid", 400);
  return { result: await tk.approve(db, baseRev, cleanChanges(body.changes), meta) };
});
