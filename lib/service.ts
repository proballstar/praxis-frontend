import { Job, Plan, Resource, Slot, plan } from "./engine";

/** Live state of one kitchen, and the rules for changing it. Pure: `now` is always passed in. */
export type KitchenResource = {
  id: string;
  name: string;
  /** How many dishes it can work on at once. */
  capacity: number;
  /** Units temporarily out of action. */
  down?: { units: number; until: number };
};

export type MenuItem = {
  id: string;
  name: string;
  minutes: number;
  resource: string;
  /** Minutes the dish stays at its best after finishing. A preference, not food safety. */
  qualityMinutes: number;
};

export type OrderItem = {
  id: string;
  name: string;
  note?: string;
  /** Estimated minutes of work when the order was entered. */
  minutes: number;
  /** Minutes added later because something went wrong. */
  extra: number;
  resource: string;
  qualityMinutes: number;
  status: "pending" | "cooking" | "done";
  startedAt?: number;
  doneAt?: number;
};

export type Order = {
  id: string;
  ref: string;
  customer: string;
  items: OrderItem[];
  receivedAt: number;
  /** Expected courier arrival. */
  arrival: number;
  deadline: number;
  /** False until someone has an actual courier time. */
  etaKnown: boolean;
  etaUpdatedAt: number;
  status: "queued" | "cooking" | "ready" | "done" | "cancelled";
  startedAt?: number;
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
  /** Observed minutes finished dishes waited for pickup. */
  avgFoodSitting: number | null;
  /** Dishes picked up after their quality window ended. */
  pastWindow: number;
};
export type PastShift = ShiftReport & { startedAt: number; endedAt: number };

type Snapshot = {
  label: string;
  orders: Order[];
  queue: string[];
  resources: KitchenResource[];
};

export type Service = {
  version: 2;
  rev: number;
  configured: boolean;
  name: string;
  resources: KitchenResource[];
  graceMinutes: number;
  /** Packing minutes between the last dish finishing and the order being ready. */
  packMinutes: number;
  /** Finish this many minutes ahead of the courier, as cover for overruns. */
  holdBufferMinutes: number;
  /** A courier time older than this needs confirming before holding for it. */
  staleEtaMinutes: number;
  menu: MenuItem[];
  orders: Order[];
  /** Tickets with nothing started, in the order the kitchen intends to cook them. */
  queue: string[];
  /** Recommendation the kitchen chose to ignore. */
  dismissedPlan: string | null;
  /** When the recommendation was declined. A declined plan stays quiet for a while. */
  dismissedAt: number | null;
  /** The newly approved first ticket is not second-guessed until this time. */
  protectedUntil: number | null;
  protectedId: string | null;
  undo: Snapshot[];
  shiftStartedAt: number | null;
  shifts: PastShift[];
};

export type KitchenSettings = Pick<
  Service,
  | "name"
  | "resources"
  | "graceMinutes"
  | "packMinutes"
  | "holdBufferMinutes"
  | "staleEtaMinutes"
  | "menu"
>;

export type OrderLine = {
  /** A menu dish. Without it, name, minutes and resource describe a one-off dish. */
  menuId?: string;
  name?: string;
  qty: number;
  minutes?: number;
  resource?: string;
  note?: string;
};

export type NewOrder = {
  ref?: string;
  customer?: string;
  lines: OrderLine[];
  /** Minutes until the courier arrives, or null when nobody knows yet. */
  etaMinutes: number | null;
};

export type Action =
  | { type: "configure"; settings: KitchenSettings }
  | { type: "addOrder"; order: NewOrder }
  | { type: "startItems"; id: string; itemIds?: string[] }
  | { type: "itemsDone"; id: string; itemIds?: string[] }
  | { type: "addTime"; id: string; minutes: number }
  | { type: "ready"; id: string }
  | { type: "pickedUp"; id: string }
  | { type: "courierEta"; id: string; minutes: number }
  | { type: "confirmEta"; id: string }
  | { type: "courierHere"; id: string }
  | { type: "cancel"; id: string }
  | { type: "move"; id: string; direction: -1 | 1 }
  | { type: "resourceDown"; resource: string; units: number; minutes: number }
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

