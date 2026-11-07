import { Db, bumpRev, getRev, loadConfig, logEvent, saveConfig, syncShelf } from "./db";
import { validateConfig } from "./config";
import { replan } from "./planner";
import { MINUTE_MS, TICK_MS, alignUp, minutesToTicks } from "./time";
import { bagReadyMs, orderTiming } from "./timing";
import {
  Channel,
  Config,
  EstimateRow,
  ItemRow,
  OrderRow,
  Recipe,
  TaskRow,
  TkError,
} from "./types";

/* ------------------------------------------------------------------ */
/* Serialization, atomic operations and idempotency                    */
/* ------------------------------------------------------------------ */

const chains = new WeakMap<Db, Promise<unknown>>();

/** Runs one job at a time per database, so two taps can never interleave. */
export function serial<T>(db: Db, job: () => Promise<T> | T): Promise<T> {
  const previous = chains.get(db) ?? Promise.resolve();
  const run = previous.then(() => job());
  chains.set(db, run.catch(() => undefined));
  return run;
}

export type Meta = { requestId?: string; actor?: string };
type Plan = "now" | "soon" | false;

const queued = new WeakSet<Db>();

/** Re-plans drafts in the background, collapsing a burst of taps into one solve. */
function planSoon(db: Db, reason: string) {
  if (queued.has(db)) return;
  queued.add(db);
  void serial(db, async () => {
    queued.delete(db);
    await replan(db, reason);
    db.tx(() => syncOutbound(db));
  }).catch(() => undefined);
}

/**
 * The one way state changes. The change and its idempotency record commit
 * together; a repeated request id returns the first answer without acting again.
 */
export function execute<T extends object>(
  db: Db,
  opts: { reason: string; plan?: Plan; meta?: Meta },
  change: (now: number) => T,
): Promise<T & { replayed?: boolean }> {
  return serial(db, async () => {
    const now = db.now();
    const key = opts.meta?.requestId;
    const outcome = db.tx(() => {
      if (key) {
        const seen = db.get<{ response: string }>("SELECT response FROM idempotency WHERE key = ?", key);
        if (seen) return { replayed: true as const, value: JSON.parse(seen.response) as T };
      }
      const value = change(now);
      bumpRev(db);
      if (key) {
        db.run("INSERT INTO idempotency(key, response, ts_ms) VALUES(?, ?, ?)", key, JSON.stringify(value), now);
        db.run("DELETE FROM idempotency WHERE ts_ms < ?", now - 24 * 60 * MINUTE_MS);
      }
      return { replayed: false as const, value };
    });
    if (outcome.replayed) return { ...outcome.value, replayed: true };
    const plan = opts.plan ?? "soon";
    if (plan === "now") await replan(db, opts.reason);
    db.tx(() => syncOutbound(db));
    if (plan === "soon") planSoon(db, opts.reason);
    return outcome.value;
  });
}

/* ------------------------------------------------------------------ */
/* Reading helpers                                                      */
/* ------------------------------------------------------------------ */

const need = <T>(value: T | undefined, message: string, code = "not_found", status = 404): T => {
  if (value === undefined) throw new TkError(message, code, status);
  return value;
};

export const getOrder = (db: Db, id: string) =>
  need(db.get<OrderRow>("SELECT * FROM orders WHERE id = ?", id), "That order doesn't exist.");

export const orderTasks = (db: Db, orderId: string) =>
  db.all<TaskRow>("SELECT * FROM tasks WHERE order_id = ? ORDER BY created_ms, id", orderId);

export const orderItems = (db: Db, orderId: string) =>
  db.all<ItemRow>("SELECT * FROM items WHERE order_id = ? ORDER BY line", orderId);

const estimateOf = (db: Db, orderId: string) =>
  db.get<EstimateRow>("SELECT * FROM driver_estimates WHERE order_id = ?", orderId);

/** The restaurant's count policy: ordered items, drinks included. Extras and remakes are not counted. */
export const itemCount = (items: ItemRow[]) => items.reduce((n, i) => n + i.qty, 0);

const isFoodTask = (t: TaskRow) => t.kind !== "pack";

/* ------------------------------------------------------------------ */
/* Mock outbound log (no network, ever)                                */
/* ------------------------------------------------------------------ */

/** Records the ready time that would be sent to DoorDash. In mock mode nothing leaves this process. */
export function sendReadyTime(db: Db, orderId: string, readyMs: number, reason: string) {
  db.run(
    "INSERT INTO outbound_log(ts_ms, order_id, ready_ms, reason, mode) VALUES(?, ?, ?, ?, 'mock')",
    db.now(),
    orderId,
    readyMs,
    reason,
  );
  db.run("UPDATE orders SET last_sent_ready_ms = ? WHERE id = ?", readyMs, orderId);
}

/** Sends a new estimate when it has moved by more than two minutes. */
export function syncOutbound(db: Db) {
  const now = db.now();
  const released = db.all<OrderRow>(
    "SELECT * FROM orders WHERE status = 'RELEASED' AND channel = 'delivery'",
  );
  for (const o of released) {
    const est = bagReadyMs(orderTasks(db, o.id), now);
    if (est === null) continue;
    if (o.last_sent_ready_ms === null || Math.abs(est - o.last_sent_ready_ms) > 2 * MINUTE_MS)
      sendReadyTime(db, o.id, est, o.last_sent_ready_ms === null ? "released" : "estimate_changed");
  }
}

/* ------------------------------------------------------------------ */
/* Creating orders                                                      */
/* ------------------------------------------------------------------ */

export type NewItem = {
  recipe?: string;
  /** For a dish that isn't on the menu: its name, station and minutes. */
  name?: string;
  station?: string;
  minutes?: number;
  qty: number;
  modifiers?: string[];
  allergen?: string;
};

