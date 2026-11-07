import { tk } from "@/lib/tk/api";
import { route } from "@/lib/tk/server";

export const dynamic = "force-dynamic";

export const POST = route(async ({ db, body, meta }) => ({
  result: body.action === "clear" ? await tk.clearSample(db, meta) : await tk.loadSample(db, meta),
}));
