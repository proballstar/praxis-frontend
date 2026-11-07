import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Db, bumpRev, copyDb, getRev, loadConfig } from "./db";
import {
  addTimeToOrder,
  cancelOrder,
  createOrder,
  setCapacity,
  updateEta,
} from "./engine";
import { replan } from "./planner";
import { MINUTE_MS } from "./time";
import { OrderView, buildSnapshot } from "./snapshot";
import { OrderRow, TkError } from "./types";

/**
 * Changes that can be tried on a private copy and, once someone approves, applied.
 * Deliberately limited: nothing here releases, starts, completes, packs or hands
 * off food. Those stay with people.
 */
export type Change = {
  kind:
    | "driver_eta"
    | "add_time"
    | "equipment"
    | "staff"
    | "new_order"
    | "cancel_order";
  /** Order number, for driver_eta, add_time and cancel_order. */
  order?: number;
  /** driver_eta: minutes until arrival. add_time: extra minutes. equipment/staff: minutes out. */
  minutes?: number;
  /** equipment: a station name. staff: a staff group name. */
  resource?: string;
  /** Units out of action. 0 means it is back. */
  units?: number;
  channel?: "delivery" | "walk_in" | "phone";
  items?: { name: string; qty: number; modifiers?: string[] }[];
  customer?: string;
};

export type OrderOutcome = {
  number: number;
  channel: string;
  status: string;
  added: boolean;
  before: {
    bagReadyMs: number | null;
    risk: string;
    minutesAfterTarget: number | null;
  } | null;
  after: {
    bagReadyMs: number | null;
    risk: string;
    minutesAfterTarget: number | null;
  };
  /** Positive means later. Null when it can't be compared. */
  deltaMinutes: number | null;
};

export type Simulation = {
  baseRev: number;
  lines: string[];
  orders: OrderOutcome[];
  earlier: { number: number; minutes: number }[];
  later: { number: number; minutes: number }[];
  newAtRisk: number[];
  recovered: number[];
  warnings: string[];
  solver: { status: string; ms: number };
  summary: string;
  /** Orders whose issued plan stays unchanged even though the estimate moved. */
  lockedUnchanged: number[];
};

const openOrderByNumber = (db: Db, n: number | undefined) => {
  const o = db.get<OrderRow>(
    "SELECT * FROM orders WHERE number = ? AND status IN ('DRAFT','RELEASED')",
    n ?? -1,
  );
  if (!o) throw new TkError(`No open order #${n ?? "?"}.`, "not_found", 404);
  return o;
};

const find = <T extends { id: string; name: string }>(
  list: T[],
  name: string | undefined,
  what: string,
) => {
  const key = (name ?? "").trim().toLowerCase();
  const found = list.find(
    (x) => x.id.toLowerCase() === key || x.name.toLowerCase() === key,
  );
  if (!found)
    throw new TkError(`No ${what} called "${name ?? ""}".`, "not_found", 404);
  return found;
};

const need = (v: number | undefined, label: string) => {
  if (v === undefined)
    throw new TkError(`${label} is required.`, "invalid", 422);
  return v;
};

/** Applies one change inside the caller's transaction. */
export function applyChange(db: Db, c: Change, now: number): string {
  const config = loadConfig(db);
  switch (c.kind) {
    case "driver_eta": {
      const o = openOrderByNumber(db, c.order);
      const minutes = need(c.minutes, "Minutes until the driver arrives");
      updateEta(
        db,
        { orderId: o.id, minutesFromNow: minutes, source: "manual" },
        now,
      );
      return `Driver for #${o.number} arrives in ${minutes} min`;
    }
    case "add_time": {
      const o = openOrderByNumber(db, c.order);
      const minutes = need(c.minutes, "Extra minutes");
      addTimeToOrder(db, o.id, minutes);
      return `#${o.number} needs ${minutes} more min`;
    }
    case "equipment": {
      const st = find(config.stations, c.resource, "station");
      const units = need(c.units, "Units out");
      setCapacity(
        db,
        {
          kind: "station",
          id: st.id,
          unitsOut: units,
          minutes: units ? need(c.minutes, "Minutes out") : undefined,
        },
        now,
      );
      return units
        ? `${st.name}: ${units} of ${st.capacity} out for ${c.minutes} min`
        : `${st.name} is back`;
    }
    case "staff": {
      const pool = find(config.pools, c.resource, "staff group");
      const units = need(c.units, "Staff out");
      setCapacity(
        db,
        {
          kind: "pool",
          id: pool.id,
          unitsOut: units,
          minutes: units ? need(c.minutes, "Minutes out") : undefined,
        },
        now,
      );
      return units
        ? `${pool.name}: ${units} of ${pool.capacity} out for ${c.minutes} min`
        : `${pool.name} are back`;
    }
    case "new_order": {
      if (!c.items?.length)
        throw new TkError("Add at least one item.", "invalid", 422);
      const channel = c.channel ?? "walk_in";
      const minutes = need(c.minutes, "Minutes until pickup");
      createOrder(
        db,
        {
          channel,
          customer: c.customer,
          items: c.items.map((i) => ({
            recipe: i.name,
            qty: i.qty,
            modifiers: i.modifiers,
          })),
          ...(channel === "delivery"
            ? { etaMinutes: minutes }
            : { promisedMinutes: minutes }),
        },
        now,
      );
      return `New ${channel.replace("_", "-")} draft: ${c.items.map((i) => `${i.qty} × ${i.name}`).join(", ")}, pickup in ${minutes} min`;
    }
    case "cancel_order": {
      const o = openOrderByNumber(db, c.order);
      cancelOrder(db, o.id, false);
      return `Cancel #${o.number}`;
    }
    default:
      throw new TkError("Unknown change.", "invalid", 422);
  }
}