const MAX_MINUTES = 240;
const MAX_RESOURCE_CAPACITY = 50;
const MAX_ITEMS_PER_ORDER = 60;
const UNDO_DEPTH = 10;
const MINUTE = 60_000;
/** A declined recommendation stays quiet this long. */
export const COOLDOWN_MS = 10 * MINUTE;
/** An approved plan's first ticket is protected this long. */
export const PROTECT_MS = 3 * MINUTE;
/** For one-off dishes and kitchens that have not set a window. */
export const DEFAULT_QUALITY = 15;

export const starterResources = (): KitchenResource[] => [
  { id: "grill", name: "Grill", capacity: 3 },
  { id: "fryer", name: "Fryer", capacity: 2 },
  { id: "oven", name: "Oven", capacity: 1 },
  { id: "assembly", name: "Assembly", capacity: 2 },
];

export const starterMenu = (): MenuItem[] =>
  (
    [
      ["Burger", 8, "grill", 12],
      ["Chicken sandwich", 9, "grill", 12],
      ["Fries", 4, "fryer", 6],
      ["Rice bowl", 7, "assembly", 20],
      ["Salad", 4, "assembly", 30],
      ["Pizza", 12, "oven", 15],
      ["Pasta", 10, "oven", 15],
      ["Soup", 3, "assembly", 25],
    ] as const
  ).map(([name, minutes, resource, qualityMinutes], i) => ({
    id: `m${i + 1}`,
    name,
    minutes,
    resource,
    qualityMinutes,
  }));

export const emptyService = (): Service => ({
  version: 2,
  rev: 0,
  configured: false,
  name: "",
  resources: starterResources(),
  graceMinutes: 5,
  packMinutes: 2,
  holdBufferMinutes: 2,
  staleEtaMinutes: 15,
  menu: starterMenu(),
  orders: [],
  queue: [],
  dismissedPlan: null,
  dismissedAt: null,
  protectedUntil: null,
  protectedId: null,
  undo: [],
  shiftStartedAt: null,
  shifts: [],
});

export function isService(value: unknown): value is Service {
  const s = value as Service;
  return (
    !!s &&
    typeof s === "object" &&
    s.version === 2 &&
    Number.isInteger(s.rev) &&
    Array.isArray(s.orders) &&
    Array.isArray(s.queue) &&
    Array.isArray(s.menu) &&
    Array.isArray(s.resources) &&
    Array.isArray(s.undo) &&
    Array.isArray(s.shifts)
  );
}

type V1Order = {
  id: string;
  ref: string;
  customer: string;
  items: string;
  prep: number;
  extra: number;
  receivedAt: number;
  arrival: number;
  deadline: number;
  status: Order["status"];
  startedAt?: number;
  readyAt?: number;
  courierHereAt?: number;
  pickedUpAt?: number;
  sample?: boolean;
};
type V1Service = {
  version: 1;
  rev: number;
  configured: boolean;
  name: string;
  stations: number;
  graceMinutes: number;
  packMinutes?: number;
  menu: { id: string; name: string; minutes: number }[];
  orders: V1Order[];
  queue: string[];
  dismissedPlan?: string | null;
  dismissedAt?: number | null;
  protectedUntil?: number | null;
  shiftStartedAt: number | null;
  shifts: PastShift[];
};

const LINE = "line";

/**
 * Upgrades a saved kitchen from whole-order stations to item-level resources.
 * Each old station becomes a unit of one "Line" resource, and each old order
 * becomes a single task, so running work keeps its timers.
 */
