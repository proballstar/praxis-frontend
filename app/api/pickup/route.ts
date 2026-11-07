import { tk } from "@/lib/tk/api";
import { route } from "@/lib/tk/server";

export const dynamic = "force-dynamic";

/** Looks a pickup code up. Reading only: entering a code never changes an order. */
export const POST = route(async ({ db, body }) => ({ lookup: tk.lookup(db, body.code) }), {
  withSnapshot: false,
});
