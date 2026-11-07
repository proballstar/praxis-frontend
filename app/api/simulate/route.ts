import { cleanChanges, simulate } from "@/lib/tk/changes";
import { acquire } from "@/lib/limit";
import { route } from "@/lib/tk/server";
import { TkError } from "@/lib/tk/types";

export const dynamic = "force-dynamic";

/** Rush Recovery: try changes on an isolated copy. The live board is never touched. */
export const POST = route(
  async ({ db, body }) => {
    const changes = cleanChanges(body.changes);
    const release = acquire();
    if (!release) throw new TkError("Too many requests at once. Wait a moment and try again.", "busy", 429);
    try {
      return { simulation: await simulate(db, changes), changes };
    } finally {
      release();
    }
  },
  { withSnapshot: false },
);