export function migrate(value: unknown, now: number): unknown {
  const old = value as V1Service;
  if (!old || old.version !== 1) return value;
  const orders = old.orders.map((o): Order => {
    const started = o.status !== "queued" && o.status !== "cancelled";
    const finished = o.status === "ready" || o.status === "done";
    return {
      id: o.id,
      ref: o.ref,
      customer: o.customer,
      items: [
        {
          id: `${o.id}-1`,
          name: o.items,
          minutes: o.prep,
          extra: o.extra,
          resource: LINE,
          qualityMinutes: DEFAULT_QUALITY,
          status: finished ? "done" : started ? "cooking" : "pending",
          ...(o.startedAt !== undefined ? { startedAt: o.startedAt } : {}),
          ...(o.readyAt !== undefined ? { doneAt: o.readyAt } : {}),
        },
      ],
      receivedAt: o.receivedAt,
      arrival: o.arrival,
      deadline: o.deadline,
      etaKnown: true,
      etaUpdatedAt: now,
      status: o.status,
      ...(o.startedAt !== undefined ? { startedAt: o.startedAt } : {}),
      ...(o.readyAt !== undefined ? { readyAt: o.readyAt } : {}),
      ...(o.courierHereAt !== undefined
        ? { courierHereAt: o.courierHereAt }
        : {}),
      ...(o.pickedUpAt !== undefined ? { pickedUpAt: o.pickedUpAt } : {}),
      ...(o.sample ? { sample: true } : {}),
    };
  });
  const upgraded: Service = {
    ...emptyService(),
    rev: old.rev,
    configured: old.configured,
    name: old.name,
    resources: old.configured
      ? [{ id: LINE, name: "Line", capacity: old.stations }]
      : starterResources(),
    graceMinutes: old.graceMinutes,
    packMinutes: old.packMinutes ?? 2,
    menu: old.configured
      ? old.menu.map((m) => ({
          ...m,
          resource: LINE,
          qualityMinutes: DEFAULT_QUALITY,
        }))
      : starterMenu(),
    orders,
    queue: old.queue,
    dismissedPlan: old.dismissedPlan ?? null,
    dismissedAt: old.dismissedAt ?? null,
    protectedUntil: old.protectedUntil ?? null,
    protectedId: old.protectedUntil ? (old.queue[0] ?? null) : null,
    shiftStartedAt: old.shiftStartedAt,
    shifts: old.shifts,
  };
  return upgraded;
}

export const planKey = (sequence: string[]) => sequence.join(">");

const text = (value: unknown, max: number) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

function minutes(value: unknown, min: number, label: string, max = MAX_MINUTES) {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  )
    throw new ServiceError(
      `${label} must be a whole number from ${min} to ${max}.`,
    );
  return value;
}

const totalMinutes = (i: OrderItem) => i.minutes + i.extra;

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

