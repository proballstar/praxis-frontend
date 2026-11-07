import { shiftReport } from "@/lib/tk/report";
import { route } from "@/lib/tk/server";

export const dynamic = "force-dynamic";

export const GET = route(async ({ db }) => ({ report: shiftReport(db) }), { withSnapshot: false });