export type NewOrder = {
  channel: Channel;
  customer?: string;
  items: NewItem[];
  /** Delivery: minutes until the driver arrives. */
  etaMinutes?: number;
  arrivalMs?: number;
  /** In person or phone: minutes until the promised pickup. */
  promisedMinutes?: number;
  promisedMs?: number;
  driverName?: string;
  driverId?: string;
  pickupCode?: string;
  allergen?: string;
  reminders?: string[];
  source?: string;
  earlyS?: number;
  lateS?: number;
  sample?: boolean;
};

const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const MAX_LINES = 12;
const MAX_QTY = 20;
const MAX_TASKS = 80;

const channelSource: Record<Channel, string> = {
  delivery: "DoorDash",
  walk_in: "Walk-in",
  phone: "Phone",
};

function findRecipe(config: Config, item: NewItem): Recipe | null {
  const key = text(item.recipe ?? item.name, 60).toLowerCase();
  return (
    config.recipes.find((r) => r.id.toLowerCase() === key || r.name.toLowerCase() === key) ?? null
  );
}

export function createOrder(db: Db, input: NewOrder, now: number): { orderId: string; number: number } {
  const config = loadConfig(db);
  if (!config.configured) throw new TkError("Set up the kitchen first.", "not_configured");
  if (!["delivery", "walk_in", "phone"].includes(input?.channel))
    throw new TkError("Choose delivery, walk-in or phone.", "invalid", 422);
  if (!Array.isArray(input.items) || !input.items.length)
    throw new TkError("Add at least one item.", "invalid", 422);
  if (input.items.length > MAX_LINES)
    throw new TkError(`An order can have up to ${MAX_LINES} lines.`, "invalid", 422);

  const number = (db.get<{ n: number | null }>("SELECT MAX(number) AS n FROM orders")?.n ?? 100) + 1;
  const orderId = crypto.randomUUID();
  const orderAllergen = text(input.allergen, 200);
  const anyItemAllergen = input.items.some((i) => text(i.allergen, 120));
  const allergenFlag = orderAllergen || anyItemAllergen ? 1 : 0;

  const pickup = text(input.pickupCode, 12).toUpperCase() || `A${number}`;
  if (db.get("SELECT 1 FROM orders WHERE pickup_code = ? AND status IN ('DRAFT','RELEASED','SEALED')", pickup))
    throw new TkError(`Pickup code ${pickup} is already in use.`, "duplicate_code", 409);

  let promisedMs: number | null = null;
  let arrivalMs = 0;
  if (input.channel === "delivery") {
    arrivalMs =
      input.arrivalMs ?? now + (input.etaMinutes ?? config.defaultEtaMinutes) * MINUTE_MS;
  } else {
    promisedMs =
      input.promisedMs ?? now + (input.promisedMinutes ?? config.defaultEtaMinutes) * MINUTE_MS;
  }
  for (const t of [arrivalMs || promisedMs!]) {
    if (!Number.isFinite(t) || t < now - 30 * MINUTE_MS || t > now + 6 * 60 * MINUTE_MS)
      throw new TkError("That pickup time is out of range.", "invalid", 422);
  }

  db.run(
    `INSERT INTO orders(id, number, channel, source, customer, pickup_code, created_ms, promised_ms, status,
       allergen_flag, allergen_note, reminders, driver_name, driver_id, sample)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?)`,
    orderId,
    number,
    input.channel,
    text(input.source, 30) || channelSource[input.channel],
    text(input.customer, 60) || "Guest",
    pickup,
    now,
    promisedMs,
    allergenFlag,
    orderAllergen,
    JSON.stringify((input.reminders ?? config.reminders).map((r) => text(r, 40)).filter(Boolean)),
    text(input.driverName, 60),
    text(input.driverId, 40),
    input.sample ? 1 : 0,
  );
  if (input.channel === "delivery")
    db.run(
      "INSERT INTO driver_estimates(order_id, arrival_ms, updated_ms, early_s, late_s, source) VALUES(?, ?, ?, ?, ?, ?)",
      orderId,
      arrivalMs,
      now,
      input.earlyS ?? config.uncertainty.earlyS,
      input.lateS ?? config.uncertainty.lateS,
      input.sample ? "simulated" : input.etaMinutes === undefined && input.arrivalMs === undefined ? "default" : "manual",
    );

  let seq = 0;
  const allTaskIds: string[] = [];
  const newTaskId = () => {
    if (++seq > MAX_TASKS) throw new TkError("That order has too many components.", "invalid", 422);
    return `${orderId}:t${seq}`;
  };
  const insertTask = (t: Omit<TaskRow, "created_ms" | "extra_ticks">) => {
    const id = t.id;
    db.run(
      `INSERT INTO tasks(id, order_id, item_id, name, kind, station_id, duration_ticks, extra_ticks, modifiers,
         allergen_note, deps, status, planned_start_ms, planned_end_ms, actual_start_ms, actual_end_ms,
         start_inferred, released_version, batch_id, remake_of, urgent, portion, created_ms)
       VALUES(?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'PLANNED', NULL, NULL, NULL, NULL, 0, NULL, ?, ?, ?, ?, ?)`,
      id,
      t.order_id,
      t.item_id,
      t.name,
      t.kind,
      t.station_id,
      t.duration_ticks,
      t.modifiers,
      t.allergen_note,
      t.deps,
      t.batch_id,
      t.remake_of,
      t.urgent,
      t.portion,
      now + seq,
    );
    return id;
  };

  input.items.forEach((raw, index) => {
    const qty = raw?.qty;
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY)
      throw new TkError(`Quantity must be a whole number from 1 to ${MAX_QTY}.`, "invalid", 422);
    const recipe = findRecipe(config, raw);
    let steps = recipe?.steps;
    let name = recipe?.name ?? text(raw.name, 60);
    if (!recipe) {
      const station = config.stations.find((s) => s.id === raw.station);
      const minutes = raw.minutes;
      if (!name || !station || !Number.isInteger(minutes) || minutes! < 1 || minutes! > 120)
        throw new TkError(
          `"${name || "That dish"}" isn't on the menu. Give it a station and a prep time from 1 to 120 minutes.`,
          "unknown_dish",
          422,
        );
      steps = [{ id: "one", name: `Prepare ${name}`, station: station.id, ticks: minutesToTicks(minutes!), after: [] }];
    }
    const modifiers = (raw.modifiers ?? []).map((m) => text(m, 40)).filter(Boolean).slice(0, 6);
    const itemAllergen = text(raw.allergen, 120);
    const itemId = `${orderId}:i${index + 1}`;
    db.run(
      "INSERT INTO items(id, order_id, line, name, qty, recipe_id, category, modifiers, allergen_note) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)",
      itemId,
      orderId,
      index + 1,
      name,
      qty,
      recipe?.id ?? "",
      recipe?.category ?? "food",
      JSON.stringify(modifiers),
      itemAllergen,
    );

    // Modifier rules change a step's time. Anything unrecognised is still shown.
    const adjust = (stepId: string, firstStep: boolean) =>
      (recipe?.modifiers ?? [])
        .filter((r) => modifiers.some((m) => m.toLowerCase() === r.name))
        .filter((r) => (r.step ? r.step === stepId : firstStep))
        .reduce((n, r) => n + r.addTicks, 0);

    // Plain portions of a batchable step may share one run. Modifiers and allergies never do.
    const mayBatch = modifiers.length === 0 && !itemAllergen && !allergenFlag;
    const batchIds = new Map<string, string>();
    steps!.forEach((step, si) => {
      const st = config.stations.find((s) => s.id === step.station);
      if (!mayBatch || !step.batchable || !st?.batchMax) return;
      for (let p = 0; p < qty; p++) {
        const group = Math.floor(p / st.batchMax);
        const size = Math.min(st.batchMax, qty - group * st.batchMax);
        if (size > 1) batchIds.set(`${step.id}:${p}`, `${itemId}:${si}:b${group}`);
      }
    });

    for (let portion = 0; portion < qty; portion++) {
      const idOf = new Map<string, string>();
      steps!.forEach((step, si) => {
        const taskId = newTaskId();
        idOf.set(step.id, taskId);
        insertTask({
          id: taskId,
          order_id: orderId,
          item_id: itemId,
          name: step.name,
          kind: "food",
          station_id: step.station,
          duration_ticks: Math.max(1, step.ticks + adjust(step.id, si === 0)),
          modifiers: JSON.stringify(modifiers),
          allergen_note: itemAllergen || orderAllergen,
          deps: JSON.stringify(step.after.map((a) => idOf.get(a)).filter(Boolean)),
          status: "PLANNED",
          planned_start_ms: null,
          planned_end_ms: null,
          actual_start_ms: null,
          actual_end_ms: null,
          start_inferred: 0,
          released_version: null,
          batch_id: batchIds.get(`${step.id}:${portion}`) ?? null,
          remake_of: null,
          urgent: 0,
          portion: portion + 1,
        });
        allTaskIds.push(taskId);
      });
    }
  });

  insertTask({
    id: newTaskId(),
    order_id: orderId,
    item_id: null,
    name: "Check and bag",
    kind: "pack",
    station_id: config.packStation,
    duration_ticks: config.packTicks,
    modifiers: "[]",
    allergen_note: orderAllergen,
    deps: JSON.stringify(allTaskIds),
    status: "PLANNED",
    planned_start_ms: null,
    planned_end_ms: null,
    actual_start_ms: null,
    actual_end_ms: null,
    start_inferred: 0,
    released_version: null,
    batch_id: null,
    remake_of: null,
    urgent: 0,
    portion: 1,
  });
  logEvent(db, "order_created", { orderId, payload: { number, channel: input.channel } });
  return { orderId, number };
}