function cleanSettings(settings: KitchenSettings): KitchenSettings {
  const name = text(settings?.name, 60);
  if (!name) throw new ServiceError("Enter the restaurant name.");
  if (!Array.isArray(settings.resources) || !settings.resources.length)
    throw new ServiceError("Add at least one resource, such as a grill.");
  const resources = settings.resources.map((r) => {
    const label = text(r?.name, 40);
    if (!label) throw new ServiceError("Every resource needs a name.");
    return {
      id: text(r.id, 60) || slug(label) || crypto.randomUUID(),
      name: label,
      capacity: minutes(r.capacity, 1, `${label} capacity`, MAX_RESOURCE_CAPACITY),
      ...(r.down ? { down: r.down } : {}),
    };
  });
  if (new Set(resources.map((r) => r.id)).size !== resources.length)
    throw new ServiceError("Two resources have the same name.");
  const graceMinutes = minutes(settings.graceMinutes, 0, "Pickup grace", 60);
  const packMinutes = minutes(settings.packMinutes, 0, "Packing time", 30);
  const holdBufferMinutes = minutes(
    settings.holdBufferMinutes,
    0,
    "Preparation buffer",
    15,
  );
  const staleEtaMinutes = minutes(
    settings.staleEtaMinutes,
    5,
    "Courier time expiry",
    120,
  );
  if (!Array.isArray(settings.menu))
    throw new ServiceError("The menu could not be read.");
  const menu = settings.menu
    .map((m) => ({ ...m, name: text(m?.name, 60) }))
    .filter((m) => m.name)
    .map((m, i) => {
      if (!resources.some((r) => r.id === m.resource))
        throw new ServiceError(`Choose a resource for ${m.name}.`);
      return {
        id: text(m.id, 40) || `m${i + 1}-${m.name}`,
        name: m.name,
        minutes: minutes(m.minutes, 1, `Prep time for ${m.name}`),
        resource: m.resource,
        qualityMinutes: minutes(
          m.qualityMinutes,
          1,
          `Quality window for ${m.name}`,
        ),
      };
    });
  return {
    name,
    resources,
    graceMinutes,
    packMinutes,
    holdBufferMinutes,
    staleEtaMinutes,
    menu,
  };
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

const isOpen = (o: Order) =>
  o.status === "queued" || o.status === "cooking" || o.status === "ready";

function expandLine(s: Service, line: OrderLine, id: () => string): OrderItem[] {
  const qty = minutes(line?.qty, 1, "Quantity", MAX_ITEMS_PER_ORDER);
  const menu = line.menuId
    ? s.menu.find((m) => m.id === line.menuId)
    : undefined;
  if (line.menuId && !menu)
    throw new ServiceError("A dish on this order is no longer on the menu.");
  const name = menu?.name ?? text(line.name, 80);
  if (!name) throw new ServiceError("Every item needs a name.");
  const resource = menu?.resource ?? line.resource ?? s.resources[0].id;
  if (!s.resources.some((r) => r.id === resource))
    throw new ServiceError(`Choose a resource for ${name}.`);
  const prep = minutes(line.minutes ?? menu?.minutes, 1, `Prep time for ${name}`);
  const note = text(line.note, 120);
  return Array.from({ length: qty }, () => ({
    id: id(),
    name,
    ...(note ? { note } : {}),
    minutes: prep,
    extra: 0,
    resource,
    qualityMinutes: menu?.qualityMinutes ?? DEFAULT_QUALITY,
    status: "pending" as const,
  }));
}

function createOrder(
  s: Service,
  input: NewOrder,
  now: number,
  id: () => string,
  sample = false,
): Order {
  if (!Array.isArray(input?.lines) || !input.lines.length)
    throw new ServiceError("Add at least one item.");
  const items = input.lines.flatMap((l) => expandLine(s, l, id));
  if (items.length > MAX_ITEMS_PER_ORDER)
    throw new ServiceError(
      `An order can have up to ${MAX_ITEMS_PER_ORDER} dishes.`,
    );
  const etaKnown = input.etaMinutes !== null && input.etaMinutes !== undefined;
  const longest = Math.max(...items.map(totalMinutes));
  const eta = etaKnown
    ? minutes(input.etaMinutes, 0, "Courier arrival")
    : longest + s.packMinutes + s.holdBufferMinutes;
  const ref = text(input.ref, 20).replace(/^#/, "") || nextRef(s);
  if (s.orders.some((o) => isOpen(o) && o.ref === ref))
    throw new ServiceError(`#${ref} is already on the board.`);
  const arrival = now + eta * MINUTE;
  return {
    id: id(),
    ref,
    customer: text(input.customer, 60),
    items,
    receivedAt: now,
    arrival,
    deadline: arrival + s.graceMinutes * MINUTE,
    etaKnown,
    etaUpdatedAt: now,
    status: "queued",
    ...(sample ? { sample } : {}),
  };
}

/** Units of a resource working right now, across every order. */
export function inUse(s: Service, resource: string) {
  return s.orders
    .filter((o) => o.status === "cooking")
    .flatMap((o) => o.items)
    .filter((i) => i.status === "cooking" && i.resource === resource).length;
}

export function capacityNow(r: KitchenResource, now: number) {
  return r.down && now < r.down.until
    ? Math.max(0, r.capacity - r.down.units)
    : r.capacity;
}

function remember(s: Service, label: string) {
  s.undo = [
    {
      label,
      orders: structuredClone(s.orders),
      queue: [...s.queue],
      resources: structuredClone(s.resources),
    },
    ...s.undo,
  ].slice(0, UNDO_DEPTH);
}

function dropFromQueue(s: Service, id: string) {
  s.queue = s.queue.filter((q) => q !== id);
}

function startItem(item: OrderItem, order: Order, now: number) {
  item.status = "cooking";
  item.startedAt = now;
  order.status = "cooking";
  order.startedAt ??= now;
}

/** A believable rush from this kitchen's own menu. */
function sampleOrders(s: Service, now: number, id: () => string) {
  const dish = (name: string, fallback: number) =>
    s.menu.find((m) => m.name === name) ?? s.menu[fallback % s.menu.length];
  const line = (m: MenuItem | undefined, qty: number): OrderLine => ({
    menuId: m?.id,
    name: m ? undefined : "Sample dish",
    minutes: m ? undefined : 8,
    qty,
  });
  const rows: { ref: string; customer: string; lines: OrderLine[]; etaMinutes: number }[] = [
    {
      ref: "1042",
      customer: "Olivia R.",
      lines: [line(dish("Pizza", 0), 1)],
      etaMinutes: 10,
    },
    {
      ref: "1043",
      customer: "Noah B.",
      lines: [line(dish("Burger", 4), 2), line(dish("Fries", 3), 1)],
      etaMinutes: 14,
    },
    {
      ref: "1044",
      customer: "Maya S.",
      lines: [line(dish("Pizza", 2), 1), line(dish("Fries", 3), 2)],
      etaMinutes: 22,
    },
    {
      ref: "1045",
      customer: "James K.",
      lines: [line(dish("Pasta", 1), 1)],
      etaMinutes: 30,
    },
  ];
  for (const row of rows) {
    if (s.orders.some((o) => isOpen(o) && o.ref === row.ref)) continue;
    const order = createOrder(s, row, now, id, true);
    s.orders.push(order);
    s.queue.push(order.id);
  }
  const first = s.orders.find((o) => o.sample && o.status === "queued");
  if (first) {
    for (const item of first.items)
      if (inUse(s, item.resource) < capacityNow(resourceOf(s, item), now))
        startItem(item, first, now - 4 * MINUTE);
    if (first.status === "cooking") dropFromQueue(s, first.id);
  }
}

const resourceOf = (s: Service, item: OrderItem) =>
  s.resources.find((r) => r.id === item.resource)!;

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
      const kept = new Set(next.resources.map((r) => r.id));
      const orphan = openOrders(s)
        .flatMap((o) => o.items)
        .find((i) => i.status !== "done" && !kept.has(i.resource));
      if (orphan)
        throw new ServiceError(
          `${orphan.name} is still on the board and needs a resource being removed.`,
        );
      // Undo could otherwise restore work onto a resource that no longer exists.
      if (s.resources.some((r) => !kept.has(r.id))) s.undo = [];
      Object.assign(s, next, { configured: true });
      s.shiftStartedAt ??= now;
      break;
    }
    case "addOrder": {
      requireKitchen();
      const order = createOrder(s, action.order, now, id);
      remember(s, `add #${order.ref}`);
      s.orders.push(order);
      s.queue.push(order.id);
      break;
    }
    case "startItems": {
      const order = find(s, action.id, "queued", "cooking");
      const pending = order.items.filter(
        (i) =>
          i.status === "pending" &&
          (!action.itemIds || action.itemIds.includes(i.id)),
      );
      if (!pending.length)
        throw new ServiceError(`Nothing left to start on #${order.ref}.`);
      remember(s, `start #${order.ref}`);
      let full: string | null = null;
      let started = 0;
      for (const item of pending) {
        const resource = resourceOf(s, item);
        if (inUse(s, item.resource) >= capacityNow(resource, now)) {
          full = resource.name;
          continue;
        }
        startItem(item, order, now);
        started++;
      }
      if (!started) {
        s.undo.shift();
        throw new ServiceError(
          `The ${full?.toLowerCase()} is full. Finish a dish there first.`,
        );
      }
      dropFromQueue(s, order.id);
      break;
    }
    case "itemsDone": {
      const order = find(s, action.id, "cooking");
      const cooking = order.items.filter(
        (i) =>
          i.status === "cooking" &&
          (!action.itemIds || action.itemIds.includes(i.id)),
      );
      if (!cooking.length)
        throw new ServiceError(`Nothing is cooking on #${order.ref}.`);
      remember(s, `finish dishes on #${order.ref}`);
      for (const item of cooking) {
        item.status = "done";
        item.doneAt = now;
      }
      break;
    }
    case "addTime": {
      const order = find(s, action.id, "queued", "cooking");
      const added = minutes(action.minutes, 1, "Added time");
      const open = order.items.filter((i) => i.status !== "done");
      if (!open.length)
        throw new ServiceError(`Every dish on #${order.ref} is finished.`);
      remember(s, `add ${added} min to #${order.ref}`);
      for (const item of open) {
        // A dish already past its estimate gains time from now, not from the old estimate.
        if (item.status === "cooking") {
          const elapsed = Math.ceil((now - item.startedAt!) / MINUTE);
          item.extra = Math.max(totalMinutes(item), elapsed) + added - item.minutes;
        } else item.extra += added;
      }
      break;
    }
    case "ready": {
      const order = find(s, action.id, "cooking");
      if (order.items.some((i) => i.status === "pending"))
        throw new ServiceError(
          `#${order.ref} still has dishes to start.`,
        );
      remember(s, `mark #${order.ref} ready`);
      for (const item of order.items)
        if (item.status === "cooking") {
          item.status = "done";
          item.doneAt = now;
        }
      order.status = "ready";
      order.readyAt = now;
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
      order.etaKnown = true;
      order.etaUpdatedAt = now;
      delete order.courierHereAt;
      break;
    }
    case "confirmEta": {
      const order = find(s, action.id, "queued", "cooking", "ready");
      if (!order.etaKnown)
        throw new ServiceError(`Enter a courier time for #${order.ref}.`);
      remember(s, `confirm courier for #${order.ref}`);
      order.etaUpdatedAt = now;
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
      order.etaKnown = true;
      order.etaUpdatedAt = now;
      break;
    }
    case "cancel": {
      const order = find(s, action.id, "queued", "cooking", "ready");
      remember(s, `cancel #${order.ref}`);
      order.status = "cancelled";
      dropFromQueue(s, order.id);
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
    case "resourceDown": {
      const resource = s.resources.find((r) => r.id === action.resource);
      if (!resource) throw new ServiceError("That resource doesn't exist.");
      const units = minutes(action.units, 0, "Units out", resource.capacity);
      remember(s, `${resource.name} ${units ? "down" : "back"}`);
      if (!units) delete resource.down;
      else
        resource.down = {
          units,
          until:
            now + minutes(action.minutes, 1, "Time out of action") * MINUTE,
        };
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
      s.protectedId = s.queue[0] ?? null;
      break;
    }
    case "optimize": {
      remember(s, "apply the recommended order");
      s.queue = planFor(s, now).best.sequence;
      s.dismissedPlan = null;
      s.protectedUntil = now + PROTECT_MS;
      s.protectedId = s.queue[0] ?? null;
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
        resources: structuredClone(previous.resources),
      };
      return {
        ...next,
        rev: previous.rev + 1,
        undo: [before, ...previous.undo].slice(0, UNDO_DEPTH),
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
      s.resources = last.resources;
      break;
    }
    case "loadSample":
      requireKitchen();
      remember(s, "add sample orders");
      sampleOrders(s, now, id);
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
      s.protectedId = null;
      s.shiftStartedAt = now;
      break;
    }
    default:
      throw new ServiceError("Unknown action.");
  }
  s.rev = previous.rev + 1;
  return s;
}

