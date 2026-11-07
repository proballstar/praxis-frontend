import { Db, getRev, loadConfig } from "./db";
import { loadActive, buildProblem, liveOutages, solverAvailable } from "./planner";
import { MINUTE_MS, TICK_MS, formatTime } from "./time";
import { bagReadyMs, orderTiming, projectTasks, taskMs } from "./timing";
import { itemCount, planPending } from "./engine";
import { Config, EstimateRow, ItemRow, OrderRow, OrderStatus, TaskRow } from "./types";

export type TaskView = {
  id: string;
  name: string;
  kind: TaskRow["kind"];
  itemId: string | null;
  stationId: string;
  stationName: string;
  status: TaskRow["status"];
  durationMin: number;
  extraMin: number;
  modifiers: string[];
  allergen: string;
  plannedStartMs: number | null;
  plannedEndMs: number | null;
  projectedStartMs: number | null;
  projectedEndMs: number | null;
  actualStartMs: number | null;
  actualEndMs: number | null;
  startInferred: boolean;
  batchId: string | null;
  portion: number;
  remake: boolean;
  urgent: boolean;
  slid: boolean;
};

export type ExplainStep = { title: string; detail: string };
export type Explanation = {
  steps: ExplainStep[];
  caveat: string;
  components: {
    taskId: string;
    name: string;
    station: string;
    durationMin: number;
    idealStartMs: number;
    scheduledStartMs: number | null;
    occupancy: { used: number; capacity: number } | null;
  }[];
};

export type OrderView = {
  id: string;
  number: number;
  channel: OrderRow["channel"];
  source: string;
  customer: string;
  pickupCode: string;
  status: OrderStatus;
  phase: "draft" | "cooking" | "ready_to_pack" | "sealed" | "handed_off" | "cancelled";
  createdMs: number;
  driver: {
    name: string;
    arrivalMs: number;
    updatedMs: number;
    ageMinutes: number;
    stale: boolean;
    earlyS: number;
    lateS: number;
    source: string;
  } | null;
  promisedMs: number | null;
  expectedMs: number;
  targetMs: number;
  items: {
    id: string;
    name: string;
    qty: number;
    category: string;
    modifiers: string[];
    allergen: string;
    checked: boolean;
    remadeMin: number | null;
  }[];
  itemCount: number;
  reminders: { name: string; checked: boolean }[];
  allergen: { flag: boolean; note: string; acknowledged: boolean };
  tasks: TaskView[];
  plan: {
    version: number;
    releasedMs: number | null;
    plannedBagReadyMs: number | null;
    bagReadyMs: number | null;
    risk: "on_time" | "at_risk" | "no_plan";
    minutesAfterTarget: number | null;
    minutesAfterEta: number | null;
    lockedAtRisk: boolean;
    slippedMin: number;
    missedStarts: string[];
    withdrawnNote: string;
    packMin: number;
  };
  printed: { count: number; lastMs: number | null };
  slot: string | null;
  sealedMs: number | null;
  sample: boolean;
  explanation: Explanation;
};

export type StationGroup = {
  key: string;
  orderId: string;
  orderNumber: number;
  taskIds: string[];
  name: string;
  qty: number;
  status: "ISSUED" | "COOKING" | "DONE";
  plannedStartMs: number;
  plannedEndMs: number;
  /** When it should finish: from the real start if cooking, otherwise the planned start. */
  expectedEndMs: number;
  durationMin: number;
  startInferred: boolean;
  modifiers: string[];
  allergen: string;
  remake: boolean;
  batch: boolean;
  blockedBy: string | null;
  startedMs: number | null;
  doneMs: number | null;
};