/* ------------------------------------------------------------------ */
/* Driver estimates                                                     */
/* ------------------------------------------------------------------ */

export type EtaInput = {
  orderId: string;
  minutesFromNow?: number;
  arrivalMs?: number;
  earlyS?: number;
  lateS?: number;
  source?: string;
};

/** Only drafts move when an estimate changes. Issued receipts stay as printed and warn instead. */
export function updateEta(db: Db, input: EtaInput, now: number) {
  const order = getOrder(db, input.orderId);
  if (order.channel !== "delivery")
    throw new TkError("Only delivery orders have a driver estimate. Walk-in times are promised.", "not_delivery");
  if (order.status !== "DRAFT" && order.status !== "RELEASED")
    throw new TkError("That order is already packed.", "closed");
  const arrival =
    input.arrivalMs ??
    (input.minutesFromNow === undefined ? undefined : now + input.minutesFromNow * MINUTE_MS);
  if (arrival === undefined || !Number.isFinite(arrival) || arrival < now - 30 * MINUTE_MS || arrival > now + 6 * 60 * MINUTE_MS)
    throw new TkError("Enter a driver arrival within the next six hours.", "invalid", 422);
  const old = estimateOf(db, order.id);
  const config = loadConfig(db);
  db.run(
    `INSERT INTO driver_estimates(order_id, arrival_ms, updated_ms, early_s, late_s, source) VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(order_id) DO UPDATE SET arrival_ms = excluded.arrival_ms, updated_ms = excluded.updated_ms,
       early_s = excluded.early_s, late_s = excluded.late_s, source = excluded.source`,
    order.id,
    arrival,
    now,
    input.earlyS ?? old?.early_s ?? config.uncertainty.earlyS,
    input.lateS ?? old?.late_s ?? config.uncertainty.lateS,
    text(input.source, 20) || "manual",
  );
  logEvent(db, "eta_updated", {
    orderId: order.id,
    payload: { from: old?.arrival_ms ?? null, to: arrival, status: order.status },
  });
  return { orderId: order.id, locked: order.status === "RELEASED" };
}

