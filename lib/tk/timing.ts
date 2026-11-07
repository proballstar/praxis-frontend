import { Config, EstimateRow, OrderRow, TaskRow } from "./types";
import { MINUTE_MS, TICK_MS, alignUp } from "./time";

/** Pure timing rules shared by the planner, the receipts and the explanations. */

export type Timing = {
  /** When the driver is expected, or the promised pickup time for walk-ins. */
  expectedMs: number;
  /** Bag-ready target: expected arrival minus the pickup buffer. */
  targetMs: number;
  scenarios: { arrivalMs: number; weight: number; label: string }[];
  /** Driver estimate older than the configured expiry. */
  stale: boolean;
  /** Minutes since the estimate was last updated. */
  ageMinutes: number | null;
  earlyS: number;
  lateS: number;
};

export function orderTiming(
  order: OrderRow,
  estimate: EstimateRow | undefined,
  config: Config,
  nowMs: number,
): Timing {
  const buffer = config.bufferMinutes * MINUTE_MS;
  if (order.channel === "delivery" && estimate) {
    const stale = nowMs - estimate.updated_ms > config.staleEtaMinutes * MINUTE_MS;
    // A stale estimate is less trustworthy, so the early/late range is widened.
    const spread = stale ? 2 : 1;
    const early = estimate.early_s * 1000 * spread;
    const late = estimate.late_s * 1000 * spread;
    const w = config.uncertainty.weights;
    return {
      expectedMs: estimate.arrival_ms,
      targetMs: estimate.arrival_ms - buffer,
      scenarios: [
        { arrivalMs: estimate.arrival_ms - early, weight: w.early, label: "early" },
        { arrivalMs: estimate.arrival_ms, weight: w.expected, label: "expected" },
        { arrivalMs: estimate.arrival_ms + late, weight: w.late, label: "late" },
      ],
      stale,
      ageMinutes: Math.max(0, Math.round((nowMs - estimate.updated_ms) / MINUTE_MS)),
      earlyS: early / 1000,
      lateS: late / 1000,
    };
  }
  // In-person and phone orders use the promised pickup time, which doesn't drift.
  const promised = order.promised_ms ?? order.created_ms + config.defaultEtaMinutes * MINUTE_MS;
  return {
    expectedMs: promised,
    targetMs: promised - buffer,
    scenarios: [{ arrivalMs: promised, weight: 100, label: "promised" }],
    stale: false,
    ageMinutes: null,
    earlyS: 0,
    lateS: 0,
  };
}

export const taskMs = (t: Pick<TaskRow, "duration_ticks" | "extra_ticks">) =>
  (t.duration_ticks + t.extra_ticks) * TICK_MS;

export type Projection = { startMs: number; endMs: number; late: boolean };

/**
 * What each task will realistically do, given what has really happened.
 * This never rewrites an issued receipt. It only tells staff where the locked
 * plan is heading: a missed start slides to now, an overrunning dish ends later.
 * Returns null times for drafts that have no plan yet.
 */
export function projectTasks(tasks: TaskRow[], nowMs: number): Map<string, Projection | null> {
  const now = alignUp(nowMs);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const memo = new Map<string, Projection | null>();
  const visit = (t: TaskRow): Projection | null => {
    if (memo.has(t.id)) return memo.get(t.id)!;
    memo.set(t.id, null); // guards against a malformed loop
    let result: Projection | null;
    if (t.status === "DONE") {
      const end = t.actual_end_ms ?? t.planned_end_ms ?? now;
      const start = t.actual_start_ms ?? t.planned_start_ms ?? end;
      result = { startMs: start, endMs: end, late: false };
    } else if (t.status === "COOKING") {
      const start = t.actual_start_ms ?? now;
      const end = Math.max(start + taskMs(t), now + TICK_MS);
      result = { startMs: start, endMs: end, late: end > start + taskMs(t) };
    } else if (t.planned_start_ms === null) {
      result = null;
    } else {
      const deps = (JSON.parse(t.deps) as string[])
        .map((d) => byId.get(d))
        .filter((d): d is TaskRow => !!d)
        .map(visit);
      if (deps.some((d) => d === null)) result = null;
      else {
        const depEnd = Math.max(0, ...deps.map((d) => d!.endMs));
        const planned = t.planned_start_ms;
        const start = Math.max(planned, now, depEnd);
        result = { startMs: start, endMs: start + taskMs(t), late: start > planned };
      }
    }
    memo.set(t.id, result);
    return result;
  };
  for (const t of tasks) visit(t);
  return memo;
}

/** Pack depends on every food and remake task of its order. */
export function packDeps(tasks: TaskRow[]) {
  return tasks.filter((t) => t.kind !== "pack").map((t) => t.id);
}

/** Estimated moment the bag is checked and ready, or null if nothing is planned yet. */
export function bagReadyMs(tasks: TaskRow[], nowMs: number): number | null {
  const pack = tasks.find((t) => t.kind === "pack");
  if (!pack) return null;
  return projectTasks(tasks, nowMs).get(pack.id)?.endMs ?? null;
}
