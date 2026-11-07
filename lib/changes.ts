import { Metrics, Outcome } from "./engine";
import {
  Action,
  Order,
  OrderLine,
  Service,
  ServiceError,
  etaStatus,
  itemsText,
  openOrders,
  planFor,
  recommendation,
  reduce,
} from "./service";
import { matchMenu } from "./menu-match";

/**
 * Changes that can be tested on a copy of the board. Every number here comes
 * from the shift rules and planner, never from a model.
 */
export type Change = {
  kind:
    | "add_order"
    | "add_time"
    | "courier_eta"
    | "courier_here"
    | "cancel"
    | "apply_recommended"
    | "resource_down";
  ticket?: string;
  minutes?: number;
  items?: { name: string; qty: number }[];
  prep_minutes?: number;
  resource?: string;
  units?: number;
};

export type Proposal = {
  /** Board version the numbers were computed on. Approval is refused after it changes. */
  baseRev: number;
  lines: string[];
  actions: Action[];
  before: Metrics;
  after: Metrics;
};

export type Shift = { ref: string; minutes: number };

/** Who gains and who pays when one outcome replaces another. */
export type Tradeoff = { earlier: Shift[]; later: Shift[] };

export type Simulation = Proposal & {
  tradeoff: Tradeoff;
  summary: string;
  /** Reordering on top of the change, when that is worth doing. */
  reorder: {
    actions: Action[];
    after: Metrics;
    tradeoff: Tradeoff;
    summary: string;
    sequence: string[];
  } | null;
  /** Tickets whose courier time should be checked before trusting this. */
  unconfirmed: string[];
};