/* ------------------------------------------------------------------ */
/* Release, withdraw, cancel                                            */
/* ------------------------------------------------------------------ */

/** A manager releases a draft. Start, station, duration and batch are frozen from here on. */
export function issueOrder(db: Db, orderId: string, now: number) {
  const order = getOrder(db, orderId);
  if (order.status === "RELEASED") return { orderId, version: order.plan_version, alreadyReleased: true };
  if (order.status !== "DRAFT") throw new TkError("That order can't be released.", "bad_state");
  const tasks = orderTasks(db, orderId);
  const unplanned = tasks.filter((t) => t.status === "PLANNED" && t.planned_start_ms === null);
  if (unplanned.length)
    throw new TkError(
      "This order has no plan yet. Wait for planning to finish, or check the solver message.",
      "no_plan",
    );
  const stale = tasks.some((t) => t.status === "PLANNED" && t.planned_start_ms! < alignUp(now) - TICK_MS);
  if (stale)
    throw new TkError("The plan is out of date. Planning again, then try once more.", "stale_plan");
  db.run(
    "UPDATE tasks SET status = 'ISSUED', released_version = ? WHERE order_id = ? AND status = 'PLANNED'",
    order.plan_version,
    orderId,
  );
  db.run(
    "UPDATE orders SET status = 'RELEASED', released_ms = ?, withdrawn_note = '' WHERE id = ?",
    now,
    orderId,
  );
  logEvent(db, "released", { orderId, payload: { version: order.plan_version } });
  if (order.channel === "delivery") {
    const est = bagReadyMs(orderTasks(db, orderId), now);
    if (est !== null) sendReadyTime(db, orderId, est, "released");
  }
  return { orderId, version: order.plan_version, alreadyReleased: false };
}

/**
 * Takes back the instructions staff have not started, so a replacement can be
 * issued. Work already cooking or done stays exactly as recorded.
 */
export function withdrawOrder(db: Db, orderId: string, reason: string, now: number) {
  const order = getOrder(db, orderId);
  if (order.status !== "RELEASED")
    throw new TkError("Only a released order can be withdrawn.", "bad_state");
  const note = text(reason, 200);
  if (!note) throw new TkError("Say why, so staff know what changed.", "reason_required", 422);
  const tasks = orderTasks(db, orderId);
  if (tasks.some((t) => t.kind === "pack" && t.status !== "ISSUED"))
    throw new TkError("Packing has already started on this order.", "bad_state");
  const withdrawn = tasks.filter((t) => t.status === "ISSUED");
  db.run(
    "UPDATE tasks SET status = 'PLANNED', released_version = NULL WHERE order_id = ? AND status = 'ISSUED'",
    orderId,
  );
  db.run(
    "UPDATE orders SET status = 'DRAFT', plan_version = plan_version + 1, withdrawn_note = ? WHERE id = ?",
    `Replaces version ${order.plan_version}: ${note}`,
    orderId,
  );
  logEvent(db, "withdrawn", {
    orderId,
    payload: { reason: note, tasks: withdrawn.length, fromVersion: order.plan_version },
  });
  return { orderId, withdrawn: withdrawn.length, now };
}

export function cancelOrder(db: Db, orderId: string, force: boolean) {
  const order = getOrder(db, orderId);
  if (order.status === "CANCELLED") return { orderId };
  if (order.status === "HANDED_OFF") throw new TkError("That order was already handed off.", "bad_state");
  const started = orderTasks(db, orderId).some((t) => t.status === "COOKING" || t.status === "DONE");
  if (started && !force)
    throw new TkError("Food is already being made for this order. Confirm to cancel it anyway.", "started", 409);
  db.run("UPDATE orders SET status = 'CANCELLED', cancelled_ms = ?, shelf_slot = NULL WHERE id = ?", db.now(), orderId);
  db.run("UPDATE shelf SET order_id = NULL WHERE order_id = ?", orderId);
  logEvent(db, "cancelled", { orderId, payload: { started } });
  return { orderId };
}

/* ------------------------------------------------------------------ */
/* Station workflow                                                     */
/* ------------------------------------------------------------------ */

export type TaskAction = {
  taskId: string;
  action: "start" | "done" | "reopen" | "extend";
  /** A batch moves together, so one tap updates every portion in it. */
  scope?: "task" | "batch";
  /** A manager finishing a task before its configured time, with a reason. */
  managerOverride?: boolean;
  reason?: string;
  minutes?: number;
};

const dueMs = (t: TaskRow) => (t.duration_ticks + t.extra_ticks) * TICK_MS;

