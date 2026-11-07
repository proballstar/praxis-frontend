import { Job, Plan, Slot, plan } from "./engine";

/** Live state of one kitchen, and the rules for changing it. Pure: `now` is always passed in. */
export type MenuItem = { id: string; name: string; minutes: number };

export type Order = {
  id: string;
  ref: string;
  customer: string;
  items: string;
  /** Estimated minutes of work when the order was entered. */
  prep: number;
  /** Minutes added later because something went wrong. */
  extra: number;
  receivedAt: number;
  /** Expected courier arrival. */
  arrival: number;
  deadline: number;
  status: "queued" | "cooking" | "ready" | "done" | "cancelled";
  startedAt?: number;
  station?: number;
  readyAt?: number;
  courierHereAt?: number;
  pickedUpAt?: number;
  sample?: boolean;
};

export type ShiftReport = {
  orders: number;
  onTime: number;
  late: number;
  avgCourierWait: number | null;
  avgOverrun: number | null;
};
export type PastShift = ShiftReport & { startedAt: number; endedAt: number };

type Snapshot = { label: string; orders: Order[]; queue: string[] };

export type Service = {
  version: 1;
  rev: number;
  configured: boolean;
  name: string;
  stations: number;
  graceMinutes: number;
  /** Packing minutes between cooking finishing and the order being ready for pickup. */
  packMinutes: number;
  menu: MenuItem[];
  orders: Order[];
  /** Queued order ids, in the order the kitchen intends to cook them. */
  queue: string[];
  /** Recommendation the kitchen chose to ignore. */
  dismissedPlan: string | null;
  /** When the recommendation was declined. A declined plan stays quiet for a while. */
  dismissedAt: number | null;
  /** The newly approved first order is not second-guessed until this time. */
  protectedUntil: number | null;
  undo: Snapshot[];
  shiftStartedAt: number | null;
  shifts: PastShift[];
};

export type KitchenSettings = Pick<
  Service,
  "name" | "stations" | "graceMinutes" | "packMinutes" | "menu"
>;
export type NewOrder = {
  ref?: string;
  customer?: string;
  items: string;
  prep: number;
  etaMinutes: number;
};

export type Action =
  | { type: "configure"; settings: KitchenSettings }
  | { type: "addOrder"; order: NewOrder }
  | { type: "start"; id: string }
  | { type: "addTime"; id: string; minutes: number }
  | { type: "ready"; id: string }
  | { type: "pickedUp"; id: string }
  | { type: "courierEta"; id: string; minutes: number }
  | { type: "courierHere"; id: string }
  | { type: "cancel"; id: string }
  | { type: "move"; id: string; direction: -1 | 1 }
  | { type: "applyPlan"; sequence: string[]; baseRev: number }
  | { type: "dismissPlan"; sequence: string[] }
  | { type: "optimize" }
  | { type: "batch"; label: string; baseRev: number; actions: Action[] }
  | { type: "undo" }
  | { type: "loadSample" }
  | { type: "clearSample" }
  | { type: "endShift" };

/** A request that is well-formed but cannot be honored; shown to the user as-is. */
export class ServiceError extends Error {}

export const MAX_STATIONS = 12;
const MAX_MINUTES = 240;
const UNDO_DEPTH = 10;
/** A declined recommendation stays quiet this long. */
export const COOLDOWN_MS = 10 * 60_000;
/** An approved plan's first order is protected this long. */
export const PROTECT_MS = 3 * 60_000;
const MINUTE = 60_000;

export const starterMenu = (): MenuItem[] =>
  [
    ["Burger", 8],
    ["Chicken sandwich", 9],
    ["Fries", 4],
    ["Rice bowl", 7],
    ["Salad", 4],
    ["Pizza", 12],
    ["Pasta", 10],
    ["Soup", 3],
  ].map(([name, minutes], i) => ({
    id: `m${i + 1}`,
    name: name as string,
    minutes: minutes as number,
  }));

export const emptyService = (): Service => ({
  version: 1,
  rev: 0,
  configured: false,
  name: "",
  stations: 2,
  graceMinutes: 5,
  packMinutes: 2,
  menu: starterMenu(),
  orders: [],
  queue: [],
  dismissedPlan: null,
  dismissedAt: null,
  protectedUntil: null,
  undo: [],
  shiftStartedAt: null,
  shifts: [],
});