export const openOrders = (s: Service) => s.orders.filter(isOpen);

const fromNow = (t: number, now: number) => Math.round((t - now) / MINUTE);

export type EtaStatus = "here" | "live" | "stale" | "unknown";

/** How far the courier time can be trusted before planning around it. */
export function etaStatus(s: Service, o: Order, now: number): EtaStatus {
  if (o.courierHereAt !== undefined) return "here";
  if (!o.etaKnown) return "unknown";
  const old = now - o.etaUpdatedAt > s.staleEtaMinutes * MINUTE;
  return old || now > o.arrival ? "stale" : "live";
}

/** Translates live orders into planner jobs, in whole minutes from now. */
export function jobsFor(s: Service, now: number): Job[] {
  return s.orders.flatMap((o): Job[] => {
    if (o.status !== "queued" && o.status !== "cooking") return [];
    const status = etaStatus(s, o, now);
    return [
      {
        id: o.id,
        arrival: fromNow(o.arrival, now),
        deadline: fromNow(o.deadline, now),
        received: fromNow(o.receivedAt, now),
        pack: s.packMinutes,
        holdable: status === "live",
        tasks: o.items.map((i) => {
          const base = {
            id: i.id,
            resource: i.resource,
            quality: i.qualityMinutes,
          };
          if (i.status === "pending")
            return { ...base, state: "pending", minutes: totalMinutes(i) };
          if (i.status === "done")
            return {
              ...base,
              state: "done",
              minutes: 0,
              finished: Math.min(0, fromNow(i.doneAt!, now)),
            };
          const end = i.startedAt! + totalMinutes(i) * MINUTE;
          return {
            ...base,
            state: "cooking",
            // Past its estimate but not marked done: assume it is about to finish.
            minutes: Math.max(1, fromNow(end, now)),
          };
        }),
      },
    ];
  });
}