export function taskAction(db: Db, input: TaskAction, now: number) {
  const task = need(db.get<TaskRow>("SELECT * FROM tasks WHERE id = ?", input.taskId), "That task doesn't exist.");
  const order = getOrder(db, task.order_id);
  if (task.kind === "pack")
    throw new TkError("Packing is finished from the Packing view.", "wrong_place", 400);
  if (order.status === "DRAFT")
    throw new TkError("Release this order before starting work on it.", "not_released");
  if (order.status !== "RELEASED")
    throw new TkError("That order is already packed.", "closed");

  const group =
    input.scope === "batch" && task.batch_id
      ? db.all<TaskRow>("SELECT * FROM tasks WHERE batch_id = ? ORDER BY id", task.batch_id)
      : [task];
  const all = orderTasks(db, order.id);
  const byId = new Map(all.map((t) => [t.id, t]));
  const changed: string[] = [];
  const reason = text(input.reason, 200);

  for (const t of group) {
    const waiting = (JSON.parse(t.deps) as string[])
      .map((d) => byId.get(d))
      .find((d) => d && d.status !== "DONE");
    if (input.action === "start") {
      if (t.status === "COOKING") continue;
      if (t.status === "DONE") throw new TkError("That item is already finished.", "bad_state");
      if (waiting) throw new TkError(`Wait for "${waiting.name}" to be marked done first.`, "dependency");
      db.run("UPDATE tasks SET status = 'COOKING', actual_start_ms = ?, start_inferred = 0 WHERE id = ?", now, t.id);
      logEvent(db, "task_started", { orderId: order.id, taskId: t.id, actor: "staff" });
      changed.push(t.id);
    } else if (input.action === "done") {
      if (t.status === "DONE") continue;
      if (waiting) throw new TkError(`Wait for "${waiting.name}" to be marked done first.`, "dependency");
      // One tap on an unstarted task infers a start. That is recorded as inferred, not observed.
      const inferred = t.status === "ISSUED";
      const start = inferred ? t.planned_start_ms! : t.actual_start_ms!;
      const earliestDone = start + dueMs(t) - TICK_MS;
      let override = false;
      if (now < earliestDone) {
        if (!(input.managerOverride && reason))
          throw new TkError(
            `Not ready yet: ${Math.max(1, Math.ceil((earliestDone + TICK_MS - now) / MINUTE_MS))} min left. A manager can override with a reason.`,
            "too_early",
          );
        override = true;
      }
      db.run(
        "UPDATE tasks SET status = 'DONE', actual_end_ms = ?, actual_start_ms = ?, start_inferred = ? WHERE id = ?",
        now,
        inferred ? Math.min(start, now) : start,
        inferred ? 1 : t.start_inferred,
        t.id,
      );
      logEvent(db, "task_done", {
        orderId: order.id,
        taskId: t.id,
        payload: { inferredStart: inferred, override, reason: override ? reason : undefined },
      });
      if (override) logEvent(db, "early_done_override", { orderId: order.id, taskId: t.id, payload: { reason } });
      changed.push(t.id);
    } else if (input.action === "reopen") {
      if (t.status !== "DONE") continue;
      db.run("UPDATE tasks SET status = 'COOKING', actual_end_ms = NULL WHERE id = ?", t.id);
      logEvent(db, "task_reopened", { orderId: order.id, taskId: t.id, payload: { reason } });
      changed.push(t.id);
    } else if (input.action === "extend") {
      const minutes = input.minutes;
      if (!Number.isInteger(minutes) || minutes! < 1 || minutes! > 60)
        throw new TkError("Add between 1 and 60 minutes.", "invalid", 422);
      if (t.status !== "COOKING")
        throw new TkError("Time can only be added to something that's cooking.", "bad_state");
      db.run("UPDATE tasks SET extra_ticks = extra_ticks + ? WHERE id = ?", minutesToTicks(minutes!), t.id);
      logEvent(db, "task_extended", { orderId: order.id, taskId: t.id, payload: { minutes } });
      changed.push(t.id);
    }
  }
  return { taskIds: changed, orderId: order.id };
}

/**
 * "This order needs more time." Cooking dishes run longer and drafts are replanned
 * with longer durations. Issued dishes that haven't started stay as printed.
 */
export function addTimeToOrder(db: Db, orderId: string, mins: number) {
  const order = getOrder(db, orderId);
  if (order.status !== "DRAFT" && order.status !== "RELEASED")
    throw new TkError("That order is already packed.", "closed");
  if (!Number.isInteger(mins) || mins < 1 || mins > 60)
    throw new TkError("Add between 1 and 60 minutes.", "invalid", 422);
  const tasks = orderTasks(db, orderId).filter((t) => t.kind !== "pack" && t.status !== "DONE");
  const movable = tasks.filter((t) => t.status === "COOKING" || t.status === "PLANNED");
  if (!movable.length)
    throw new TkError(
      tasks.length
        ? "Those items are issued and haven't started. Withdraw the receipt to change their times, or wait until they start."
        : "Everything on that order is already finished.",
      "frozen",
    );
  for (const t of movable)
    db.run("UPDATE tasks SET extra_ticks = extra_ticks + ? WHERE id = ?", minutesToTicks(mins), t.id);
  logEvent(db, "time_added", { orderId, payload: { minutes: mins, tasks: movable.length } });
  return { orderId, tasks: movable.length };
}

/* ------------------------------------------------------------------ */
/* Packing, shelf and pickup                                            */
/* ------------------------------------------------------------------ */

export const checkKeys = (items: ItemRow[], order: OrderRow) => [
  ...items.map((i) => `item:${i.id}`),
  ...(JSON.parse(order.reminders) as string[]).map((r) => `rem:${r}`),
];

export const readyToPack = (tasks: TaskRow[]) => {
  const food = tasks.filter(isFoodTask);
  return food.length > 0 && food.every((t) => t.status === "DONE");
};

export function setCheck(db: Db, orderId: string, key: string, checked: boolean, now: number) {
  const order = getOrder(db, orderId);
  if (order.status !== "RELEASED") throw new TkError("That order isn't being packed.", "bad_state");
  const tasks = orderTasks(db, orderId);
  if (!readyToPack(tasks))
    throw new TkError("Every item must be finished before packing can start.", "not_ready");
  if (!checkKeys(orderItems(db, orderId), order).includes(key))
    throw new TkError("That isn't on this order's checklist.", "invalid", 422);
  db.run(
    `INSERT INTO checks(order_id, key, checked, checked_ms) VALUES(?, ?, ?, ?)
     ON CONFLICT(order_id, key) DO UPDATE SET checked = excluded.checked, checked_ms = excluded.checked_ms`,
    orderId,
    key,
    checked ? 1 : 0,
    now,
  );
  const pack = tasks.find((t) => t.kind === "pack")!;
  if (pack.status === "ISSUED")
    db.run("UPDATE tasks SET status = 'COOKING', actual_start_ms = ? WHERE id = ?", now, pack.id);
  return { orderId, key, checked };
}