export function isService(value: unknown): value is Service {
  const s = value as Service;
  return (
    !!s &&
    typeof s === "object" &&
    s.version === 1 &&
    Number.isInteger(s.rev) &&
    Array.isArray(s.orders) &&
    Array.isArray(s.queue) &&
    Array.isArray(s.menu) &&
    Array.isArray(s.undo) &&
    Array.isArray(s.shifts)
  );
}

/** Longest dish sets the pace; each further dish on the ticket adds a minute. */
export function estimatePrep(lines: { minutes: number; qty: number }[]) {
  const dishes = lines.reduce((n, l) => n + l.qty, 0);
  if (!dishes) return 0;
  return Math.max(...lines.map((l) => l.minutes)) + dishes - 1;
}

export const planKey = (sequence: string[]) => sequence.join(">");

const text = (value: unknown, max: number) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

function minutes(value: unknown, min: number, label: string) {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > MAX_MINUTES
  )
    throw new ServiceError(
      `${label} must be a whole number from ${min} to ${MAX_MINUTES}.`,
    );
  return value;
}

const totalPrep = (o: Order) => o.prep + o.extra;

function cleanSettings(settings: KitchenSettings): KitchenSettings {
  const name = text(settings?.name, 60);
  if (!name) throw new ServiceError("Enter the restaurant name.");
  const stations = settings.stations;
  if (!Number.isInteger(stations) || stations < 1 || stations > MAX_STATIONS)
    throw new ServiceError(`Stations must be from 1 to ${MAX_STATIONS}.`);
  const graceMinutes = settings.graceMinutes;
  if (!Number.isInteger(graceMinutes) || graceMinutes < 0 || graceMinutes > 60)
    throw new ServiceError("Pickup grace must be from 0 to 60 minutes.");
  const packMinutes = settings.packMinutes;
  if (!Number.isInteger(packMinutes) || packMinutes < 0 || packMinutes > 30)
    throw new ServiceError("Packing time must be from 0 to 30 minutes.");
  if (!Array.isArray(settings.menu))
    throw new ServiceError("The menu could not be read.");
  const menu = settings.menu
    .map((m) => ({ ...m, name: text(m?.name, 60) }))
    .filter((m) => m.name)
    .map((m, i) => ({
      id: text(m.id, 40) || `m${i + 1}-${m.name}`,
      name: m.name,
      minutes: minutes(m.minutes, 1, `Prep time for ${m.name}`),
    }));
  return { name, stations, graceMinutes, packMinutes, menu };
}

/**
 * An approval is only valid for the board it was shown on. Any change since then
 * (another device, a double tap, a courier update) means the numbers are stale.
 */
function checkBase(previous: Service, baseRev: unknown) {
  if (baseRev !== previous.rev)
    throw new ServiceError(
      "The board changed after this was proposed, so the numbers may be out of date. Ask again for a fresh proposal.",
    );
}

function find(s: Service, id: string, ...statuses: Order["status"][]) {
  const order = s.orders.find((o) => o.id === id);
  if (!order) throw new ServiceError("That order is no longer on the board.");
  if (!statuses.includes(order.status))
    throw new ServiceError(
      `#${order.ref} has already moved on. Check the board and try again.`,
    );
  return order;
}

function nextRef(s: Service) {
  const used = s.orders.map((o) => Number(o.ref)).filter(Number.isSafeInteger);
  return String(Math.max(1000, ...used) + 1);
}