export type Snapshot = {
  serverNow: number;
  timezone: string;
  clock24: boolean;
  rev: number;
  configured: boolean;
  config: Config;
  orders: OrderView[];
  stations: {
    id: string;
    name: string;
    capacity: number;
    outage: { unitsOut: number; untilMs: number } | null;
    pool: string;
    groups: StationGroup[];
    recentDone: StationGroup[];
  }[];
  pools: { id: string; name: string; capacity: number; outage: { unitsOut: number; untilMs: number } | null }[];
  shelf: {
    slot: string;
    orderId: string | null;
    number: number | null;
    customer: string | null;
    count: number | null;
    sealedMs: number | null;
  }[];
  outbound: { id: number; tsMs: number; orderNumber: number; readyMs: number; reason: string; mode: string }[];
  solver: {
    available: boolean;
    pending: boolean;
    last: null | { status: string; ms: number; reason: string; tsMs: number; warnings: string[]; stages: { name: string; status: string }[] };
  };
  warnings: string[];
};

const minutes = (ms: number) => ms / MINUTE_MS;
const parse = <T>(s: string, fallback: T): T => {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
};

function taskView(t: TaskRow, config: Config, proj: ReturnType<typeof projectTasks>, batchSizes: Map<string, number>): TaskView {
  const p = proj.get(t.id) ?? null;
  return {
    id: t.id,
    name: t.name,
    kind: t.kind,
    itemId: t.item_id,
    stationId: t.station_id,
    stationName: config.stations.find((s) => s.id === t.station_id)?.name ?? t.station_id,
    status: t.status,
    durationMin: minutes(t.duration_ticks * TICK_MS),
    extraMin: minutes(t.extra_ticks * TICK_MS),
    modifiers: parse<string[]>(t.modifiers, []),
    allergen: t.allergen_note,
    plannedStartMs: t.planned_start_ms,
    plannedEndMs: t.planned_end_ms,
    projectedStartMs: p?.startMs ?? null,
    projectedEndMs: p?.endMs ?? null,
    actualStartMs: t.actual_start_ms,
    actualEndMs: t.actual_end_ms,
    startInferred: !!t.start_inferred,
    batchId: t.batch_id && (batchSizes.get(t.batch_id) ?? 0) > 1 ? t.batch_id : null,
    portion: t.portion,
    remake: t.kind === "remake",
    urgent: !!t.urgent,
    slid: !!p?.late,
  };
}

/** Backward-calculated ideal start for every component, ignoring every other order. */
function idealStarts(tasks: TaskRow[], targetMs: number, packMs: number) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const successors = new Map<string, string[]>();
  for (const t of tasks)
    for (const d of parse<string[]>(t.deps, [])) successors.set(d, [...(successors.get(d) ?? []), t.id]);
  const idealEnd = new Map<string, number>();
  const idealStart = new Map<string, number>();
  const pack = tasks.find((t) => t.kind === "pack");
  const packStart = targetMs - packMs;
  const endOf = (t: TaskRow): number => {
    if (idealEnd.has(t.id)) return idealEnd.get(t.id)!;
    idealEnd.set(t.id, packStart);
    const next = (successors.get(t.id) ?? [])
      .filter((s) => s !== pack?.id)
      .map((s) => startOf(byId.get(s)!));
    const end = next.length ? Math.min(...next) : packStart;
    idealEnd.set(t.id, end);
    return end;
  };
  const startOf = (t: TaskRow): number => {
    if (idealStart.has(t.id)) return idealStart.get(t.id)!;
    const s = endOf(t) - taskMs(t);
    idealStart.set(t.id, s);
    return s;
  };
  for (const t of tasks) startOf(t);
  return idealStart;
}

