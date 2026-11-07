import { tk } from "@/lib/tk/api";
import { route, str, int } from "@/lib/tk/server";
import { TkError } from "@/lib/tk/types";

export const dynamic = "force-dynamic";

/** /api/orders/{id}/{eta|issue|withdraw|cancel|check|allergen|seal|handoff|remake|print} */
export const POST = route(async ({ db, body, meta, params }) => {
  const { id, action } = params;
  switch (action) {
    case "eta": {
      const minutes = int(body.minutes);
      if (minutes === undefined) throw new TkError("Enter the minutes until the driver arrives.", "invalid", 422);
      return { result: await tk.updateEta(db, { orderId: id, minutesFromNow: minutes, earlyS: int(body.earlyS), lateS: int(body.lateS), source: str(body.source, 20) || "manual" }, meta) };
    }
    case "issue":
      return { result: await tk.issue(db, id, meta) };
    case "withdraw":
      return { result: await tk.withdraw(db, id, str(body.reason), meta) };
    case "cancel":
      return { result: await tk.cancel(db, id, body.force === true, meta) };
    case "check":
      return { result: await tk.check(db, id, str(body.key, 100), body.checked === true, meta) };
    case "allergen":
      return { result: await tk.allergen(db, id, body.acknowledged === true, meta) };
    case "seal":
      return { result: await tk.seal(db, id, { count: int(body.count) ?? -1, allergenAck: body.allergenAck === true }, meta) };
    case "handoff":
      return { result: await tk.tryHandoff(db, id, body.code, meta) };
    case "remake":
      return {
        result: await tk.remake(
          db,
          {
            orderId: id,
            itemId: str(body.itemId, 100),
            portion: int(body.portion),
            reason: str(body.reason),
            managerException: body.managerException === true,
          },
          meta,
        ),
      };
    case "print":
      return { result: await tk.print(db, id, meta) };
    default:
      throw new TkError("Unknown action.", "not_found", 404);
  }
});
