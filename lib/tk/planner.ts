import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { Db, bumpRev, getRev, loadConfig, logEvent } from "./db";
import { MINUTE_MS, TICK_MS, alignDown, alignUp, formatTime } from "./time";
import { orderTiming, projectTasks, taskMs } from "./timing";
import { Config, EstimateRow, OrderRow, TaskRow } from "./types";

export type StageInfo = { name: string; status: string; wall_ms: number; objective?: number };

export type SolveSummary = {
  status: "optimal" | "feasible" | "infeasible" | "unknown" | "invalid" | "error" | "skipped";
  ms: number;
  stages: StageInfo[];
  warnings: string[];
  reason: string;
  units: number;
};

type Row<T> = T & Record<string, unknown>;

type Unit = {
  id: string;
  orderId: string;
  taskIds: string[];
  station: string;
  pool: string;
  dur: number;
  earliest: number;
  deps: string[];
  fixedStart?: number;
  hint?: number;
  prev?: number;
  weight: number;
  attend: { mode: string; load?: number; unload?: number };
  kind: string;
  urgent: boolean;
};

/** Where the Python interpreter with OR-Tools lives. */
export function solverCommand() {
  if (process.env.PRAXIS_PYTHON) return process.env.PRAXIS_PYTHON;
  const venv = path.join(process.cwd(), ".venv-solver", "bin", "python");
  return existsSync(venv) ? venv : "python3";
}

const script = () => path.join(process.cwd(), "solver", "solve.py");

function exec(command: string, args: string[], input: string, timeoutMs: number) {
  return new Promise<{ code: number | null; out: string; err: string; timedOut: boolean }>(
    (resolve) => {
      let out = "";
      let err = "";
      let timedOut = false;
      let child;
      try {
        child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
      } catch (e) {
        resolve({ code: -1, out, err: String(e), timedOut });
        return;
      }
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", (e) => {
        clearTimeout(timer);
        resolve({ code: -1, out, err: String(e), timedOut });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ code, out, err, timedOut });
      });
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    },
  );
}

let available: Promise<boolean> | null = null;
/** True when the scheduling engine can run. Checked once. */
export function solverAvailable() {
  available ??= exec(solverCommand(), ["-c", "import ortools"], "", 20_000).then(
    (r) => r.code === 0,
  );
  return available;
}
export const resetSolverCheck = () => {
  available = null;
};

export type SolverAnswer = {
  status: string;
  stages: StageInfo[];
  units?: Record<string, { start: number; end: number }>;
  orders?: Record<string, { ready: number; late: number; expected_wait: number }>;
  warnings: string[];
  solve_ms?: number;
};

export async function runSolver(problem: object, seconds: number): Promise<SolverAnswer> {
  const r = await exec(solverCommand(), [script()], JSON.stringify(problem), (seconds + 15) * 1000);
  if (r.timedOut)
    return { status: "unknown", stages: [], warnings: ["The solver took too long and was stopped."] };
  if (r.code !== 0 || !r.out.trim())
    return {
      status: "error",
      stages: [],
      warnings: [
        "The scheduling engine isn't available. Run `npm run setup:solver` once, then restart.",
      ],
    };
  try {
    return JSON.parse(r.out) as SolverAnswer;
  } catch {
    return { status: "error", stages: [], warnings: ["The solver returned an unreadable answer."] };
  }
}

export type ProblemBundle = {
  problem: object | null;
  units: Unit[];
  originMs: number;
  warnings: string[];
};

/** Capacity left for drafts per tick, given outages and the work already locked in. */
function capacityProfile(
  length: number,
  capacity: number,
  outages: { from: number; until: number; units: number }[],
  locked: Int16Array,
) {
  const lockedMax = locked.reduce((m, v) => Math.max(m, v), 0);
  const cap = Math.max(capacity, lockedMax);
  const blocked: { start: number; end: number; units: number }[] = [];
  const overloads: number[] = [];
  let open: { start: number; units: number } | null = null;
  for (let t = 0; t <= length; t++) {
    const down = t < length ? outages.filter((o) => t >= o.from && t < o.until).reduce((n, o) => n + o.units, 0) : 0;
    const available = Math.max(0, capacity - down);
    if (t < length && down > 0 && locked[t] > available) overloads.push(t);
    const units = t < length ? cap - Math.max(available, locked[t]) : 0;
    if (open && (units !== open.units || t === length)) {
      if (open.units > 0) blocked.push({ start: open.start, end: t, units: open.units });
      open = null;
    }
    if (!open && t < length) open = { start: t, units };
  }
  return { capacity: cap, blocked, overloads };
}