export function acknowledgeAllergen(db: Db, orderId: string, acknowledged: boolean) {
  const order = getOrder(db, orderId);
  if (order.status !== "RELEASED") throw new TkError("That order isn't being packed.", "bad_state");
  db.run("UPDATE orders SET allergen_ack = ? WHERE id = ?", acknowledged ? 1 : 0, orderId);
  logEvent(db, "allergen_ack", { orderId, payload: { acknowledged } });
  return { orderId, acknowledged };
}

const firstName = (name: string) => name.trim().split(/\s+/)[0]?.toLowerCase() ?? "";

export function sealOrder(db: Db, orderId: string, input: { count: number; allergenAck?: boolean }, now: number) {
  const order = getOrder(db, orderId);
  if (order.status === "SEALED")
    return { orderId, slot: order.shelf_slot!, warnings: [] as string[], label: labelFor(db, order), alreadySealed: true };
  if (order.status !== "RELEASED") throw new TkError("That order can't be sealed.", "bad_state");
  const tasks = orderTasks(db, orderId);
  if (!readyToPack(tasks)) throw new TkError("Every item must be finished first.", "not_ready");
  const items = orderItems(db, orderId);
  const checks = new Map(
    db.all<{ key: string; checked: number }>("SELECT key, checked FROM checks WHERE order_id = ?", orderId).map((c) => [c.key, c.checked]),
  );
  const missing = checkKeys(items, order).filter((k) => !checks.get(k));
  if (missing.length)
    throw new TkError("Check every item and extra before sealing.", "checks_incomplete");
  if (order.allergen_flag && !(order.allergen_ack || input.allergenAck))
    throw new TkError("Confirm the allergen check before sealing.", "allergen_ack_required");
  const expected = itemCount(items);
  if (input.count !== expected)
    throw new TkError(`The bag should hold ${expected} item${expected === 1 ? "" : "s"}. Count again.`, "count_mismatch", 422);

  // The next free slot is claimed by one statement, so two seals can never share a slot.
  let slot = order.shelf_slot;
  const held = db.get<{ slot: string }>("SELECT slot FROM shelf WHERE order_id = ?", orderId);
  if (held) slot = held.slot;
  else {
    const claimed = db.run(
      "UPDATE shelf SET order_id = ? WHERE slot = (SELECT slot FROM shelf WHERE order_id IS NULL ORDER BY idx LIMIT 1) AND order_id IS NULL",
      orderId,
    );
    if (!claimed.changes) throw new TkError("The shelf is full. Hand off a bag first.", "shelf_full");
    slot = db.get<{ slot: string }>("SELECT slot FROM shelf WHERE order_id = ?", orderId)!.slot;
  }
  const pack = tasks.find((t) => t.kind === "pack")!;
  db.run(
    "UPDATE tasks SET status = 'DONE', actual_end_ms = ?, actual_start_ms = COALESCE(actual_start_ms, ?) WHERE id = ?",
    now,
    now,
    pack.id,
  );
  db.run(
    "UPDATE orders SET status = 'SEALED', sealed_ms = ?, shelf_slot = ?, allergen_ack = ? WHERE id = ?",
    now,
    slot,
    order.allergen_flag ? 1 : 0,
    orderId,
  );

  const mine = firstName(order.customer);
  const warnings = db
    .all<OrderRow>("SELECT * FROM orders WHERE status = 'SEALED' AND id != ?", orderId)
    .filter((o) => {
      const other = firstName(o.customer);
      return other && mine && (other === mine || (other.length >= 3 && mine.length >= 3 && other.slice(0, 3) === mine.slice(0, 3)));
    })
    .map((o) => `Another bag on the shelf (${o.shelf_slot}, order #${o.number}) is for "${o.customer}". Check the name at handoff.`);

  const config = loadConfig(db);
  const timing = orderTiming(order, estimateOf(db, orderId), config, now);
  logEvent(db, "sealed", {
    orderId,
    payload: {
      slot,
      targetMs: timing.targetMs,
      expectedMs: timing.expectedMs,
      minutesAfterTarget: Math.round((now - timing.targetMs) / MINUTE_MS),
    },
  });
  if (order.channel === "delivery") sendReadyTime(db, orderId, now, "ready_now");
  return {
    orderId,
    slot: slot!,
    warnings,
    label: labelFor(db, getOrder(db, orderId)),
    alreadySealed: false,
  };
}

export function labelFor(db: Db, order: OrderRow) {
  return {
    slot: order.shelf_slot ?? "",
    number: order.number,
    customer: order.customer,
    channel: order.source,
    count: itemCount(orderItems(db, order.id)),
  };
}

const normalizeCode = (code: unknown) => text(code, 12).toUpperCase();

export type PickupLookup =
  | { match: false; message: string }
  | {
      match: true;
      orderId: string;
      number: number;
      customer: string;
      state: "sealed" | "not_sealed" | "handed_off";
      slot?: string;
      minutesRemaining?: number | null;
      message: string;
    };