export function resourcesFor(s: Service, now: number): Resource[] {
  return s.resources.map((r) => ({
    id: r.id,
    capacity: r.capacity,
    ...(r.down && now < r.down.until
      ? {
          down: {
            units: r.down.units,
            until: Math.ceil((r.down.until - now) / MINUTE),
          },
        }
      : {}),
  }));
}

export const planFor = (s: Service, now: number): Plan =>
  plan(jobsFor(s, now), s.queue, {
    resources: resourcesFor(s, now),
    holdBuffer: s.holdBufferMinutes,
  });

/** Recommendation worth showing, unless it was just declined or would undo an approval. */
export function recommendation(s: Service, p: Plan, now: number) {
  if (!p.shouldChange) return false;
  const declined =
    planKey(p.best.sequence) === s.dismissedPlan &&
    s.dismissedAt !== null &&
    now - s.dismissedAt < COOLDOWN_MS;
  if (declined) return false;
  // Just approved: do not reshuffle the task the kitchen is about to start.
  const protectedNow =
    s.protectedUntil !== null &&
    now < s.protectedUntil &&
    s.queue[0] === s.protectedId;
  return !(protectedNow && p.best.sequence[0] !== s.queue[0]);
}

export function itemOverdue(i: OrderItem, now: number) {
  return i.status === "cooking"
    ? Math.max(
        0,
        Math.floor((now - (i.startedAt! + totalMinutes(i) * MINUTE)) / MINUTE),
      )
    : 0;
}

