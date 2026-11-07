/**
 * Deterministic kitchen planner. Pure: no clock, storage, or AI.
 * All times are whole minutes relative to now (0).
 *
 * The planner decides which ticket gets kitchen capacity first. Every dish on a
 * ticket is its own task on a named resource (grill, fryer, ...). Tasks are
 * placed backward from the ticket's target finish, so dishes finish together.
 *
 * Definitions (see README "Planner definitions"):
 * - ready = last dish finished + packing.
 * - courier wait: minutes the courier stands at the counter before ready.
 * - food sitting: minutes a ready ticket waits for its courier.
 * - late: minutes ready after the pickup deadline.
 * - aged: minutes a ticket waited past AGING_LIMIT to get started, not counting
 *   a deliberate hold.
 * - quality: minutes dishes spend past their quality window at handoff.
 */
export type Resource = {
  id: string;
  capacity: number;
  /** Temporarily lost units, e.g. one fryer basket out for 20 minutes. */
  down?: { units: number; until: number };
};

export type Task = {
  id: string;
  resource: string;
  /** Minutes of work left. For done tasks, 0. */
  minutes: number;
  state: "pending" | "cooking" | "done";
  /** Minutes a finished dish stays good. Omit for no window. */
  quality?: number;
  /** Done tasks only: when it finished (zero or negative). */
  finished?: number;
};

export type Job = {
  id: string;
  tasks: Task[];
  /** Packing minutes after the last dish finishes. */
  pack?: number;
  arrival: number;
  deadline: number;
  received?: number;
  /** False when the courier ETA is unknown or stale: never hold for it. */
  holdable?: boolean;
};

export type TaskSlot = {
  id: string;
  resource: string;
  start: number;
  end: number;
  /** Minutes this dish will sit past its quality window at handoff. */
  over: number;
};

export type Slot = {
  id: string;
  /** First dish still to start, or 0 when everything has started. */
  start: number;
  /** Last dish finishes. */
  end: number;
  /** Packed and ready for pickup. */
  ready: number;
  driverWait: number;
  foodIdle: number;
  late: number;
  aged: number;
  quality: number;
  /** Deliberately not started yet, so food is not ready long before the courier. */
  held: boolean;
  tasks: TaskSlot[];
};

export type Metrics = {
  wait: number;
  idle: number;
  late: number;
  lateness: number;
  aged: number;
  quality: number;
  score: number;
};

export type Outcome = { sequence: string[]; slots: Slot[]; metrics: Metrics };

export type Plan = {
  current: Outcome;
  best: Outcome;
  examined: number;
  method: "exact" | "heuristic";
  /** The best sequence is enough better to interrupt the kitchen. */
  shouldChange: boolean;
};

export type Options = { resources: Resource[]; holdBuffer?: number };

export const WEIGHTS = { late: 5, wait: 2, idle: 1, aged: 3, quality: 3 };
/** A ticket may wait this long for capacity before aging penalties start. */
export const AGING_LIMIT = 20;
/** Default cover for estimates running over before a held ticket's courier. */
export const HOLD_BUFFER = 2;
/** Above this many queued tickets, exhaustive search gives way to the heuristic. */
export const EXACT_LIMIT = 6;
/** Roughly three courier-minutes: small gains are not worth reshuffling a busy line. */
export const MIN_GAIN = 6;

/** A job counts as started once any dish is cooking or done. Its place is fixed. */
export const isStarted = (j: Job) => j.tasks.some((t) => t.state !== "pending");

class Timeline {
  private used = new Map<string, Int16Array>();
  private limits = new Map<string, Resource>();

  constructor(
    resources: Resource[],
    readonly horizon: number,
  ) {
    for (const r of resources) {
      this.limits.set(r.id, r);
      this.used.set(r.id, new Int16Array(horizon));
    }
  }

  private capacity(r: Resource, t: number) {
    return r.down && t < r.down.until
      ? Math.max(0, r.capacity - r.down.units)
      : r.capacity;
  }

  private free(id: string, start: number, minutes: number) {
    const r = this.limits.get(id)!;
    const used = this.used.get(id)!;
    for (let t = start; t < start + minutes; t++)
      if (used[t] >= this.capacity(r, t)) return false;
    return true;
  }

  /** Earliest start at or after `from`. */
  earliest(id: string, minutes: number, from: number) {
    for (let t = from; t + minutes <= this.horizon; t++)
      if (this.free(id, t, minutes)) return t;
    throw Error("A dish cannot be scheduled on its resource.");
  }