const brief = (o: OrderView) => ({
  bagReadyMs: o.plan.bagReadyMs,
  risk: o.plan.risk,
  minutesAfterTarget: o.plan.minutesAfterTarget,
});

function compare(before: OrderView[], after: OrderView[]) {
  const was = new Map(before.map((o) => [o.number, o]));
  const orders: OrderOutcome[] = after
    .filter((o) => o.status === "DRAFT" || o.status === "RELEASED")
    .map((o) => {
      const b = was.get(o.number);
      const delta =
        b && b.plan.bagReadyMs !== null && o.plan.bagReadyMs !== null
          ? Math.round((o.plan.bagReadyMs - b.plan.bagReadyMs) / MINUTE_MS)
          : null;
      return {
        number: o.number,
        channel: o.channel,
        status: o.status,
        added: !b,
        before: b ? brief(b) : null,
        after: brief(o),
        deltaMinutes: delta,
      };
    });
  return orders;
}

const names = (xs: number[]) => xs.map((n) => `#${n}`).join(", ");

/** One deterministic sentence per effect, naming who gains and who pays. */
export function summarize(
  s: Pick<
    Simulation,
    "earlier" | "later" | "newAtRisk" | "recovered" | "lockedUnchanged"
  >,
) {
  const parts: string[] = [];
  if (s.later.length)
    parts.push(
      `Later: ${s.later.map((x) => `#${x.number} by ${x.minutes} min`).join(", ")}.`,
    );
  if (s.earlier.length)
    parts.push(
      `Earlier: ${s.earlier.map((x) => `#${x.number} by ${x.minutes} min`).join(", ")}.`,
    );
  if (s.newAtRisk.length) parts.push(`Becomes at risk: ${names(s.newAtRisk)}.`);
  if (s.recovered.length)
    parts.push(`No longer at risk: ${names(s.recovered)}.`);
  if (s.lockedUnchanged.length)
    parts.push(`Issued receipts stay as printed: ${names(s.lockedUnchanged)}.`);
  return parts.join(" ") || "No predicted change to any order.";
}

/**
 * Tries changes on an isolated copy of the database and reports what would
 * move. The live kitchen is never touched.
 */
export async function simulate(db: Db, changes: Change[]): Promise<Simulation> {
  if (!changes.length)
    throw new TkError("No changes were given.", "invalid", 422);
  const before = await buildSnapshot(db);
  const file = path.join(tmpdir(), `praxis-sim-${randomUUID()}.db`);
  const copy = copyDb(db, file);
  try {
    const now = db.now();
    const lines = copy.tx(() => {
      const out = changes.map((c) => applyChange(copy, c, now));
      bumpRev(copy);
      return out;
    });
    const solve = await replan(copy, "what-if");
    const after = await buildSnapshot(copy);
    const orders = compare(before.orders, after.orders);
    const moved = orders.filter((o) => !o.added && o.deltaMinutes);
    const wasRisk = new Map(before.orders.map((o) => [o.number, o.plan.risk]));
    const frozen = new Set(
      before.orders.filter((o) => o.status === "RELEASED").map((o) => o.number),
    );
    const lockedUnchanged = orders
      .filter((o) => frozen.has(o.number) && o.status === "RELEASED")
      .map((o) => o.number)
      .filter((n) => {
        const b = before.orders.find((o) => o.number === n)!;
        const a = after.orders.find((o) => o.number === n)!;
        return (
          JSON.stringify(
            b.tasks.map((t) => [t.plannedStartMs, t.stationId]),
          ) ===
          JSON.stringify(a.tasks.map((t) => [t.plannedStartMs, t.stationId]))
        );
      });
    const partial = {
      earlier: moved
        .filter((o) => o.deltaMinutes! < 0)
        .map((o) => ({ number: o.number, minutes: -o.deltaMinutes! })),
      later: moved
        .filter((o) => o.deltaMinutes! > 0)
        .map((o) => ({ number: o.number, minutes: o.deltaMinutes! })),
      newAtRisk: orders
        .filter(
          (o) =>
            o.after.risk === "at_risk" && wasRisk.get(o.number) !== "at_risk",
        )
        .map((o) => o.number),
      recovered: orders
        .filter(
          (o) =>
            o.after.risk !== "at_risk" && wasRisk.get(o.number) === "at_risk",
        )
        .map((o) => o.number),
      lockedUnchanged: lockedUnchanged.filter(
        (n) =>
          orders.find((o) => o.number === n)?.after.risk === "at_risk" ||
          orders.find((o) => o.number === n)?.deltaMinutes,
      ),
    };
    return {
      baseRev: getRev(db),
      lines,
      orders,
      ...partial,
      warnings: after.warnings,
      solver: { status: solve.status, ms: solve.ms },
      summary: summarize(partial),
    };
  } finally {
    copy.raw.close();
    for (const suffix of ["", "-wal", "-shm"])
      rmSync(file + suffix, { force: true });
  }
}