/** "2 × Burger, 1 × Fries", grouping identical dishes. */
export function itemsText(items: OrderItem[]) {
  const groups = new Map<string, number>();
  for (const i of items) {
    const key = i.note ? `${i.name} (${i.note})` : i.name;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return [...groups].map(([name, qty]) => `${qty} × ${name}`).join(", ");
}

/** Pending dishes the plan wants started now. */
export function dueItems(o: Order, slot: Slot | undefined) {
  if (!slot) return [];
  const due = new Set(slot.tasks.filter((t) => t.start <= 0).map((t) => t.id));
  return o.items.filter((i) => i.status === "pending" && due.has(i.id));
}

export const atTime = (now: number, minutesFromNow: number) =>
  now + minutesFromNow * MINUTE;

/** Actual results for finished orders. Sample orders never count. */
export function report(orders: Order[]): ShiftReport {
  const done = orders.filter((o) => o.readyAt !== undefined && !o.sample);
  const average = (xs: number[]) =>
    xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
  const late = done.filter((o) => o.readyAt! > o.deadline).length;
  const dishes = done.flatMap((o) =>
    o.items
      .filter((i) => i.doneAt !== undefined)
      .map((item) => ({ order: o, item })),
  );
  const picked = dishes.filter((d) => d.order.pickedUpAt !== undefined);
  const sitting = ({ order, item }: (typeof dishes)[number]) =>
    Math.max(0, order.pickedUpAt! - item.doneAt!) / MINUTE;
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
      dishes
        .filter((d) => d.item.startedAt !== undefined)
        .map(
          ({ item }) =>
            (item.doneAt! - item.startedAt!) / MINUTE - item.minutes,
        ),
    ),
    avgFoodSitting: average(picked.map(sitting)),
    pastWindow: picked.filter((d) => sitting(d) > d.item.qualityMinutes).length,
  };
}

/** Plain-language status for the assistant. Facts only; works with no AI configured. */
export function brief(s: Service, now: number) {
  const open = openOrders(s);
  if (!open.length) return "The board is clear. No orders are open.";
  const name = new Map(s.orders.map((o) => [o.id, `#${o.ref}`]));
  const p = planFor(s, now);
  const clock = (slot: Slot) =>
    new Date(atTime(now, slot.ready)).toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    });
  const lines: string[] = [];
  const firstId = p.current.sequence[0];
  const first = p.current.slots.find((x) => x.id === firstId);
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