/** Reading only. Entering a code never changes an order. */
export function lookupPickup(db: Db, code: unknown, now: number): PickupLookup {
  const c = normalizeCode(code);
  const order = c
    ? db.get<OrderRow>(
        "SELECT * FROM orders WHERE pickup_code = ? AND status != 'CANCELLED' ORDER BY created_ms DESC LIMIT 1",
        c,
      )
    : undefined;
  if (!order || order.status === "DRAFT") return { match: false, message: "No matching order, check the app." };
  const base = { match: true as const, orderId: order.id, number: order.number, customer: order.customer };
  if (order.status === "HANDED_OFF")
    return { ...base, state: "handed_off", message: `Order #${order.number} was already handed off.` };
  if (order.status === "SEALED")
    return { ...base, state: "sealed", slot: order.shelf_slot!, message: `Order #${order.number} is on shelf ${order.shelf_slot}.` };
  const est = bagReadyMs(orderTasks(db, order.id), now);
  const minutes = est === null ? null : Math.max(0, Math.ceil((est - now) / MINUTE_MS));
  return {
    ...base,
    state: "not_sealed",
    minutesRemaining: minutes,
    message:
      minutes === null
        ? `Order #${order.number} isn't ready yet.`
        : `Order #${order.number} isn't sealed yet. About ${minutes} min to go.`,
  };
}

export function handoff(db: Db, orderId: string, code: unknown, now: number) {
  const order = getOrder(db, orderId);
  if (order.status === "HANDED_OFF") return { orderId, slot: order.shelf_slot, alreadyHandedOff: true };
  if (order.status !== "SEALED") throw new TkError("That bag isn't sealed yet.", "not_sealed");
  if (normalizeCode(code) !== order.pickup_code) {
    logEvent(db, "handoff_rejected", { orderId });
    // The rejection is kept even though the request fails.
    throw new TkError("That pickup code doesn't match this order.", "wrong_code", 403);
  }
  db.run("UPDATE orders SET status = 'HANDED_OFF', handed_off_ms = ? WHERE id = ?", now, orderId);
  db.run("UPDATE shelf SET order_id = NULL WHERE order_id = ?", orderId);
  logEvent(db, "handed_off", { orderId, payload: { slot: order.shelf_slot } });
  return { orderId, slot: order.shelf_slot, alreadyHandedOff: false };
}

/* ------------------------------------------------------------------ */
/* Remakes                                                              */
/* ------------------------------------------------------------------ */

export type RemakeInput = {
  orderId: string;
  itemId: string;
  /** Which portion of the line to remake. Defaults to the first. */
  portion?: number;
  reason: string;
  /** Required to reopen a bag that is already sealed. */
  managerException?: boolean;
};

/**
 * Creates linked remake tasks for one missing item. The original history stays.
 * Other issued work is untouched, and the missing item's check is cleared.
 */
export function createRemake(db: Db, input: RemakeInput, now: number) {
  const order = getOrder(db, input.orderId);
  const reason = text(input.reason, 200);
  if (!reason) throw new TkError("Say what was missing.", "reason_required", 422);
  if (order.status === "HANDED_OFF")
    throw new TkError("That bag was already handed off. Create a new order instead.", "bad_state");
  if (order.status === "DRAFT") throw new TkError("Release this order before remaking anything.", "not_released");
  if (order.status !== "RELEASED" && order.status !== "SEALED")
    throw new TkError("That order can't be remade.", "bad_state");
  if (order.status === "SEALED") {
    if (!input.managerException)
      throw new TkError("This bag is sealed. A manager must approve reopening it.", "manager_exception", 403);
    const pack = orderTasks(db, order.id).find((t) => t.kind === "pack")!;
    db.run("UPDATE orders SET status = 'RELEASED', sealed_ms = NULL WHERE id = ?", order.id);
    db.run("UPDATE tasks SET status = 'ISSUED', actual_end_ms = NULL WHERE id = ?", pack.id);
    logEvent(db, "seal_reopened", { orderId: order.id, payload: { reason } });
  }
  const item = need(
    orderItems(db, order.id).find((i) => i.id === input.itemId),
    "That item isn't on this order.",
  );
  const portion = input.portion ?? 1;
  const originals = orderTasks(db, order.id).filter(
    (t) => t.item_id === item.id && t.portion === portion && t.kind === "food",
  );
  if (!originals.length) throw new TkError("That portion isn't on this order.", "invalid", 422);

  const copy = new Map<string, string>();
  const created: string[] = [];
  let n = db.get<{ c: number }>("SELECT COUNT(*) AS c FROM tasks WHERE order_id = ?", order.id)!.c;
  for (const o of originals) copy.set(o.id, `${order.id}:r${++n}`);
  for (const o of originals) {
    const id = copy.get(o.id)!;
    db.run(
      `INSERT INTO tasks(id, order_id, item_id, name, kind, station_id, duration_ticks, extra_ticks, modifiers,
         allergen_note, deps, status, planned_start_ms, planned_end_ms, start_inferred, urgent, portion, remake_of, created_ms)
       VALUES(?, ?, ?, ?, 'remake', ?, ?, 0, ?, ?, ?, 'PLANNED', NULL, NULL, 0, 1, ?, ?, ?)`,
      id,
      order.id,
      item.id,
      `Remake: ${o.name}`,
      o.station_id,
      o.duration_ticks,
      o.modifiers,
      o.allergen_note,
      JSON.stringify((JSON.parse(o.deps) as string[]).map((d) => copy.get(d)).filter(Boolean)),
      o.portion,
      o.id,
      now + n,
    );
    created.push(id);
  }
  // Packing now also waits for the remade items.
  const pack = orderTasks(db, order.id).find((t) => t.kind === "pack")!;
  db.run("UPDATE tasks SET deps = ? WHERE id = ?", JSON.stringify([...(JSON.parse(pack.deps) as string[]), ...created]), pack.id);
  db.run("UPDATE checks SET checked = 0, checked_ms = ? WHERE order_id = ? AND key = ?", now, order.id, `item:${item.id}`);
  logEvent(db, "remake", { orderId: order.id, payload: { item: item.name, portion, reason, tasks: created.length } });
  return { orderId: order.id, taskIds: created };
}