const KINDS = [
  "driver_eta",
  "add_time",
  "equipment",
  "staff",
  "new_order",
  "cancel_order",
] as const;

/** Validates changes that arrive from the browser or the assistant. */
export function cleanChanges(input: unknown): Change[] {
  if (!Array.isArray(input) || !input.length || input.length > 10)
    throw new TkError("Give between 1 and 10 changes.", "invalid", 422);
  const num = (v: unknown, min: number, max: number, label: string) => {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max)
      throw new TkError(
        `${label} must be a whole number from ${min} to ${max}.`,
        "invalid",
        422,
      );
    return v;
  };
  return input.map((raw) => {
    const c = raw as Record<string, unknown>;
    if (
      !c ||
      typeof c !== "object" ||
      Array.isArray(c) ||
      !KINDS.includes(c.kind as (typeof KINDS)[number])
    )
      throw new TkError("Unknown change.", "invalid", 422);
    const out: Change = { kind: c.kind as Change["kind"] };
    out.order = num(c.order, 1, 1_000_000, "Order number");
    out.minutes = num(c.minutes, 0, 720, "Minutes");
    out.units = num(c.units, 0, 50, "Units");
    for (const field of ["resource", "customer"] as const) {
      if (c[field] !== undefined && typeof c[field] !== "string")
        throw new TkError(`${field} must be text.`, "invalid", 422);
    }
    if (
      c.channel !== undefined &&
      !["delivery", "walk_in", "phone"].includes(c.channel as string)
    )
      throw new TkError("Unknown order channel.", "invalid", 422);
    if (typeof c.resource === "string")
      out.resource = c.resource.trim().slice(0, 40);
    if (typeof c.customer === "string")
      out.customer = c.customer.trim().slice(0, 60);
    if (
      c.channel === "delivery" ||
      c.channel === "walk_in" ||
      c.channel === "phone"
    )
      out.channel = c.channel;
    if (c.items !== undefined) {
      if (!Array.isArray(c.items) || c.items.length > 12)
        throw new TkError("An order can have up to 12 lines.", "invalid", 422);
      out.items = c.items.map((i: Record<string, unknown>) => {
        if (
          !i ||
          typeof i !== "object" ||
          typeof i.name !== "string" ||
          !i.name.trim()
        )
          throw new TkError("Each item needs a name.", "invalid", 422);
        if (
          i.modifiers !== undefined &&
          (!Array.isArray(i.modifiers) ||
            i.modifiers.length > 6 ||
            i.modifiers.some((m) => typeof m !== "string"))
        )
          throw new TkError(
            "Modifiers must be a list of up to 6 notes.",
            "invalid",
            422,
          );
        return {
          name: i.name.trim().slice(0, 60),
          qty: num(i.qty, 1, 20, "Quantity") ?? 1,
          modifiers: (i.modifiers as string[] | undefined)
            ?.map((m) => m.trim().slice(0, 40))
            .filter(Boolean),
        };
      });
    }
    if (["driver_eta", "add_time", "cancel_order"].includes(out.kind))
      need(out.order, "Order number");
    if (["driver_eta", "add_time", "new_order"].includes(out.kind))
      need(out.minutes, "Minutes");
    if (out.kind === "equipment" || out.kind === "staff") {
      if (!out.resource)
        throw new TkError("A resource is required.", "invalid", 422);
      need(out.units, "Units out");
      if (out.units) need(out.minutes, "Minutes out");
    }
    if (out.kind === "new_order" && !out.items?.length)
      throw new TkError("Add at least one item.", "invalid", 422);
    return out;
  });
}

export type Proposal = Simulation & { changes: Change[] };