  /** Latest start that finishes by `finish`, or null. */
  latest(id: string, minutes: number, finish: number) {
    for (let t = finish - minutes; t >= 0; t--)
      if (this.free(id, t, minutes)) return t;
    return null;
  }

  mark(id: string, start: number, minutes: number, by: 1 | -1 = 1) {
    const used = this.used.get(id)!;
    for (let t = start; t < start + minutes; t++) used[t] += by;
  }
}

function place(timeline: Timeline, j: Job, holdBuffer: number): Slot {
  const pack = j.pack ?? 0;
  const pending = j.tasks
    .filter((t) => t.state === "pending")
    .sort((a, b) => b.minutes - a.minutes || a.id.localeCompare(b.id));
  const placed = new Map<string, { start: number; end: number }>();

  let earliestFinish = 0;
  for (const t of j.tasks) {
    if (t.state === "cooking") {
      placed.set(t.id, { start: 0, end: t.minutes });
      earliestFinish = Math.max(earliestFinish, t.minutes);
    } else if (t.state === "done") {
      placed.set(t.id, { start: t.finished ?? 0, end: t.finished ?? 0 });
    }
  }

  // How soon could this ticket finish if it took capacity now? Trial, then undone.
  const trial: [string, number, number][] = [];
  for (const t of pending) {
    const start = timeline.earliest(t.resource, t.minutes, 0);
    timeline.mark(t.resource, start, t.minutes);
    trial.push([t.resource, start, t.minutes]);
    earliestFinish = Math.max(earliestFinish, start + t.minutes);
  }
  for (const [resource, start, minutes] of trial)
    timeline.mark(resource, start, minutes, -1);

  const target =
    j.holdable === false ? 0 : j.arrival - pack - holdBuffer;
  const finish = Math.max(earliestFinish, target);
  const held = pending.length > 0 && target > earliestFinish;

  for (const t of pending) {
    const start =
      timeline.latest(t.resource, t.minutes, finish) ??
      timeline.earliest(t.resource, t.minutes, 0);
    timeline.mark(t.resource, start, t.minutes);
    placed.set(t.id, { start, end: start + t.minutes });
  }

  const end = Math.max(0, ...[...placed.values()].map((p) => p.end));
  const ready = end + pack;
  const handoff = Math.max(ready, j.arrival);
  const start = pending.length
    ? Math.min(...pending.map((t) => placed.get(t.id)!.start))
    : 0;
  const tasks: TaskSlot[] = j.tasks.map((t) => {
    const p = placed.get(t.id)!;
    return {
      id: t.id,
      resource: t.resource,
      start: p.start,
      end: p.end,
      over:
        t.quality === undefined
          ? 0
          : Math.max(0, handoff - p.end - t.quality),
    };
  });

  return {
    id: j.id,
    start,
    end,
    ready,
    driverWait: Math.max(0, ready - j.arrival),
    foodIdle: Math.max(0, j.arrival - ready),
    late: Math.max(0, ready - j.deadline),
    // A deliberate hold is not neglect, and a started ticket has been picked up.
    aged:
      j.received === undefined || held || isStarted(j)
        ? 0
        : Math.max(0, start - j.received - AGING_LIMIT),
    quality: tasks.reduce((n, t) => n + t.over, 0),
    held,
    tasks,
  };
}

function horizonFor(jobs: Job[], resources: Resource[]) {
  const work = jobs.reduce(
    (n, j) => n + j.tasks.reduce((m, t) => m + t.minutes, 0),
    0,
  );
  const arrival = Math.max(0, ...jobs.map((j) => j.arrival));
  const down = Math.max(0, ...resources.map((r) => r.down?.until ?? 0));
  return arrival + work + down + 2;
}

export function schedule(
  jobs: Job[],
  sequence: string[],
  { resources, holdBuffer = HOLD_BUFFER }: Options,
): Slot[] {
  const known = new Set(resources.map((r) => r.id));
  if (!resources.length || resources.some((r) => r.capacity < 1))
    throw Error("Every resource needs a capacity of at least one.");
  for (const j of jobs)
    for (const t of j.tasks)
      if (!known.has(t.resource))
        throw Error(`Unknown resource: ${t.resource}.`);
  const started = jobs.filter(isStarted);
  const queued = jobs.filter((j) => !isStarted(j));
  if (
    new Set(sequence).size !== sequence.length ||
    sequence.length !== queued.length ||
    sequence.some((id) => !queued.some((j) => j.id === id))
  )
    throw Error("Every queued ticket must be scheduled exactly once.");

  const timeline = new Timeline(resources, horizonFor(jobs, resources));
  // Work already on the line holds its capacity even past a temporary outage.
  for (const j of started)
    for (const t of j.tasks)
      if (t.state === "cooking") timeline.mark(t.resource, 0, t.minutes);
  // Started tickets keep their place at the front; only their pending dishes move.
  const slots = started.map((j) => place(timeline, j, holdBuffer));
  const byId = new Map(queued.map((j) => [j.id, j]));
  for (const id of sequence)
    slots.push(place(timeline, byId.get(id)!, holdBuffer));
  return slots;
}