function createOrder(
  s: Service,
  input: NewOrder,
  now: number,
  id: string,
  sample = false,
): Order {
  const items = text(input?.items, 300);
  if (!items) throw new ServiceError("Add at least one item.");
  const prep = minutes(input.prep, 1, "Prep time");
  const eta = minutes(input.etaMinutes, 0, "Courier arrival");
  const ref = text(input.ref, 20).replace(/^#/, "") || nextRef(s);
  const open = (o: Order) => o.status !== "done" && o.status !== "cancelled";
  if (s.orders.some((o) => open(o) && o.ref === ref))
    throw new ServiceError(`#${ref} is already on the board.`);
  const arrival = now + eta * MINUTE;
  return {
    id,
    ref,
    customer: text(input.customer, 60),
    items,
    prep,
    extra: 0,
    receivedAt: now,
    arrival,
    deadline: arrival + s.graceMinutes * MINUTE,
    status: "queued",
    ...(sample ? { sample } : {}),
  };
}

function firstFreeStation(s: Service) {
  const taken = new Set(
    s.orders.filter((o) => o.status === "cooking").map((o) => o.station),
  );
  for (let n = 1; n <= s.stations; n++) if (!taken.has(n)) return n;
  return null;
}

function remember(s: Service, label: string) {
  s.undo = [
    { label, orders: structuredClone(s.orders), queue: [...s.queue] },
    ...s.undo,
  ].slice(0, UNDO_DEPTH);
}

function sampleOrders(s: Service, now: number) {
  const rows = [
    { ref: "1042", customer: "Olivia R.", items: "2 × Rice bowl", prep: 10, etaMinutes: 6 },
    { ref: "1043", customer: "James K.", items: "1 × Pizza", prep: 12, etaMinutes: 22 },
    { ref: "1044", customer: "Maya S.", items: "2 × Salad", prep: 4, etaMinutes: 14 },
  ];
  for (const row of rows) {
    if (openOrders(s).some((o) => o.ref === row.ref)) continue;
    const order = createOrder(s, row, now, `sample-${row.ref}-${now}`, true);
    s.orders.push(order);
    s.queue.push(order.id);
  }
  const first = s.orders.find((o) => o.sample && o.status === "queued");
  const station = firstFreeStation(s);
  if (first && station) {
    first.status = "cooking";
    first.station = station;
    first.startedAt = now - 4 * MINUTE;
    s.queue = s.queue.filter((id) => id !== first.id);
  }
}

/** Applies one action. Returns a new state; never mutates its input. */
export function reduce(
  previous: Service,
  action: Action,
  now: number,
  id: () => string = () => crypto.randomUUID(),
): Service {
  const s = structuredClone(previous);
  const requireKitchen = () => {
    if (!s.configured) throw new ServiceError("Set up the kitchen first.");
  };
  switch (action?.type) {
    case "configure": {
      const next = cleanSettings(action.settings);
      const cooking = s.orders.filter((o) => o.status === "cooking");
      if (cooking.some((o) => o.station! > next.stations))
        throw new ServiceError(
          "A station being removed is still cooking. Finish that order first.",
        );
      // Undo could otherwise restore an order onto a station that no longer exists.
      if (next.stations < s.stations) s.undo = [];
      Object.assign(s, next, { configured: true });
      s.shiftStartedAt ??= now;
      break;
    }
    case "addOrder": {
      requireKitchen();
      const order = createOrder(s, action.order, now, id());
      remember(s, `add #${order.ref}`);
      s.orders.push(order);
      s.queue.push(order.id);
      break;
    }
    case "start": {
      const order = find(s, action.id, "queued");
      const station = firstFreeStation(s);
      if (!station)
        throw new ServiceError(
          "Every station is busy. Mark an order ready first.",
        );
      remember(s, `start #${order.ref}`);
      order.status = "cooking";
      order.station = station;
      order.startedAt = now;
      s.queue = s.queue.filter((q) => q !== order.id);
      break;
    }
    case "addTime": {
      const order = find(s, action.id, "queued", "cooking");
      const added = minutes(action.minutes, 1, "Added time");
      remember(s, `add ${added} min to #${order.ref}`);
      // An order already past its estimate gains time from now, not from the old estimate.
      if (order.status === "cooking") {
        const elapsed = Math.ceil((now - order.startedAt!) / MINUTE);
        order.extra = Math.max(totalPrep(order), elapsed) + added - order.prep;
      } else order.extra += added;
      break;
    }
    case "ready": {
      const order = find(s, action.id, "cooking");
      remember(s, `mark #${order.ref} ready`);
      order.status = "ready";
      order.readyAt = now;
      delete order.station;
      break;
    }
    case "pickedUp": {
      const order = find(s, action.id, "ready");
      remember(s, `hand off #${order.ref}`);
      order.status = "done";
      order.pickedUpAt = now;
      break;
    }
    case "courierEta": {
      const order = find(s, action.id, "queued", "cooking", "ready");
      const eta = minutes(action.minutes, 0, "Courier arrival");
      remember(s, `update courier for #${order.ref}`);
      const grace = order.deadline - order.arrival;
      order.arrival = now + eta * MINUTE;
      order.deadline = order.arrival + grace;
      delete order.courierHereAt;
      break;
    }
    case "courierHere": {
      const order = find(s, action.id, "queued", "cooking", "ready");
      remember(s, `courier here for #${order.ref}`);
      order.courierHereAt = now;
      // A late courier pushes the window back. An early one does not tighten
      // the promised handoff, but their wait starts now either way.
      if (now > order.arrival) order.deadline += now - order.arrival;
      order.arrival = now;
      break;
    }
    case "cancel": {
      const order = find(s, action.id, "queued", "cooking", "ready");
      remember(s, `cancel #${order.ref}`);
      order.status = "cancelled";
      delete order.station;
      s.queue = s.queue.filter((q) => q !== order.id);
      break;
    }
    case "move": {
      const order = find(s, action.id, "queued");
      const from = s.queue.indexOf(order.id);
      const to = from + action.direction;
      if (to < 0 || to >= s.queue.length) return previous;
      remember(s, `move #${order.ref}`);
      [s.queue[from], s.queue[to]] = [s.queue[to], s.queue[from]];
      break;
    }
    case "applyPlan": {
      const incoming = action.sequence;
      checkBase(previous, action.baseRev);
      if (
        !Array.isArray(incoming) ||
        incoming.length !== s.queue.length ||
        new Set(incoming).size !== incoming.length ||
        incoming.some((q) => !s.queue.includes(q))
      )
        throw new ServiceError(
          "The board changed while you were reviewing. Check the new plan.",
        );
      remember(s, "apply the recommended order");
      s.queue = [...incoming];
      s.dismissedPlan = null;
      s.protectedUntil = now + PROTECT_MS;
      break;
    }
    case "optimize": {
      remember(s, "apply the recommended order");
      s.queue = planFor(s, now).best.sequence;
      s.dismissedPlan = null;
      s.protectedUntil = now + PROTECT_MS;
      break;
    }
    case "batch": {
      checkBase(previous, action.baseRev);
      if (!Array.isArray(action.actions) || !action.actions.length)
        throw new ServiceError("There is nothing to apply.");
      if (action.actions.some((a) => a?.type === "batch" || a?.type === "undo"))
        throw new ServiceError("Those changes can't be applied together.");
      // All or nothing, and one Undo reverses the whole set.
      const next = action.actions.reduce(
        (state, a) => reduce(state, a, now, id),
        previous,
      );
      const before: Snapshot = {
        label: text(action.label, 80) || "approved changes",
        orders: structuredClone(previous.orders),
        queue: [...previous.queue],
      };
      return {
        ...next,
        rev: previous.rev + 1,
        undo:
          next.stations < previous.stations
            ? []
            : [before, ...previous.undo].slice(0, UNDO_DEPTH),
      };
    }
    case "dismissPlan":
      if (!Array.isArray(action.sequence))
        throw new ServiceError("That recommendation could not be read.");
      s.dismissedPlan = planKey(action.sequence);
      s.dismissedAt = now;
      break;
    case "undo": {
      const last = s.undo.shift();
      if (!last) throw new ServiceError("Nothing to undo.");
      s.orders = last.orders;
      s.queue = last.queue;
      break;
    }
    case "loadSample":
      requireKitchen();
      remember(s, "add sample orders");
      sampleOrders(s, now);
      break;
    case "clearSample": {
      remember(s, "clear sample orders");
      const gone = new Set(s.orders.filter((o) => o.sample).map((o) => o.id));
      s.orders = s.orders.filter((o) => !gone.has(o.id));
      s.queue = s.queue.filter((q) => !gone.has(q));
      break;
    }
    case "endShift": {
      const open = openOrders(s).filter((o) => !o.sample).length;
      if (open)
        throw new ServiceError(
          `${open} order${open === 1 ? " is" : "s are"} still open. Hand off or cancel them first.`,
        );
      s.shifts = [
        {
          ...report(s.orders),
          startedAt: s.shiftStartedAt ?? now,
          endedAt: now,
        },
        ...s.shifts,
      ].slice(0, 30);
      s.orders = [];
      s.queue = [];
      s.undo = [];
      s.dismissedPlan = null;
      s.dismissedAt = null;
      s.protectedUntil = null;
      s.shiftStartedAt = now;
      break;
    }
    default:
      throw new ServiceError("Unknown action.");
  }
  s.rev = previous.rev + 1;
  return s;
}

export const openOrders = (s: Service) =>
  s.orders.filter((o) => ["queued", "cooking", "ready"].includes(o.status));

const fromNow = (t: number, now: number) => Math.round((t - now) / MINUTE);

/** Translates live orders into planner jobs, in whole minutes from now. */
export function jobsFor(s: Service, now: number): Job[] {
  const pack = s.packMinutes ?? 0;
  return s.orders.flatMap((o): Job[] => {
    if (o.status !== "queued" && o.status !== "cooking") return [];
    const base = {
      id: o.id,
      arrival: fromNow(o.arrival, now),
      deadline: fromNow(o.deadline, now),
      received: fromNow(o.receivedAt, now),
      pack,
    };
    if (o.status === "queued") return [{ ...base, remaining: totalPrep(o) }];
    const end = o.startedAt! + totalPrep(o) * MINUTE;
    return [
      {
        ...base,
        // Past its estimate but not marked ready: assume it is about to finish.
        remaining: Math.max(1, Math.ceil((end - now) / MINUTE)),
        station: o.station,
      },
    ];
  });
}

export const planFor = (s: Service, now: number): Plan =>
  plan(jobsFor(s, now), s.queue, { stations: s.stations });

/** Recommendation worth showing, unless this exact one was already declined. */
export function recommendation(s: Service, p: Plan, now: number) {
  if (!p.shouldChange) return false;
  const declined =
    planKey(p.best.sequence) === s.dismissedPlan &&
    s.dismissedAt !== null &&
    now - s.dismissedAt < COOLDOWN_MS;
  if (declined) return false;
  // Just approved: do not reshuffle the task the kitchen is about to start.
  const protectedNow = s.protectedUntil !== null && now < s.protectedUntil;
  return !(protectedNow && p.best.sequence[0] !== s.queue[0]);
}

export const overdueMinutes = (o: Order, now: number) =>
  o.status === "cooking"
    ? Math.max(
        0,
        Math.floor((now - (o.startedAt! + totalPrep(o) * MINUTE)) / MINUTE),
      )
    : 0;

export const atTime = (now: number, minutesFromNow: number) =>
  now + minutesFromNow * MINUTE;

/** Actual results for finished orders. Sample orders never count. */
export function report(orders: Order[]): ShiftReport {
  const done = orders.filter((o) => o.readyAt !== undefined && !o.sample);
  const average = (xs: number[]) =>
    xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  const late = done.filter((o) => o.readyAt! > o.deadline).length;
  return {
    orders: done.length,
    onTime: done.length - late,
    late,
    avgCourierWait: average(
      done.map(
        (o) =>
          Math.max(0, o.readyAt! - (o.courierHereAt ?? o.arrival)) / MINUTE,
      ),
    ),
    avgOverrun: average(
      done.map((o) => (o.readyAt! - o.startedAt!) / MINUTE - o.prep),
    ),
  };
}

/** Plain-language status for the assistant. Facts only; works with no AI configured. */
export function brief(s: Service, now: number) {
  const open = openOrders(s);
  if (!open.length) return "The board is clear. No orders are open.";
  const name = new Map(s.orders.map((o) => [o.id, `#${o.ref}`]));
  const p = planFor(s, now);
  const clock = (slot: Slot) =>
    new Date(atTime(now, slot.end)).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
  const lines: string[] = [];
  const first = p.current.slots.find((x) => p.current.sequence[0] === x.id);
  if (first)
    lines.push(
      first.held
        ? `Next: ${name.get(first.id)}, which can wait ${first.start} min so it is not ready long before its courier.`
        : `Next: ${name.get(first.id)}.`,
    );
  else lines.push("Nothing is waiting to start.");
  if (p.shouldChange) {
    const m = (x: Plan["current"]) => x.metrics;
    lines.push(
      `Recommended order: ${p.best.sequence.map((i) => name.get(i)).join(" → ")}. Courier waiting ${m(p.current).wait} → ${m(p.best).wait} min, pickup lateness ${m(p.current).lateness} → ${m(p.best).lateness} min.`,
    );
  } else lines.push("The current order is already the best one found.");
  const slots = p.shouldChange ? p.best.slots : p.current.slots;
  const late = slots.filter((x) => x.late > 0);
  lines.push(
    late.length
      ? `Still late: ${late.map((x) => `${name.get(x.id)} by ${x.late} min (ready ${clock(x)})`).join(", ")}. Reordering cannot recover this time.`
      : "Every order is on track for its pickup window.",
  );
  return lines.join(" ");
}
