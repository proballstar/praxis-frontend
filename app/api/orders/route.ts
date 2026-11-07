import { tk } from "@/lib/tk/api";
import { route, str, int } from "@/lib/tk/server";
import { NewItem } from "@/lib/tk/engine";
import { TkError } from "@/lib/tk/types";

export const dynamic = "force-dynamic";

export const POST = route(async ({ db, body, meta }) => {
  const channel = body.channel;
  if (channel !== "delivery" && channel !== "walk_in" && channel !== "phone")
    throw new TkError("Choose delivery, walk-in or phone.", "invalid", 422);
  const rawItems = Array.isArray(body.items) ? body.items.slice(0, 12) : [];
  const items: NewItem[] = rawItems.map((i: Record<string, unknown>) => ({
    recipe: str(i.recipe, 60) || undefined,
    name: str(i.name, 60) || undefined,
    station: str(i.station, 40) || undefined,
    minutes: int(i.minutes),
    qty: int(i.qty) ?? 0,
    modifiers: Array.isArray(i.modifiers) ? i.modifiers.slice(0, 6).map((m) => str(m, 40)).filter(Boolean) : [],
    allergen: str(i.allergen, 120) || undefined,
  }));
  const created = await tk.createOrder(
    db,
    {
      channel,
      customer: str(body.customer, 60),
      items,
      etaMinutes: int(body.etaMinutes),
      promisedMinutes: int(body.promisedMinutes),
      driverName: str(body.driverName, 60),
      pickupCode: str(body.pickupCode, 12),
      allergen: str(body.allergen, 200),
    },
    meta,
  );
  return { result: created };
});