export function metrics(slots: Slot[]): Metrics {
  return slots.reduce(
    (m, s) => ({
      wait: m.wait + s.driverWait,
      idle: m.idle + s.foodIdle,
      late: m.late + (s.late > 0 ? 1 : 0),
      lateness: m.lateness + s.late,
      aged: m.aged + s.aged,
      quality: m.quality + s.quality,
      score:
        m.score +
        s.late * WEIGHTS.late +
        s.driverWait * WEIGHTS.wait +
        s.foodIdle * WEIGHTS.idle +
        s.aged * WEIGHTS.aged +
        s.quality * WEIGHTS.quality,
    }),
    { wait: 0, idle: 0, late: 0, lateness: 0, aged: 0, quality: 0, score: 0 },
  );
}

type Search = { sequence: string[]; score: number; examined: number };

function exact(ids: string[], score: (s: string[]) => number, start: Search) {
  const best = { ...start };
  const visit = (prefix: string[], rest: string[]) => {
    if (!rest.length) {
      const s = score(prefix);
      best.examined++;
      if (s < best.score) {
        best.score = s;
        best.sequence = [...prefix];
      }
      return;
    }
    for (let i = 0; i < rest.length; i++)
      visit([...prefix, rest[i]], rest.filter((_, j) => j !== i));
  };
  visit([], ids);
  return best;
}

/** Earliest-deadline insertion, then adjacent swaps until nothing improves. */
function heuristic(
  jobs: Job[],
  ids: string[],
  score: (s: string[]) => number,
  start: Search,
) {
  const best = { ...start };
  const consider = (sequence: string[]) => {
    const s = score(sequence);
    best.examined++;
    if (s < best.score) {
      best.score = s;
      best.sequence = sequence;
    }
    return s;
  };
  const deadline = new Map(jobs.map((j) => [j.id, j.deadline]));
  const urgent = [...ids].sort(
    (a, b) => deadline.get(a)! - deadline.get(b)! || a.localeCompare(b),
  );
  // Each prefix is completed with the remaining urgent tickets, so the
  // comparison between insertion points reflects the whole queue.
  let built: string[] = [];
  urgent.forEach((id, index) => {
    const tail = urgent.slice(index + 1);
    let chosen: string[] = [];
    let chosenScore = Infinity;
    for (let at = 0; at <= built.length; at++) {
      const candidate = [...built.slice(0, at), id, ...built.slice(at)];
      const s = consider([...candidate, ...tail]);
      if (s < chosenScore) {
        chosenScore = s;
        chosen = candidate;
      }
    }
    built = chosen;
  });
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i + 1 < best.sequence.length; i++) {
      const next = [...best.sequence];
      [next[i], next[i + 1]] = [next[i + 1], next[i]];
      const before = best.score;
      consider(next);
      if (best.score < before) improved = true;
    }
  }
  return best;
}

export function plan(jobs: Job[], sequence: string[], options: Options): Plan {
  const queued = jobs.filter((j) => !isStarted(j));
  const score = (s: string[]) => metrics(schedule(jobs, s, options)).score;
  const currentSlots = schedule(jobs, sequence, options);
  const currentMetrics = metrics(currentSlots);
  // Ties keep the current queue, so the kitchen is never reshuffled for nothing.
  const start: Search = { sequence, score: currentMetrics.score, examined: 1 };
  const useExact = queued.length <= EXACT_LIMIT;
  const found = useExact
    ? exact(sequence, score, start)
    : heuristic(queued, sequence, score, start);
  const bestSlots = schedule(jobs, found.sequence, options);
  const bestMetrics = metrics(bestSlots);
  const waiting = (m: Metrics) => m.wait + m.lateness + m.aged + m.quality;
  return {
    current: { sequence, slots: currentSlots, metrics: currentMetrics },
    best: { sequence: found.sequence, slots: bestSlots, metrics: bestMetrics },
    examined: found.examined,
    method: useExact ? "exact" : "heuristic",
    shouldChange:
      currentMetrics.score - bestMetrics.score >= MIN_GAIN &&
      waiting(bestMetrics) < waiting(currentMetrics),
  };
}
