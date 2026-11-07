import { Metrics } from "./engine";
import {
  Action,
  KitchenSettings,
  Order,
  Service,
  ServiceError,
  atTime,
  estimatePrep,
  openOrders,
  planFor,
  reduce,
} from "./service";

/**
 * Changes the assistant can test or propose. Every number returned here comes
 * from the shift rules and planner, never from the model.
 */
export type Change = {
  kind:
    | "add_order"
    | "add_time"
    | "courier_eta"
    | "courier_here"
    | "cancel"
    | "apply_recommended"
    | "set_stations";
  ticket?: string;
  minutes?: number;
  items?: { name: string; qty: number }[];
  prep_minutes?: number;
  stations?: number;
};

export type Proposal = {
  /** Board version the numbers were computed on. Approval is refused after it changes. */
  baseRev: number;
  lines: string[];
  actions: Action[];
  before: Metrics;
  after: Metrics;
};

const normal = (s: string) => s.trim().toLowerCase();

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

function newOrder(s: Service, c: Change) {
  if (!c.items?.length) throw new ServiceError("Add at least one item.");
  const lines = c.items.map((item) => ({
    item,
    menu: s.menu.find((m) => normal(m.name) === normal(item.name)),
  }));
  const unknown = lines.find((l) => !l.menu);
  if (unknown && c.prep_minutes === undefined)
    throw new ServiceError(
      `"${unknown.item.name}" isn't on the menu, so a prep time is needed.`,
    );
  const prep =
    c.prep_minutes ??
    estimatePrep(lines.map((l) => ({ minutes: l.menu!.minutes, qty: l.item.qty })));
  return {
    ref: c.ticket,
    items: lines
      .map((l) => `${l.item.qty} × ${l.menu?.name ?? l.item.name}`)
      .join(", "),
    prep,
    etaMinutes: need(c.minutes, "Courier arrival"),
  };
}

export function compile(s: Service, changes: Change[]) {
  if (!changes.length) throw new ServiceError("No changes were given.");
  const actions: Action[] = [];
  const lines: string[] = [];
  for (const c of changes) {
    switch (c.kind) {
      case "add_order": {
        const order = newOrder(s, c);
        actions.push({ type: "addOrder", order });
        lines.push(
          `Add ${order.ref ? `#${order.ref}: ` : ""}${order.items} (${order.prep} min prep, courier in ${order.etaMinutes} min)`,
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
      case "set_stations": {
        const stations = need(c.stations, "Station count");
        const settings: KitchenSettings = {
          name: s.name,
          stations,
          graceMinutes: s.graceMinutes,
          packMinutes: s.packMinutes,
          menu: s.menu,
        };
        actions.push({ type: "configure", settings });
        lines.push(`Run ${stations} cooking station${stations === 1 ? "" : "s"}`);
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
  return {
    stations: s.stations,
    menu: s.menu.map((m) => ({ name: m.name, prep_minutes: m.minutes })),
    orders: openOrders(s).map((o) => {
      const x = slot.get(o.id);
      return {
        ticket: o.ref,
        items: o.items,
        status: o.status,
        station: o.station,
        courier_in: Math.round((o.arrival - now) / 60_000),
        courier_here: o.courierHereAt !== undefined,
        ready_in: x?.end,
        starts_in: x?.start,
        late_by: x?.late,
        courier_waits: x?.driverWait,
      };
    }),
    cooking_order: p.current.sequence.map(
      (id) => s.orders.find((o) => o.id === id)!.ref,
    ),
    projected: p.current.metrics,
    recommended_order: p.shouldChange
      ? p.best.sequence.map((id) => s.orders.find((o) => o.id === id)!.ref)
      : null,
    recommended_projected: p.shouldChange ? p.best.metrics : null,
    search: p.method,
  };
}

/** Runs changes on a copy through the real rules. The live board is not touched. */
export function simulate(s: Service, now: number, changes: Change[]) {
  const { actions, lines } = compile(s, changes);
  const before = planFor(s, now).current.metrics;
  const next = reduce(
    s,
    { type: "batch", label: "simulation", baseRev: s.rev, actions },
    now,
    ((n) => () => `simulated-${++n}`)(0),
  );
  const p = planFor(next, now);
  const clock = new Map(p.current.slots.map((x) => [x.id, x]));
  return {
    proposal: {
      baseRev: s.rev,
      lines,
      actions,
      before,
      after: p.current.metrics,
    } as Proposal,
    facts: {
      changes: lines,
      before,
      after: p.current.metrics,
      after_if_recommended_order_is_also_used: p.shouldChange
        ? p.best.metrics
        : null,
      orders: openOrders(next).map((o) => ({
        ticket: o.ref,
        ready_in: clock.get(o.id)?.end,
        ready_at: clock.get(o.id)
          ? new Date(atTime(now, clock.get(o.id)!.end)).toISOString()
          : undefined,
        late_by: clock.get(o.id)?.late,
        courier_waits: clock.get(o.id)?.driverWait,
      })),
    },
  };
}
