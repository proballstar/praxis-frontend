import { tk } from "@/lib/tk/api";
import { route } from "@/lib/tk/server";
import { Config, TkError } from "@/lib/tk/types";

export const dynamic = "force-dynamic";

export const POST = route(async ({ db, body, meta }) => {
  if (!body.config || typeof body.config !== "object")
    throw new TkError("The settings could not be read.", "invalid", 400);
  return { result: await tk.settings(db, body.config as Config, meta) };
});