function explain(
  order: OrderRow,
  tasks: TaskRow[],
  estimate: EstimateRow | undefined,
  config: Config,
  now: number,
  others: TaskRow[],
  outageUnits: Map<string, number>,
  proj: ReturnType<typeof projectTasks>,
  bagMs: number | null,
): Explanation {
  const timing = orderTiming(order, estimate, config, now);
  const fmt = (ms: number) => formatTime(ms, config.timezone, config.clock24);
  const packMs = config.packTicks * TICK_MS;
  const ideal = idealStarts(tasks, timing.targetMs, packMs);
  const food = tasks.filter((t) => t.kind !== "pack");

  const components = food.map((t) => {
    const idealStart = ideal.get(t.id)!;
    const st = config.stations.find((s) => s.id === t.station_id);
    const cap = st ? Math.max(0, st.capacity - (outageUnits.get(t.station_id) ?? 0)) : 0;
    // Only other orders count here: this is evidence about competition, not proof of why.
    const used = others.filter((o) => {
      if (o.station_id !== t.station_id || o.status === "DONE") return false;
      const p = proj.get(o.id) ?? (o.planned_start_ms === null ? null : { startMs: o.planned_start_ms, endMs: o.planned_end_ms! });
      return !!p && p.startMs <= idealStart && idealStart < p.endMs;
    }).length;
    return {
      taskId: t.id,
      name: t.name,
      station: st?.name ?? t.station_id,
      durationMin: minutes(taskMs(t)),
      idealStartMs: idealStart,
      scheduledStartMs: proj.get(t.id)?.startMs ?? t.planned_start_ms,
      occupancy: st ? { used, capacity: cap } : null,
    };
  });

  const when = order.channel === "delivery" ? "Driver" : "Promised pickup";
  const eta =
    order.channel === "delivery" && estimate
      ? `${when} arrival ${fmt(estimate.arrival_ms)}, last updated ${timing.ageMinutes} min ago (${estimate.source}). Range: ${Math.round(timing.earlyS)} s early to ${Math.round(timing.lateS)} s late${timing.stale ? ", widened because the estimate is stale" : ""}.`
      : `${when} ${fmt(timing.expectedMs)}. In-person and phone times are promises, so there's no driver range.`;
  const worst = [...components].sort((a, b) => b.durationMin - a.durationMin)[0];
  const lines: ExplainStep[] = [
    { title: "1. Estimate", detail: eta },
    {
      title: "2. Target",
      detail: `Aim to have the checked bag ready by ${fmt(timing.targetMs)} (${config.bufferMinutes} min before ${fmt(timing.expectedMs)}). Checking and bagging takes ${minutes(packMs)} min.`,
    },
    {
      title: "3. Ideal start times",
      detail: components.length
        ? components
            .map((c) => `${c.station}: ${c.name} takes ${c.durationMin} min, so ideally starts ${fmt(c.idealStartMs)}`)
            .join("; ") + "."
        : "No components yet.",
    },
    {
      title: "4. Scheduled start times",
      detail: components.length
        ? components
            .map((c) => {
              const at = c.scheduledStartMs === null ? "not planned yet" : fmt(c.scheduledStartMs);
              const occ = c.occupancy ? ` At the ideal time, ${c.occupancy.used} of ${c.occupancy.capacity} ${c.station} units were used by other orders.` : "";
              return `${c.name} is scheduled ${at}.${occ}`;
            })
            .join(" ")
        : "Nothing is scheduled yet.",
    },
  ];
  let outcome: string;
  if (bagMs === null) outcome = "No plan yet, so there's no estimate.";
  else if (bagMs <= timing.targetMs)
    outcome = `Estimated bag-ready ${fmt(bagMs)}, on time for the ${fmt(timing.targetMs)} target.`;
  else {
    const slow = worst ? ` The longest component (${worst.name}, ${worst.durationMin} min) can't finish early enough from now.` : "";
    outcome = `Estimated bag-ready ${fmt(bagMs)}, ${Math.ceil((bagMs - timing.targetMs) / MINUTE_MS)} min after the target and ${Math.max(0, Math.ceil((bagMs - timing.expectedMs) / MINUTE_MS))} min after the expected arrival.${slow} The app shows this as at risk and does not invent a faster schedule.`;
  }
  lines.push({ title: "5. Outcome", detail: outcome });
  return {
    steps: lines,
    caveat:
      "Station occupancy is evidence, not a full explanation. Shared staff, competing orders, dependencies and other constraints may also affect these times.",
    components,
  };
}

