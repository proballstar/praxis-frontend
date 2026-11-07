/**
 * Deterministic preparation planner. Pure: no clock, storage, or AI.
 * All times are whole minutes relative to `now` (0 unless a caller says otherwise).
 *
 * Definitions (see README "Planner definitions"):
 * - remaining: cooking minutes still needed on a station. A station is one
 *   preparation lane; any lane can cook any queued order.
 * - pack: packing minutes after cooking ends, before the order is ready for
 *   pickup. Packing does not occupy the station.
 * - ready = cooking end + pack.
 * - courier wait: minutes the courier stands at the counter before ready.
 * - food sitting: minutes ready food waits for the courier to arrive.
 * - late: minutes ready after the pickup deadline.
 * - aged: minutes an order has waited past AGING_LIMIT before cooking starts.
 */
export type Job = {
  id: string;
  /** Minutes of cooking work left. */
  remaining: number;
  /** Packing minutes after cooking ends. Defaults to 0. */
  pack?: number;
  /** When the courier is expected. */
  arrival: number;
  /** Latest acceptable pickup-ready time. */
  deadline: number;
  /** When the order was received. Used only for aging. Omit to skip aging. */
  received?: number;
  /** Cooking on this 1-based station. Never moved or interrupted. */
  station?: number;
};

export type Slot = {
  id: string;
  lane: number;
  start: number;
  end: number;
  /** Ready for pickup (end + packing). */
  ready: number;
  driverWait: number;
  foodIdle: number;
  late: number;
  aged: number;
  /** Deliberately not started yet, so food is not ready long before the courier. */
  held: boolean;
};

export type Metrics = {
  wait: number;
  idle: number;
  late: number;
  lateness: number;
  aged: number;
  score: number;
};

export type Plan = {
  current: { sequence: string[]; slots: Slot[]; metrics: Metrics };
  best: { sequence: string[]; slots: Slot[]; metrics: Metrics };
  examined: number;
  method: "exact" | "heuristic";
  /** The best sequence is enough better to interrupt the kitchen. */
  shouldChange: boolean;
};

export type Options = { stations: number; now?: number };

export const WEIGHTS = { late: 5, wait: 2, idle: 1, aged: 3 };
/** An order may wait this long for a station before aging penalties start. */
export const AGING_LIMIT = 20;
/** Start held orders this long before the courier, as cover for estimates running over. */
export const HOLD_BUFFER = 2;
/** Above this many queued orders, exhaustive search is replaced by the heuristic. */
export const EXACT_LIMIT = 7;
/** Roughly three courier-minutes: small gains are not worth reshuffling a busy line. */
export const MIN_GAIN = 6;

const isActive = (j: Job) => j.station !== undefined;

export function schedule(
  jobs: Job[],
  sequence: string[],
  { stations, now = 0 }: Options,
): Slot[] {
  if (!Number.isInteger(stations) || stations < 1)
    throw Error("At least one station is required.");
  const active = jobs.filter(isActive);
  const queued = jobs.filter((j) => !isActive(j));
  if (active.length > stations)
    throw Error("More orders are cooking than there are stations.");
  if (
    new Set(sequence).size !== sequence.length ||
    sequence.length !== queued.length ||
    sequence.some((id) => !queued.some((j) => j.id === id))
  )
    throw Error("Every queued order must be scheduled exactly once.");

  const free = Array<number>(stations).fill(now);
  const slots: Slot[] = [];
  const place = (j: Job, lane: number, start: number, held: boolean) => {
    const end = start + j.remaining;
    const ready = end + (j.pack ?? 0);
    free[lane] = end;
    slots.push({
      id: j.id,
      lane,
      start,
      end,
      ready,
      driverWait: Math.max(0, ready - j.arrival),
      foodIdle: Math.max(0, j.arrival - ready),
      late: Math.max(0, ready - j.deadline),
      // A deliberate hold is not neglect, so only unheld waiting ages.
      aged:
        j.received === undefined || held
          ? 0
          : Math.max(0, start - j.received - AGING_LIMIT),
      held,
    });
  };

  for (const j of active) {
    const lane = j.station! - 1;
    if (lane < 0 || lane >= stations || free[lane] !== now)
      throw Error("Cooking orders need distinct stations.");
    place(j, lane, now, false);
  }
  const byId = new Map(queued.map((j) => [j.id, j]));
  for (const id of sequence) {
    const j = byId.get(id)!;
    const lane = free.indexOf(Math.min(...free));
    const fire = j.arrival - (j.pack ?? 0) - j.remaining - HOLD_BUFFER;
    const start = Math.max(free[lane], now, fire);
    place(j, lane, start, fire > free[lane] && fire > now);
  }
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
      score:
        m.score +
        s.late * WEIGHTS.late +
        s.driverWait * WEIGHTS.wait +
        s.foodIdle * WEIGHTS.idle +
        s.aged * WEIGHTS.aged,
    }),
    { wait: 0, idle: 0, late: 0, lateness: 0, aged: 0, score: 0 },
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
  // Each prefix is completed with the remaining urgent orders, so the
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
  const queued = jobs.filter((j) => !isActive(j));
  const score = (s: string[]) => metrics(schedule(jobs, s, options)).score;
  const currentSlots = schedule(jobs, sequence, options);
  const currentMetrics = metrics(currentSlots);
  // Ties keep the current queue, so the kitchen is never reshuffled for nothing.
  const start: Search = {
    sequence,
    score: currentMetrics.score,
    examined: 1,
  };
  const useExact = queued.length <= EXACT_LIMIT;
  const found = useExact
    ? exact(sequence, score, start)
    : heuristic(queued, sequence, score, start);
  const bestSlots = schedule(jobs, found.sequence, options);
  const bestMetrics = metrics(bestSlots);
  const waiting = (m: Metrics) => m.wait + m.lateness + m.aged;
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