function open(s: Service, ticket?: string): Order {
  const ref = (ticket ?? "").replace(/^#/, "").trim();
  const order = openOrders(s).find((o) => o.ref === ref);
  if (!order) throw new ServiceError(`No open order #${ref || "?"}.`);
  return order;
}

function need(value: number | undefined, label: string) {
  if (value === undefined) throw new ServiceError(`${label} is required.`);
  return value;
}

function orderLines(s: Service, c: Change): OrderLine[] {
  if (!c.items?.length) throw new ServiceError("Add at least one item.");
  return c.items.map((item) => {
    const { menuId, uncertain } = matchMenu(item.name, s.menu);
    if (menuId && !uncertain)
      return {
        menuId,
        qty: item.qty,
        ...(c.prep_minutes ? { minutes: c.prep_minutes } : {}),
      };
    if (c.prep_minutes === undefined)
      throw new ServiceError(
        `"${item.name}" isn't on the menu, so a prep time is needed.`,
      );
    return { name: item.name, qty: item.qty, minutes: c.prep_minutes };
  });
}

const resourceByName = (s: Service, name?: string) => {
  const wanted = (name ?? "").trim().toLowerCase();
  const found = s.resources.find(
    (r) => r.id === wanted || r.name.toLowerCase() === wanted,
  );
  if (!found) throw new ServiceError(`No resource called "${name ?? ""}".`);
  return found;
};

export function compile(s: Service, changes: Change[]) {
  if (!changes.length) throw new ServiceError("No changes were given.");
  const actions: Action[] = [];
  const lines: string[] = [];
  for (const c of changes) {
    switch (c.kind) {
      case "add_order": {
        const eta = need(c.minutes, "Courier arrival");
        const order = {
          ref: c.ticket,
          lines: orderLines(s, c),
          etaMinutes: eta,
        };
        actions.push({ type: "addOrder", order });
        const dishes = c.items!.map((i) => `${i.qty} × ${i.name}`).join(", ");
        lines.push(
          `Add ${c.ticket ? `#${c.ticket}: ` : ""}${dishes} (courier in ${eta} min)`,
        );
        break;
      }
      case "add_time": {
        const order = open(s, c.ticket);
        const minutes = need(c.minutes, "Added time");
        actions.push({ type: "addTime", id: order.id, minutes });
        lines.push(`Add ${minutes} min to #${order.ref}`);
        break;
      }
      case "courier_eta": {
        const order = open(s, c.ticket);
        const minutes = need(c.minutes, "Courier arrival");
        actions.push({ type: "courierEta", id: order.id, minutes });
        lines.push(`Courier for #${order.ref} arrives in ${minutes} min`);
        break;
      }
      case "courier_here": {
        const order = open(s, c.ticket);
        actions.push({ type: "courierHere", id: order.id });
        lines.push(`Courier is here for #${order.ref}`);
        break;
      }
      case "cancel": {
        const order = open(s, c.ticket);
        actions.push({ type: "cancel", id: order.id });
        lines.push(`Cancel #${order.ref}`);
        break;
      }
      case "apply_recommended":
        actions.push({ type: "optimize" });
        lines.push("Use the recommended cooking order");
        break;
      case "resource_down": {
        const resource = resourceByName(s, c.resource);
        const units = need(c.units, "Units out");
        const minutes = need(c.minutes, "Time out of action");
        actions.push({
          type: "resourceDown",
          resource: resource.id,
          units,
          minutes,
        });
        lines.push(
          units
            ? `${resource.name}: ${units} of ${resource.capacity} out for ${minutes} min`
            : `${resource.name} is back`,
        );
        break;
      }
      default:
        throw new ServiceError("Unknown change.");
    }
  }
  return { actions, lines };
}

/** Time values are minutes from now. Customer names are deliberately left out. */
export function boardFacts(s: Service, now: number) {
  const p = planFor(s, now);
  const slot = new Map(p.current.slots.map((x) => [x.id, x]));
  const ref = (id: string) => s.orders.find((o) => o.id === id)!.ref;
  return {
    resources: s.resources.map((r) => ({
      name: r.name,
      capacity: r.capacity,
      units_out: r.down && now < r.down.until ? r.down.units : 0,
    })),
    menu: s.menu.map((m) => ({
      name: m.name,
      prep_minutes: m.minutes,
      resource: m.resource,
      quality_window_minutes: m.qualityMinutes,
    })),
    orders: openOrders(s).map((o) => {
      const x = slot.get(o.id);
      return {
        ticket: o.ref,
        items: itemsText(o.items),
        status: o.status,
        courier_in: Math.round((o.arrival - now) / 60_000),
        courier_time: etaStatus(s, o, now),
        ready_in: x?.ready,
        starts_in: x?.start,
        late_by: x?.late,
        courier_waits: x?.driverWait,
        minutes_past_quality_window: x?.quality,
      };
    }),
    cooking_order: p.current.sequence.map(ref),
    projected: p.current.metrics,
    recommended_order: p.shouldChange ? p.best.sequence.map(ref) : null,
    recommended_projected: p.shouldChange ? p.best.metrics : null,
    search: p.method,
  };
}

export function tradeoffBetween(s: Service, from: Outcome, to: Outcome): Tradeoff {
  const earlier: Shift[] = [];
  const later: Shift[] = [];
  for (const slot of to.slots) {
    const was = from.slots.find((x) => x.id === slot.id);
    const ref = s.orders.find((o) => o.id === slot.id)?.ref;
    if (!was || !ref) continue;
    const change = slot.ready - was.ready;
    if (change < 0) earlier.push({ ref, minutes: -change });
    if (change > 0) later.push({ ref, minutes: change });
  }
  return { earlier, later };
}

const list = (shifts: Shift[]) =>
  shifts.map((x) => `#${x.ref} by ${x.minutes} min`).join(", ");

/** A deterministic sentence naming the cost as well as the gain. */
export function describe(a: Metrics, b: Metrics, t: Tradeoff) {
  const parts: string[] = [];
  if (t.earlier.length) parts.push(`Earlier: ${list(t.earlier)}.`);
  if (t.later.length) parts.push(`Later: ${list(t.later)}.`);
  const delta = (label: string, x: number, y: number) =>
    x === y ? null : `${label} ${x} → ${y} min`;
  const totals = [
    delta("courier waiting", a.wait, b.wait),
    delta("lateness", a.lateness, b.lateness),
    delta("food sitting", a.idle, b.idle),
    delta("past quality window", a.quality, b.quality),
  ].filter(Boolean);
  if (totals.length) {
    const sentence = totals.join(", ");
    parts.push(`${sentence[0].toUpperCase()}${sentence.slice(1)}.`);
  }
  return parts.join(" ") || "No predicted change.";
}

/** Tests changes on a copy through the real rules. The live board is not touched. */
export function simulate(
  s: Service,
  now: number,
  changes: Change[],
): Simulation {
  const { actions, lines } = compile(s, changes);
  const start = planFor(s, now);
  const next = reduce(
    s,
    { type: "batch", label: "simulation", baseRev: s.rev, actions },
    now,
    ((n) => () => `simulated-${++n}`)(0),
  );
  const p = planFor(next, now);
  const tradeoff = tradeoffBetween(next, start.current, p.current);
  const reorderTradeoff = tradeoffBetween(next, p.current, p.best);
  const reorder =
    p.shouldChange && recommendation({ ...next, dismissedPlan: null }, p, now)
      ? {
          actions: [...actions, { type: "optimize" as const }],
          after: p.best.metrics,
          tradeoff: reorderTradeoff,
          summary: describe(p.current.metrics, p.best.metrics, reorderTradeoff),
          sequence: p.best.sequence.map(
            (id) => next.orders.find((o) => o.id === id)!.ref,
          ),
        }
      : null;
  return {
    baseRev: s.rev,
    lines,
    actions,
    before: start.current.metrics,
    after: p.current.metrics,
    tradeoff,
    summary: describe(start.current.metrics, p.current.metrics, tradeoff),
    reorder,
    unconfirmed: openOrders(next)
      .filter((o) => {
        const status = etaStatus(next, o, now);
        return status === "stale" || status === "unknown";
      })
      .map((o) => o.ref),
  };
}

/** What the assistant is told about a simulation. */
export function simulationFacts(r: Simulation) {
  return {
    changes: r.lines,
    before: r.before,
    after: r.after,
    who_moves: r.tradeoff,
    summary: r.summary,
    reorder_on_top: r.reorder && {
      sequence: r.reorder.sequence,
      after: r.reorder.after,
      who_moves: r.reorder.tradeoff,
      summary: r.reorder.summary,
    },
    courier_times_to_confirm: r.unconfirmed,
  };
}
