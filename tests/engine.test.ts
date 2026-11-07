import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HOLD_BUFFER,
  Job,
  MIN_GAIN,
  Slot,
  metrics,
  plan,
  schedule,
} from "../lib/engine";

/** The eight-minute-delay fixture from the original demo, at "now" = 0. */
const delayed = (): Job[] => [
  { id: "1042", remaining: 14, arrival: 6, deadline: 8, station: 1 },
  { id: "1043", remaining: 12, arrival: 22, deadline: 24 },
  { id: "1044", remaining: 4, arrival: 14, deadline: 16 },
];

function assertFeasible(jobs: Job[], slots: Slot[], stations: number) {
  assert.equal(slots.length, jobs.length);
  assert.equal(new Set(slots.map((s) => s.id)).size, jobs.length);
  for (const a of slots) {
    const job = jobs.find((j) => j.id === a.id)!;
    assert.ok(a.start >= 0);
    assert.equal(a.end - a.start, job.remaining);
    assert.ok(a.lane < stations);
    if (job.station !== undefined) {
      assert.equal(a.start, 0);
      assert.equal(a.lane, job.station - 1);
    }
    for (const b of slots)
      if (b !== a && b.lane === a.lane)
        assert.ok(a.end <= b.start || b.end <= a.start, `${a.id}/${b.id}`);
  }
}

test("keeps the known delay result: FCFS 28/22, recommended 20/14", () => {
  const p = plan(delayed(), ["1043", "1044"], { stations: 1 });
  assert.equal(p.current.metrics.wait, 28);
  assert.equal(p.current.metrics.lateness, 22);
  assert.deepEqual(p.best.sequence, ["1044", "1043"]);
  assert.equal(p.best.metrics.wait, 20);
  assert.equal(p.best.metrics.lateness, 14);
  assert.equal(p.method, "exact");
  assert.equal(p.examined, 3);
  assert.equal(p.shouldChange, true);
});

test("exact search matches brute force on every ordering", () => {
  const jobs: Job[] = [
    { id: "a", remaining: 9, arrival: 5, deadline: 8 },
    { id: "b", remaining: 3, arrival: 4, deadline: 6 },
    { id: "c", remaining: 7, arrival: 20, deadline: 25 },
    { id: "d", remaining: 5, arrival: 9, deadline: 12 },
  ];
  const all: string[][] = [];
  const walk = (p: string[], r: string[]) =>
    r.length
      ? r.forEach((x) => walk([...p, x], r.filter((y) => y !== x)))
      : all.push(p);
  walk([], ["a", "b", "c", "d"]);
  const options = { stations: 2 };
  const lowest = Math.min(
    ...all.map((s) => metrics(schedule(jobs, s, options)).score),
  );
  const p = plan(jobs, ["a", "b", "c", "d"], options);
  assert.equal(p.best.metrics.score, lowest);
  assert.equal(p.examined, 25);
});

test("never reshuffles for a tie or a trivial gain", () => {
  const jobs: Job[] = [
    { id: "a", remaining: 5, arrival: 5, deadline: 8 },
    { id: "b", remaining: 5, arrival: 5, deadline: 8 },
  ];
  const p = plan(jobs, ["b", "a"], { stations: 2 });
  assert.deepEqual(p.best.sequence, ["b", "a"]);
  assert.equal(p.shouldChange, false);
  assert.ok(MIN_GAIN > 0);
});

test("holds an order with a distant courier instead of cooking it early", () => {
  const jobs: Job[] = [{ id: "later", remaining: 10, arrival: 40, deadline: 45 }];
  const [slot] = schedule(jobs, ["later"], { stations: 1 });
  assert.equal(slot.start, 30 - HOLD_BUFFER);
  assert.equal(slot.held, true);
  assert.equal(slot.foodIdle, HOLD_BUFFER);
});

test("a held order does not block a station for orders that can start", () => {
  const jobs: Job[] = [
    { id: "later", remaining: 10, arrival: 40, deadline: 45 },
    { id: "now", remaining: 5, arrival: 5, deadline: 8 },
  ];
  const p = plan(jobs, ["later", "now"], { stations: 1 });
  assert.equal(p.best.sequence[0], "now");
  assert.equal(p.best.metrics.late, 0);
  assert.equal(p.best.metrics.wait, 0);
});

test("a courier already here is never held", () => {
  const [slot] = schedule(
    [{ id: "x", remaining: 4, arrival: -3, deadline: 2 }],
    ["x"],
    { stations: 1 },
  );
  assert.equal(slot.start, 0);
  assert.equal(slot.held, false);
});

test("cooking orders stay on their station; capacity and overlap hold", () => {
  for (const stations of [1, 2, 3, 6]) {
    const p = plan(delayed(), ["1043", "1044"], { stations });
    assertFeasible(delayed(), p.best.slots, stations);
    assert.ok(p.best.metrics.score <= p.current.metrics.score);
  }
  const jobs = [
    { id: "a", remaining: 4, arrival: 9, deadline: 9, station: 2 },
    { id: "b", remaining: 4, arrival: 2, deadline: 2 },
  ];
  assert.equal(schedule(jobs, ["b"], { stations: 2 })[1].lane, 0);
});

