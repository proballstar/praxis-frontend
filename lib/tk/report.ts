import { Db } from "./db";

export type Report = {
  handedOff: number;
  sealedOnTime: number;
  sealedLate: number;
  /** Average minutes the bag was sealed after its target (negative means early). */
  avgMinutesAfterTarget: number | null;
  remakes: number;
  inferredStarts: number;
  earlyOverrides: number;
  withdrawn: number;
  rejectedCodes: number;
};

const count = (db: Db, type: string) =>
  db.get<{ c: number }>(
    "SELECT COUNT(*) AS c FROM events e LEFT JOIN orders o ON o.id = e.order_id WHERE e.type = ? AND COALESCE(o.sample, 0) = 0",
    type,
  )!.c;

/** Observed results only, from what staff actually recorded. Sample orders never count. */
export function shiftReport(db: Db): Report {
  const sealed = db
    .all<{ payload: string }>(
      "SELECT e.payload FROM events e JOIN orders o ON o.id = e.order_id WHERE e.type = 'sealed' AND o.sample = 0",
    )
    .map((e) => JSON.parse(e.payload) as { minutesAfterTarget: number });
  const late = sealed.filter((s) => s.minutesAfterTarget > 0).length;
  const inferred = db
    .all<{ payload: string }>(
      "SELECT e.payload FROM events e JOIN orders o ON o.id = e.order_id WHERE e.type = 'task_done' AND o.sample = 0",
    )
    .filter((e) => (JSON.parse(e.payload) as { inferredStart?: boolean }).inferredStart).length;
  return {
    handedOff: db.get<{ c: number }>("SELECT COUNT(*) AS c FROM orders WHERE status = 'HANDED_OFF' AND sample = 0")!.c,
    sealedOnTime: sealed.length - late,
    sealedLate: late,
    avgMinutesAfterTarget: sealed.length
      ? sealed.reduce((n, s) => n + s.minutesAfterTarget, 0) / sealed.length
      : null,
    remakes: count(db, "remake"),
    inferredStarts: inferred,
    earlyOverrides: count(db, "early_done_override"),
    withdrawn: count(db, "withdrawn"),
    rejectedCodes: count(db, "handoff_rejected"),
  };
}