export async function buildSnapshot(db: Db): Promise<Snapshot> {
  const now = db.now();
  const config = loadConfig(db);
  const { orders: activeOrders, estimates, tasks: activeTasks } = loadActive(db);
  const recent = db.all<OrderRow>(
    "SELECT * FROM orders WHERE status IN ('SEALED','HANDED_OFF','CANCELLED') AND COALESCE(handed_off_ms, cancelled_ms, sealed_ms, created_ms) > ? ORDER BY created_ms",
    now - 60 * MINUTE_MS,
  );
  const sealed = db.all<OrderRow>("SELECT * FROM orders WHERE status = 'SEALED'");
  const all = new Map<string, OrderRow>();
  for (const o of [...activeOrders, ...sealed, ...recent]) all.set(o.id, o);
  const orders = [...all.values()].sort((a, b) => a.number - b.number);
  const ids = new Set(orders.map((o) => o.id));

  const tasks = db.all<TaskRow>("SELECT * FROM tasks ORDER BY order_id, created_ms, id").filter((t) => ids.has(t.order_id));
  const items = db.all<ItemRow>("SELECT * FROM items ORDER BY order_id, line").filter((i) => ids.has(i.order_id));
  const checks = new Map<string, number>();
  for (const c of db.all<{ order_id: string; key: string; checked: number }>("SELECT order_id, key, checked FROM checks"))
    checks.set(`${c.order_id}|${c.key}`, c.checked);
  for (const e of db.all<EstimateRow>("SELECT * FROM driver_estimates")) estimates.set(e.order_id, e);

  const byOrder = new Map<string, TaskRow[]>();
  for (const t of tasks) byOrder.set(t.order_id, [...(byOrder.get(t.order_id) ?? []), t]);
  const proj = projectTasks(tasks, now);
  const batchSizes = new Map<string, number>();
  for (const t of tasks) if (t.batch_id) batchSizes.set(t.batch_id, (batchSizes.get(t.batch_id) ?? 0) + 1);

  const outages = liveOutages(db, now);
  const outageUnits = new Map<string, number>();
  for (const o of outages)
    if (o.kind === "station" && o.from_ms <= now)
      outageUnits.set(o.resource_id, (outageUnits.get(o.resource_id) ?? 0) + o.units);

  const orderViews: OrderView[] = orders.map((o) => {
    const mine = byOrder.get(o.id) ?? [];
    const myItems = items.filter((i) => i.order_id === o.id);
    const est = estimates.get(o.id);
    const timing = orderTiming(o, est, config, now);
    const food = mine.filter((t) => t.kind !== "pack");
    const done = food.length > 0 && food.every((t) => t.status === "DONE");
    const phase: OrderView["phase"] =
      o.status === "DRAFT" ? "draft"
      : o.status === "SEALED" ? "sealed"
      : o.status === "HANDED_OFF" ? "handed_off"
      : o.status === "CANCELLED" ? "cancelled"
      : done ? "ready_to_pack" : "cooking";

    const bag = o.status === "SEALED" || o.status === "HANDED_OFF" ? o.sealed_ms : bagReadyMs(mine, now);
    const pack = mine.find((t) => t.kind === "pack");
    const plannedBag = pack?.planned_end_ms ?? null;
    const risk: OrderView["plan"]["risk"] = bag === null ? "no_plan" : bag <= timing.targetMs ? "on_time" : "at_risk";
    const missedStarts = mine
      .filter((t) => t.status === "ISSUED" && t.planned_start_ms !== null && t.planned_start_ms < now - TICK_MS)
      .map((t) => t.name);
    const others = tasks.filter((t) => t.order_id !== o.id && (t.status !== "DONE") && (t.status !== "PLANNED" || t.planned_start_ms !== null));

    return {
      id: o.id,
      number: o.number,
      channel: o.channel,
      source: o.source,
      customer: o.customer,
      pickupCode: o.pickup_code,
      status: o.status,
      phase,
      createdMs: o.created_ms,
      driver: est && o.channel === "delivery"
        ? {
            name: o.driver_name,
            arrivalMs: est.arrival_ms,
            updatedMs: est.updated_ms,
            ageMinutes: timing.ageMinutes ?? 0,
            stale: timing.stale,
            earlyS: est.early_s,
            lateS: est.late_s,
            source: est.source,
          }
        : null,
      promisedMs: o.promised_ms,
      expectedMs: timing.expectedMs,
      targetMs: timing.targetMs,
      items: myItems.map((i) => {
        const remakes = mine.filter((t) => t.item_id === i.id && t.kind === "remake" && t.status !== "DONE");
        return {
          id: i.id,
          name: i.name,
          qty: i.qty,
          category: i.category,
          modifiers: parse<string[]>(i.modifiers, []),
          allergen: i.allergen_note,
          checked: !!checks.get(`${o.id}|item:${i.id}`),
          remadeMin: remakes.length ? Math.max(0, ...remakes.map((t) => minutes((proj.get(t.id)?.endMs ?? now) - now))) : null,
        };
      }),
      itemCount: itemCount(myItems),
      reminders: parse<string[]>(o.reminders, []).map((name) => ({ name, checked: !!checks.get(`${o.id}|rem:${name}`) })),
      allergen: { flag: !!o.allergen_flag, note: o.allergen_note, acknowledged: !!o.allergen_ack },
      tasks: mine.map((t) => taskView(t, config, proj, batchSizes)),
      plan: {
        version: o.plan_version,
        releasedMs: o.released_ms,
        plannedBagReadyMs: plannedBag,
        bagReadyMs: bag,
        risk,
        minutesAfterTarget: bag === null || bag <= timing.targetMs ? null : Math.ceil((bag - timing.targetMs) / MINUTE_MS),
        minutesAfterEta: bag === null || bag <= timing.expectedMs ? null : Math.ceil((bag - timing.expectedMs) / MINUTE_MS),
        lockedAtRisk: o.status === "RELEASED" && risk === "at_risk",
        slippedMin: plannedBag !== null && bag !== null ? Math.max(0, Math.round((bag - plannedBag) / MINUTE_MS)) : 0,
        missedStarts,
        withdrawnNote: o.withdrawn_note,
        packMin: minutes(config.packTicks * TICK_MS),
      },
      printed: { count: o.printed_count, lastMs: o.last_print_ms },
      slot: o.shelf_slot,
      sealedMs: o.sealed_ms,
      sample: !!o.sample,
      explanation: explain(o, mine, est, config, now, others, outageUnits, proj, bag),
    };
  });

  // Station queues: issued and cooking work, one card per batch, sorted by planned start.
  const orderNumber = new Map(orders.map((o) => [o.id, o.number]));
  const released = new Set(orders.filter((o) => o.status === "RELEASED").map((o) => o.id));
  const group = (list: TaskRow[]): StationGroup[] => {
    const map = new Map<string, TaskRow[]>();
    for (const t of list) map.set(t.batch_id ?? t.id, [...(map.get(t.batch_id ?? t.id) ?? []), t]);
    return [...map.entries()].map(([key, g]) => {
      const t = g[0];
      const byId = new Map((byOrder.get(t.order_id) ?? []).map((x) => [x.id, x]));
      const blocker = (JSON.parse(t.deps) as string[]).map((d) => byId.get(d)).find((d) => d && d.status !== "DONE");
      const status = g.every((x) => x.status === "DONE") ? "DONE" : g.some((x) => x.status === "COOKING") ? "COOKING" : "ISSUED";
      const base = (t.item_id && items.find((i) => i.id === t.item_id)?.name) || t.name;
      return {
        key,
        orderId: t.order_id,
        orderNumber: orderNumber.get(t.order_id) ?? 0,
        taskIds: g.map((x) => x.id),
        name: t.kind === "remake" ? `Remake: ${base}` : base,
        qty: g.length,
        status,
        plannedStartMs: t.planned_start_ms ?? 0,
        plannedEndMs: t.planned_end_ms ?? 0,
        expectedEndMs: (t.actual_start_ms ?? t.planned_start_ms ?? 0) + taskMs(t),
        durationMin: minutes(taskMs(t)),
        startInferred: g.some((x) => x.start_inferred),
        modifiers: parse<string[]>(t.modifiers, []),
        allergen: t.allergen_note,
        remake: t.kind === "remake",
        batch: g.length > 1 && !!t.batch_id,
        blockedBy: blocker?.name ?? null,
        startedMs: t.actual_start_ms,
        doneMs: g.every((x) => x.actual_end_ms !== null) ? Math.max(...g.map((x) => x.actual_end_ms!)) : null,
      } satisfies StationGroup;
    });
  };
  const pools = config.pools.map((p) => {
    const o = outages.find((x) => x.kind === "pool" && x.resource_id === p.id && x.from_ms <= now);
    return { id: p.id, name: p.name, capacity: p.capacity, outage: o ? { unitsOut: o.units, untilMs: o.until_ms } : null };
  });
  const stations = config.stations
    .filter((s) => s.id !== config.packStation)
    .map((s) => {
      const mine = tasks.filter((t) => t.station_id === s.id && released.has(t.order_id) && t.kind !== "pack");
      const active = group(mine.filter((t) => t.status === "ISSUED" || t.status === "COOKING")).sort(
        (a, b) => a.plannedStartMs - b.plannedStartMs || a.orderNumber - b.orderNumber,
      );
      const recentDone = group(
        mine.filter((t) => t.status === "DONE" && (t.actual_end_ms ?? 0) > now - 15 * MINUTE_MS),
      ).sort((a, b) => (b.doneMs ?? 0) - (a.doneMs ?? 0));
      const o = outages.find((x) => x.kind === "station" && x.resource_id === s.id && x.from_ms <= now);
      return {
        id: s.id,
        name: s.name,
        capacity: s.capacity,
        outage: o ? { unitsOut: o.units, untilMs: o.until_ms } : null,
        pool: s.pool,
        groups: active,
        recentDone,
      };
    });

  const shelf = db
    .all<{ slot: string; order_id: string | null }>("SELECT slot, order_id FROM shelf ORDER BY idx")
    .map((r) => {
      const o = r.order_id ? all.get(r.order_id) ?? db.get<OrderRow>("SELECT * FROM orders WHERE id = ?", r.order_id) : undefined;
      return {
        slot: r.slot,
        orderId: o?.id ?? null,
        number: o?.number ?? null,
        customer: o?.customer ?? null,
        count: o ? itemCount(db.all<ItemRow>("SELECT * FROM items WHERE order_id = ?", o.id)) : null,
        sealedMs: o?.sealed_ms ?? null,
      };
    });

  const outbound = db
    .all<{ id: number; ts_ms: number; number: number; ready_ms: number; reason: string; mode: string }>(
      "SELECT l.id, l.ts_ms, o.number, l.ready_ms, l.reason, l.mode FROM outbound_log l JOIN orders o ON o.id = l.order_id ORDER BY l.id DESC LIMIT 40",
    )
    .map((r) => ({ id: r.id, tsMs: r.ts_ms, orderNumber: r.number, readyMs: r.ready_ms, reason: r.reason, mode: r.mode }));

  const last = db.get<{ status: string; ms: number; reason: string; ts_ms: number; warnings: string; stages: string }>(
    "SELECT * FROM solves ORDER BY id DESC LIMIT 1",
  );
  const warnings = [
    ...buildProblem(db, now).warnings,
    ...orderViews.filter((o) => o.plan.missedStarts.length && o.status === "RELEASED")
      .map((o) => `Order #${o.number}: ${o.plan.missedStarts.join(", ")} should have started already.`),
    ...orderViews.filter((o) => o.plan.lockedAtRisk)
      .map((o) => `Order #${o.number} is at risk. Its issued plan can't change without a manager withdrawing it.`),
  ];

  return {
    serverNow: now,
    timezone: config.timezone,
    clock24: config.clock24,
    rev: getRev(db),
    configured: config.configured,
    config,
    orders: orderViews,
    stations,
    pools,
    shelf,
    outbound,
    solver: {
      available: await solverAvailable(),
      pending: planPending(db),
      last: last
        ? {
            status: last.status,
            ms: last.ms,
            reason: last.reason,
            tsMs: last.ts_ms,
            warnings: parse<string[]>(last.warnings, []),
            stages: parse<{ name: string; status: string }[]>(last.stages, []),
          }
        : null,
    },
    warnings: [...new Set(warnings)],
  };
}