test("a dinner-rush queue of 40 stays feasible, fast and deterministic", () => {
  const jobs: Job[] = Array.from({ length: 40 }, (_, i) => {
    const arrival = (i * 37) % 90;
    return {
      id: `o${String(i).padStart(2, "0")}`,
      remaining: 3 + ((i * 13) % 14),
      arrival,
      deadline: arrival + 5,
    };
  });
  const sequence = jobs.map((j) => j.id);
  const started = performance.now();
  const p = plan(jobs, sequence, { stations: 4 });
  assert.ok(performance.now() - started < 1500);
  assert.equal(p.method, "heuristic");
  assertFeasible(jobs, p.best.slots, 4);
  assert.ok(p.best.metrics.score < p.current.metrics.score);
  assert.deepEqual(p, plan(jobs, sequence, { stations: 4 }));
});

test("the heuristic lands close to exact on a queue exact can still solve", () => {
  const jobs: Job[] = Array.from({ length: 8 }, (_, i) => {
    const arrival = 4 + ((i * 11) % 30);
    return {
      id: `o${i}`,
      remaining: 3 + ((i * 7) % 9),
      arrival,
      deadline: arrival + 4,
    };
  });
  const ids = jobs.map((j) => j.id);
  const options = { stations: 2 };
  const score = (s: string[]) => metrics(schedule(jobs, s, options)).score;
  let lowest = Infinity;
  const walk = (p: string[], r: string[]) => {
    if (!r.length) lowest = Math.min(lowest, score(p));
    else r.forEach((x) => walk([...p, x], r.filter((y) => y !== x)));
  };
  walk([], ids);
  const found = plan(jobs, ids, options);
  assert.equal(found.method, "heuristic");
  assert.ok(
    found.best.metrics.score <= lowest * 1.1,
    `${found.best.metrics.score} vs optimal ${lowest}`,
  );
});

test("rejects malformed sequences and impossible station use", () => {
  const options = { stations: 1 };
  assert.throws(() => schedule(delayed(), ["1043", "1043"], options));
  assert.throws(() => schedule(delayed(), ["1043"], options));
  assert.throws(() => schedule(delayed(), ["1043", "1044"], { stations: 0 }));
  assert.throws(() =>
    schedule(
      [
        { id: "a", remaining: 1, arrival: 1, deadline: 1, station: 1 },
        { id: "b", remaining: 1, arrival: 1, deadline: 1, station: 1 },
      ],
      [],
      { stations: 2 },
    ),
  );
});

test("packing delays pickup readiness but not the station", () => {
  const jobs: Job[] = [
    { id: "a", remaining: 5, pack: 3, arrival: 6, deadline: 8 },
    { id: "b", remaining: 2, arrival: 5, deadline: 9 },
  ];
  const slots = schedule(jobs, ["a", "b"], { stations: 1 });
  const a = slots.find((s) => s.id === "a")!;
  assert.equal(a.end, 5);
  assert.equal(a.ready, 8);
  assert.equal(a.driverWait, 2);
  assert.equal(a.late, 0);
  // Station is free as soon as cooking ends, while packing is still running.
  assert.equal(slots.find((s) => s.id === "b")!.start, 5);
});

test("food sitting and courier wait are opposite sides of the same gap", () => {
  const [early] = schedule(
    [{ id: "x", remaining: 4, arrival: 10, deadline: 12 }],
    ["x"],
    { stations: 1 },
  );
  // Held: cooking starts 2 minutes before the 6-minute-away courier.
  assert.equal(early.held, true);
  assert.equal(early.foodIdle, 2);
  assert.equal(early.driverWait, 0);
});

test("aging only counts time past the limit, and is reported separately", () => {
  const jobs: Job[] = [
    { id: "old", remaining: 3, arrival: 5, deadline: 9, received: -30 },
    { id: "new", remaining: 3, arrival: 5, deadline: 9, received: 0 },
  ];
  const slots = schedule(jobs, ["old", "new"], { stations: 1 });
  assert.equal(slots[0].aged, 10);
  assert.equal(slots[1].aged, 0);
  const m = metrics(slots);
  assert.equal(m.aged, 10);
  assert.equal(m.score, metrics(slots.map((s) => ({ ...s, aged: 0 }))).score + 30);
});

test("a deliberately held order does not age", () => {
  const jobs: Job[] = [
    { id: "later", remaining: 6, arrival: 40, deadline: 42, received: -60 },
  ];
  const [slot] = schedule(jobs, ["later"], { stations: 1 });
  assert.equal(slot.held, true);
  assert.equal(slot.aged, 0);
});

test("the planner never picks a plan with more aging than the current one", () => {
  const jobs: Job[] = [
    { id: "old", remaining: 6, arrival: 8, deadline: 10, received: -60 },
    { id: "fresh1", remaining: 6, arrival: 8, deadline: 10, received: 0 },
    { id: "fresh2", remaining: 6, arrival: 8, deadline: 10, received: 0 },
  ];
  const p = plan(jobs, ["fresh1", "fresh2", "old"], { stations: 1 });
  assert.ok(p.best.metrics.score <= p.current.metrics.score);
  assert.ok(p.best.metrics.aged <= p.current.metrics.aged);
});