/** After a remake is scheduled, it becomes an issued instruction at once. */
export function issueRemake(db: Db, taskIds: string[]) {
  const issued: string[] = [];
  for (const id of taskIds) {
    const t = db.get<TaskRow>("SELECT * FROM tasks WHERE id = ?", id);
    if (!t || t.status !== "PLANNED" || t.planned_start_ms === null) continue;
    const version = getOrder(db, t.order_id).plan_version;
    db.run("UPDATE tasks SET status = 'ISSUED', released_version = ?, urgent = 0 WHERE id = ?", version, id);
    issued.push(id);
  }
  return issued;
}

/* ------------------------------------------------------------------ */
/* Capacity, settings, printing, samples                                */
/* ------------------------------------------------------------------ */

export type CapacityInput = {
  kind: "station" | "pool";
  id: string;
  /** Units of equipment or staff out of action. 0 clears the outage. */
  unitsOut: number;
  minutes?: number;
};

export function setCapacity(db: Db, input: CapacityInput, now: number) {
  const config = loadConfig(db);
  const resource = (input.kind === "station" ? config.stations : config.pools).find((r) => r.id === input.id);
  if (!resource) throw new TkError("That station or staff group doesn't exist.", "not_found", 404);
  if (!Number.isInteger(input.unitsOut) || input.unitsOut < 0 || input.unitsOut > resource.capacity)
    throw new TkError(`Units out must be from 0 to ${resource.capacity}.`, "invalid", 422);
  db.run(
    "UPDATE outages SET cleared_ms = ? WHERE kind = ? AND resource_id = ? AND cleared_ms IS NULL",
    now,
    input.kind,
    input.id,
  );
  if (input.unitsOut > 0) {
    const minutes = input.minutes ?? 30;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 720)
      throw new TkError("Time out of action must be from 1 to 720 minutes.", "invalid", 422);
    db.run(
      "INSERT INTO outages(kind, resource_id, units, from_ms, until_ms) VALUES(?, ?, ?, ?, ?)",
      input.kind,
      input.id,
      input.unitsOut,
      now,
      now + minutes * MINUTE_MS,
    );
  }
  logEvent(db, "capacity_changed", { payload: { ...input } });
  return { kind: input.kind, id: input.id, unitsOut: input.unitsOut };
}

export function updateSettings(db: Db, next: Config, now: number) {
  const config = validateConfig(next);
  const stations = new Set(config.stations.map((s) => s.id));
  const busy = db
    .all<{ station_id: string }>(
      "SELECT DISTINCT t.station_id FROM tasks t JOIN orders o ON o.id = t.order_id WHERE o.status IN ('DRAFT','RELEASED') AND t.status != 'DONE'",
    )
    .find((r) => !stations.has(r.station_id));
  if (busy)
    throw new TkError("A station you removed still has work waiting. Finish that work first.", "in_use");
  saveConfig(db, config);
  syncShelf(db, config.shelfSlots);
  logEvent(db, "settings_saved", {});
  return { configured: true, now };
}

export function recordPrint(db: Db, orderId: string, now: number) {
  const order = getOrder(db, orderId);
  db.run("UPDATE orders SET printed_count = printed_count + 1, last_print_ms = ? WHERE id = ?", now, orderId);
  logEvent(db, "printed", { orderId, payload: { count: order.printed_count + 1 } });
  return { orderId, printedCount: order.printed_count + 1 };
}

/** Synthetic orders for a demo. They never count in the shift report. */
export function loadSample(db: Db, now: number) {
  const make = (o: NewOrder) => createOrder(db, { ...o, sample: true }, now).number;
  const numbers = [
    make({
      channel: "delivery",
      customer: "Maya R.",
      driverName: "Chris D.",
      etaMinutes: 10,
      items: [
        { recipe: "burger", qty: 1, modifiers: ["well done"] },
        { recipe: "fries", qty: 1 },
        { recipe: "shake", qty: 1 },
      ],
    }),
    make({
      channel: "walk_in",
      customer: "Jordan P.",
      promisedMinutes: 14,
      items: [
        { recipe: "chicken", qty: 1 },
        { recipe: "rings", qty: 1 },
        { recipe: "soda", qty: 1 },
      ],
    }),
    make({
      channel: "delivery",
      customer: "Sam K.",
      driverName: "Priya N.",
      etaMinutes: 16,
      allergen: "Peanut allergy. Clean surfaces and gloves.",
      items: [
        { recipe: "burger", qty: 2 },
        { recipe: "fries", qty: 3 },
      ],
    }),
    make({
      channel: "walk_in",
      customer: "Alex T.",
      promisedMinutes: 22,
      items: [
        { recipe: "pizza", qty: 1 },
        { recipe: "salad", qty: 1 },
      ],
    }),
  ];
  logEvent(db, "sample_loaded", { payload: { numbers } });
  return { numbers };
}

export function clearSample(db: Db) {
  const ids = db.all<{ id: string }>("SELECT id FROM orders WHERE sample = 1").map((r) => r.id);
  for (const id of ids) {
    for (const table of ["checks", "driver_estimates", "outbound_log", "tasks", "items"])
      db.run(`DELETE FROM ${table} WHERE order_id = ?`, id);
    db.run("UPDATE shelf SET order_id = NULL WHERE order_id = ?", id);
    db.run("DELETE FROM events WHERE order_id = ?", id);
    db.run("DELETE FROM orders WHERE id = ?", id);
  }
  return { cleared: ids.length };
}

export { getRev };

export const planPending = (db: Db) => queued.has(db);