type Active = {
  orders: OrderRow[];
  estimates: Map<string, EstimateRow>;
  tasks: TaskRow[];
};

export function loadActive(db: Db): Active {
  const orders = db.all<OrderRow>("SELECT * FROM orders WHERE status IN ('DRAFT','RELEASED') ORDER BY created_ms");
  const estimates = new Map(
    db.all<EstimateRow>("SELECT * FROM driver_estimates").map((e) => [e.order_id, e]),
  );
  const ids = new Set(orders.map((o) => o.id));
  const tasks = db
    .all<TaskRow>("SELECT * FROM tasks ORDER BY order_id, created_ms, id")
    .filter((t) => ids.has(t.order_id));
  return { orders, estimates, tasks };
}

/** Outages that still matter, as offsets the caller can place on its own timeline. */
export function liveOutages(db: Db, nowMs: number) {
  return db.all<{ kind: string; resource_id: string; units: number; from_ms: number; until_ms: number }>(
    "SELECT kind, resource_id, units, from_ms, until_ms FROM outages WHERE cleared_ms IS NULL AND until_ms > ?",
    nowMs,
  );
}

export function buildProblem(
  db: Db,
  nowMs: number,
  opts: { urgentTaskIds?: string[] } = {},
): ProblemBundle {
  const config = loadConfig(db);
  const { orders, estimates, tasks } = loadActive(db);
  const urgentTasks = new Set(opts.urgentTaskIds ?? []);
  const warnings: string[] = [];
  const now = alignUp(nowMs);
  const byTask = new Map(tasks.map((t) => [t.id, t]));
  const projection = projectTasks(tasks, nowMs);
  const station = new Map(config.stations.map((s) => [s.id, s]));
  const outages = liveOutages(db, nowMs);

  // The timeline starts a little before the earliest moment that matters.
  const moments: number[] = [now];
  for (const t of tasks) {
    if (t.actual_start_ms) moments.push(t.actual_start_ms);
    if (t.planned_start_ms) moments.push(t.planned_start_ms);
  }
  const timings = new Map(
    orders.map((o) => [o.id, orderTiming(o, estimates.get(o.id), config, nowMs)]),
  );
  for (const t of timings.values()) {
    moments.push(t.targetMs);
    for (const s of t.scenarios) moments.push(s.arrivalMs);
  }
  for (const o of orders) moments.push(o.created_ms);
  const originMs = alignDown(Math.min(...moments)) - 4 * TICK_MS;
  const tick = (ms: number) => Math.round((ms - originMs) / TICK_MS);
  const nowTick = tick(now);

  // One scheduling unit per task, or per batch (portions sharing one run).
  const createdOf = new Map(orders.map((o) => [o.id, o.created_ms]));
  const unitOf = (t: TaskRow) => t.batch_id ?? t.id;
  const units = new Map<string, Unit>();
  const doneEnds = new Map<string, { end: number; weight: number }[]>();
  const doneEndOfTask = new Map<string, number>();

  for (const t of tasks) {
    if (t.status === "DONE") {
      const end = tick(t.actual_end_ms ?? now);
      doneEndOfTask.set(t.id, end);
      if (t.kind !== "pack") {
        const list = doneEnds.get(t.order_id) ?? [];
        list.push({ end, weight: 1 });
        doneEnds.set(t.order_id, list);
      }
    }
  }

  const excludedPack = new Set<string>();
  for (const t of tasks)
    if (urgentTasks.has(t.id)) excludedPack.add(t.order_id);

  for (const t of tasks) {
    if (t.status === "DONE") continue;
    if (t.kind === "pack" && excludedPack.has(t.order_id)) continue;
    const st = station.get(t.station_id);
    if (!st) {
      warnings.push(`A task uses a station that no longer exists (${t.station_id}).`);
      continue;
    }
    const id = unitOf(t);
    const existing = units.get(id);
    if (existing) {
      existing.taskIds.push(t.id);
      existing.weight += 1;
      continue;
    }
    const attend =
      st.attend.mode === "load_unload"
        ? { mode: "load_unload", load: st.attend.loadTicks, unload: st.attend.unloadTicks }
        : { mode: "full" };
    const deps = (JSON.parse(t.deps) as string[]).filter((d) => byTask.get(d)?.status !== "DONE");
    const doneDepEnd = Math.max(
      nowTick,
      ...(JSON.parse(t.deps) as string[]).map((d) => doneEndOfTask.get(d) ?? 0),
    );
    const u: Unit = {
      id,
      orderId: t.order_id,
      taskIds: [t.id],
      station: t.station_id,
      pool: st.pool,
      dur: t.duration_ticks + t.extra_ticks,
      // Work can't start before the order exists, and never in the past.
      earliest: Math.max(
        doneDepEnd,
        nowTick,
        tick(alignUp(createdOf.get(t.order_id) ?? now)),
      ),
      deps,
      weight: 1,
      attend,
      kind: t.kind,
      urgent: urgentTasks.has(t.id),
    };
    if (t.status === "PLANNED") {
      if (t.planned_start_ms !== null) {
        const prev = tick(alignDown(t.planned_start_ms));
        if (prev >= u.earliest) {
          u.hint = prev;
          if (!u.urgent) u.prev = prev;
        }
      }
    } else {
      // Locked work keeps its place. Only its projection can slide, and only forward.
      const p = projection.get(t.id);
      if (p) {
        u.fixedStart = tick(p.startMs);
        u.dur = Math.max(1, tick(p.endMs) - tick(p.startMs));
      } else u.fixedStart = Math.max(nowTick, tick(t.planned_start_ms ?? now));
    }
    units.set(id, u);
  }

  const list = [...units.values()];
  // Dependencies are by task id; solver dependencies are by unit id.
  const unitOfTask = new Map<string, string>();
  for (const u of list) for (const tid of u.taskIds) unitOfTask.set(tid, u.id);
  for (const u of list)
    u.deps = [...new Set(u.deps.map((d) => unitOfTask.get(d)).filter((d): d is string => !!d && d !== u.id))];

  const free = list.filter((u) => u.fixedStart === undefined);

  const lockedEnds = list.filter((u) => u.fixedStart !== undefined).map((u) => u.fixedStart! + u.dur);
  const maxTime = Math.max(
    nowTick,
    ...[...timings.values()].flatMap((t) => t.scenarios.map((s) => tick(s.arrivalMs))),
    ...[...timings.values()].map((t) => tick(t.targetMs)),
    ...lockedEnds,
    ...outages.map((o) => tick(o.until_ms)),
  );
  const horizon = maxTime + free.reduce((n, u) => n + u.dur, 0) + 40;

  // Locked usage per tick, for capacity left to drafts.
  const stationUse = new Map<string, Int16Array>();
  const poolUse = new Map<string, Int16Array>();
  const arr = (m: Map<string, Int16Array>, id: string) => {
    if (!m.has(id)) m.set(id, new Int16Array(horizon + 2));
    return m.get(id)!;
  };
  for (const u of list) {
    if (u.fixedStart === undefined) continue;
    const s = u.fixedStart;
    const e = Math.min(horizon, s + u.dur);
    const su = arr(stationUse, u.station);
    for (let t = Math.max(0, s); t < e; t++) su[t] += 1;
    const pu = arr(poolUse, u.pool);
    const a = u.attend;
    const spans: [number, number][] =
      a.mode === "load_unload" && (a.load ?? 0) + (a.unload ?? 0) < u.dur
        ? [
            [s, s + (a.load ?? 0)],
            [s + u.dur - (a.unload ?? 0), s + u.dur],
          ]
        : [[s, s + u.dur]];
    for (const [x, y] of spans) for (let t = Math.max(0, x); t < Math.min(horizon, y); t++) pu[t] += 1;
  }

  const stationsOut = config.stations.map((st) => {
    const mine = outages
      .filter((o) => o.kind === "station" && o.resource_id === st.id)
      .map((o) => ({ from: tick(o.from_ms), until: tick(o.until_ms), units: o.units }));
    const p = capacityProfile(horizon, st.capacity, mine, arr(stationUse, st.id));
    for (const t of p.overloads.slice(0, 1))
      warnings.push(
        `Locked work needs more ${st.name} than is available at ${formatTime(originMs + t * TICK_MS, config.timezone, config.clock24)}. Review the issued receipts.`,
      );
    return { id: st.id, capacity: p.capacity, blocked: p.blocked };
  });
  const poolsOut = config.pools.map((pool) => {
    const mine = outages
      .filter((o) => o.kind === "pool" && o.resource_id === pool.id)
      .map((o) => ({ from: tick(o.from_ms), until: tick(o.until_ms), units: o.units }));
    const p = capacityProfile(horizon, pool.capacity, mine, arr(poolUse, pool.id));
    for (const t of p.overloads.slice(0, 1))
      warnings.push(
        `Locked work needs more ${pool.name} staff than are available at ${formatTime(originMs + t * TICK_MS, config.timezone, config.clock24)}. Review the issued receipts.`,
      );
    return { id: pool.id, capacity: p.capacity, blocked: p.blocked };
  });

  const problemOrders = orders.flatMap((o) => {
    const pack = list.find((u) => u.orderId === o.id && u.kind === "pack");
    if (!pack) return [];
    const timing = timings.get(o.id)!;
    const food = list.filter((u) => u.orderId === o.id && u.kind !== "pack").map((u) => u.id);
    if (timing.stale)
      warnings.push(`Order #${o.number}: the driver estimate is ${timing.ageMinutes} min old. Planning with a wider range.`);
    return [
      {
        id: o.id,
        target: tick(timing.targetMs),
        pack: pack.id,
        food,
        done_ends: doneEnds.get(o.id) ?? [],
        scenarios: timing.scenarios.map((s) => ({ arrival: tick(s.arrivalMs), weight: s.weight })),
      },
    ];
  });

  if (!free.length) return { problem: null, units: list, originMs, warnings };

  const problem = {
    horizon,
    seconds: config.solver.seconds,
    workers: config.solver.workers,
    seed: 1,
    weights: {
      wait: 3,
      stability: 1000,
      hold: config.holding.after.map((after, i) => ({ after, slope: config.holding.slope[i] })),
    },
    stations: stationsOut,
    pools: poolsOut,
    units: list.map((u) => ({
      id: u.id,
      order: u.orderId,
      station: u.station,
      pool: u.pool,
      dur: u.dur,
      earliest: u.earliest,
      deps: u.deps,
      fixed_start: u.fixedStart ?? null,
      hint: u.hint ?? null,
      prev: u.prev ?? null,
      weight: u.weight,
      attend: u.attend,
      kind: u.kind,
    })),
    orders: problemOrders,
    urgent: list.filter((u) => u.urgent).map((u) => u.id),
  };
  return { problem, units: list, originMs, warnings };
}

export function recordSolve(db: Db, summary: SolveSummary, nowMs: number) {
  db.run(
    "INSERT INTO solves(ts_ms, status, ms, reason, warnings, stages, units) VALUES(?, ?, ?, ?, ?, ?, ?)",
    nowMs,
    summary.status,
    summary.ms,
    summary.reason,
    JSON.stringify(summary.warnings),
    JSON.stringify(summary.stages),
    summary.units,
  );
  db.run("DELETE FROM solves WHERE id < (SELECT MAX(id) - 50 FROM solves)");
}

/**
 * Re-plans every draft. Issued and cooking work is fixed and keeps its receipt.
 * If no plan is found, the previous plan is kept and the failure is recorded.
 */
export async function replan(
  db: Db,
  reason: string,
  opts: { urgentTaskIds?: string[] } = {},
): Promise<SolveSummary> {
  const now = db.now();
  const bundle = buildProblem(db, now, opts);
  const base = { reason, units: bundle.units.length };
  if (!bundle.problem) {
    const summary: SolveSummary = { ...base, status: "skipped", ms: 0, stages: [], warnings: bundle.warnings };
    db.tx(() => recordSolve(db, summary, now));
    return summary;
  }
  const config = loadConfig(db);
  const answer = await runSolver(bundle.problem, config.solver.seconds);
  const summary: SolveSummary = {
    ...base,
    status: (["optimal", "feasible", "infeasible", "unknown", "invalid", "error"].includes(answer.status)
      ? answer.status
      : "error") as SolveSummary["status"],
    ms: answer.solve_ms ?? 0,
    stages: answer.stages ?? [],
    warnings: [...bundle.warnings, ...(answer.warnings ?? [])],
  };
  db.tx(() => {
    if (answer.units && (summary.status === "optimal" || summary.status === "feasible")) {
      const stamp = (u: Unit) => answer.units![u.id];
      for (const u of bundle.units) {
        if (u.fixedStart !== undefined) continue;
        const r = stamp(u);
        if (!r) continue;
        const start = bundle.originMs + r.start * TICK_MS;
        const end = bundle.originMs + r.end * TICK_MS;
        for (const tid of u.taskIds)
          db.run(
            "UPDATE tasks SET planned_start_ms = ?, planned_end_ms = ? WHERE id = ? AND status = 'PLANNED'",
            start,
            end,
            tid,
          );
      }
    } else {
      logEvent(db, "plan_failed", {
        actor: "system",
        payload: { status: summary.status, warnings: summary.warnings },
      });
    }
    recordSolve(db, summary, now);
    bumpRev(db);
  });
  return summary;
}

export const planRev = getRev;
export { MINUTE_MS, taskMs };
