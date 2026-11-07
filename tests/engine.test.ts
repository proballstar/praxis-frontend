import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AGING_LIMIT,
  HOLD_BUFFER,
  Job,
  Options,
  Resource,
  Slot,
  Task,
  metrics,
  plan,
  schedule,
} from "../lib/engine";

const line = (capacity = 1): Options => ({
  resources: [{ id: "line", capacity }],
});
const task = (id: string, minutes: number, extra: Partial<Task> = {}): Task => ({
  id,
  resource: "line",
  minutes,
  state: "pending",
  ...extra,
});

/** The eight-minute-delay reference case: one lane, one ticket running over. */
const delayed = (): Job[] => [
  { id: "1042", tasks: [task("a", 14, { state: "cooking" })], arrival: 6, deadline: 8 },
  { id: "1043", tasks: [task("b", 12)], arrival: 22, deadline: 24 },
  { id: "1044", tasks: [task("c", 4)], arrival: 14, deadline: 16 },
];

function assertCapacity(jobs: Job[], slots: Slot[], resources: Resource[]) {
  for (const r of resources) {
    const tasks = slots.flatMap((s) => s.tasks).filter((t) => t.resource === r.id);
    const end = Math.max(0, ...tasks.map((t) => t.end));
    for (let t = 0; t < end; t++) {
      const load = tasks.filter((x) => x.start <= t && t < x.end).length;
      const limit =
        r.down && t < r.down.until ? r.capacity - r.down.units : r.capacity;
      const running = jobs
        .flatMap((j) => j.tasks)
        .filter((x) => x.state === "cooking" && x.resource === r.id).length;
      assert.ok(load <= Math.max(limit, running), `${r.id}@${t}: ${load}`);
    }
  }
}

test("keeps the reference result: 28/22 becomes 20/14", () => {
  const p = plan(delayed(), ["1043", "1044"], line());
  assert.equal(p.current.metrics.wait, 28);
  assert.equal(p.current.metrics.lateness, 22);
  assert.deepEqual(p.best.sequence, ["1044", "1043"]);
  assert.equal(p.best.metrics.wait, 20);
  assert.equal(p.best.metrics.lateness, 14);
  assert.equal(p.method, "exact");
  assert.equal(p.shouldChange, true);
});

test("dishes on one ticket finish together, longest first", () => {
  const options: Options = {
    resources: [
      { id: "grill", capacity: 2 },
      { id: "fryer", capacity: 2 },
    ],
  };
  const jobs: Job[] = [
    {
      id: "t",
      tasks: [
        task("burger", 8, { resource: "grill" }),
        task("fries", 4, { resource: "fryer" }),
      ],
      arrival: 0,
      deadline: 5,
    },
  ];
  const [slot] = schedule(jobs, ["t"], options);
  const [burger, fries] = slot.tasks;
  assert.equal(burger.start, 0);
  assert.equal(fries.start, 4);
  assert.equal(burger.end, fries.end);
  assert.equal(slot.ready, 8);
});

test("resource capacity is respected, including units within a ticket", () => {
  const resources = [{ id: "fryer", capacity: 2 }];
  const jobs: Job[] = [
    {
      id: "t",
      tasks: [1, 2, 3, 4, 5].map((n) =>
        task(`f${n}`, 3, { resource: "fryer" }),
      ),
      arrival: 0,
      deadline: 20,
    },
  ];
  const slots = schedule(jobs, ["t"], { resources });
  assertCapacity(jobs, slots, resources);
  assert.equal(slots[0].end, 9);
});

test("a contended resource delays only tickets that need it", () => {
  const options: Options = {
    resources: [
      { id: "oven", capacity: 1 },
      { id: "cold", capacity: 1 },
    ],
  };
  const jobs: Job[] = [
    { id: "a", tasks: [task("p1", 12, { resource: "oven" })], arrival: 0, deadline: 12 },
    { id: "b", tasks: [task("p2", 12, { resource: "oven" })], arrival: 0, deadline: 24 },
    { id: "c", tasks: [task("s", 3, { resource: "cold" })], arrival: 0, deadline: 3 },
  ];
  const slots = schedule(jobs, ["a", "b", "c"], options);
  assert.equal(slots.find((s) => s.id === "b")!.end, 24);
  assert.equal(slots.find((s) => s.id === "c")!.end, 3);
});

test("a resource outage pushes new work, never the work already running", () => {
  const down: Resource[] = [
    { id: "fryer", capacity: 2, down: { units: 2, until: 10 } },
  ];
  const jobs: Job[] = [
    {
      id: "running",
      tasks: [task("r", 4, { resource: "fryer", state: "cooking" })],
      arrival: 4,
      deadline: 8,
    },
    { id: "next", tasks: [task("n", 3, { resource: "fryer" })], arrival: 0, deadline: 9 },
  ];
  const slots = schedule(jobs, ["next"], { resources: down });
  assert.equal(slots[0].end, 4);
  assert.equal(slots[1].tasks[0].start, 10);
  assertCapacity(jobs, slots, down);
});

test("holds a ticket with a distant courier instead of cooking it early", () => {
  const jobs: Job[] = [
    { id: "later", tasks: [task("t", 10)], arrival: 40, deadline: 45 },
  ];
  const [slot] = schedule(jobs, ["later"], line());
  assert.equal(slot.start, 30 - HOLD_BUFFER);
  assert.equal(slot.held, true);
  assert.equal(slot.foodIdle, HOLD_BUFFER);
});

test("the hold buffer is the kitchen's setting", () => {
  const jobs: Job[] = [
    { id: "later", tasks: [task("t", 10)], arrival: 40, deadline: 45 },
  ];
  const [slot] = schedule(jobs, ["later"], { ...line(), holdBuffer: 5 });
  assert.equal(slot.start, 25);
});

test("no hold on an unknown or stale courier ETA", () => {
  const jobs: Job[] = [
    { id: "x", tasks: [task("t", 10)], arrival: 40, deadline: 45, holdable: false },
  ];
  const [slot] = schedule(jobs, ["x"], line());
  assert.equal(slot.start, 0);
  assert.equal(slot.held, false);
});

test("a held ticket does not block one that can start", () => {
  const jobs: Job[] = [
    { id: "later", tasks: [task("l", 10)], arrival: 40, deadline: 45 },
    { id: "now", tasks: [task("n", 5)], arrival: 5, deadline: 8 },
  ];
  const slots = schedule(jobs, ["later", "now"], line());
  assert.equal(slots.find((s) => s.id === "now")!.tasks[0].start, 0);
  assert.equal(metrics(slots).late, 0);
});

test("a courier already here is never held", () => {
  const [slot] = schedule(
    [{ id: "x", tasks: [task("t", 4)], arrival: -3, deadline: 2 }],
    ["x"],
    line(),
  );
  assert.equal(slot.start, 0);
  assert.equal(slot.held, false);
});

test("packing delays pickup readiness but not the resource", () => {
  const jobs: Job[] = [
    { id: "a", tasks: [task("a1", 5)], pack: 3, arrival: 6, deadline: 8 },
    { id: "b", tasks: [task("b1", 2)], arrival: 5, deadline: 9 },
  ];
  const slots = schedule(jobs, ["a", "b"], line());
  const a = slots.find((s) => s.id === "a")!;
  assert.equal(a.end, 5);
  assert.equal(a.ready, 8);
  assert.equal(a.driverWait, 2);
  assert.equal(a.late, 0);
  assert.equal(slots.find((s) => s.id === "b")!.tasks[0].start, 5);
});

test("quality: dishes past their window are counted per dish at handoff", () => {
  const options: Options = {
    resources: [
      { id: "fryer", capacity: 1 },
      { id: "grill", capacity: 1 },
    ],
  };
  const jobs: Job[] = [
    {
      id: "t",
      tasks: [
        task("fries", 4, { resource: "fryer", quality: 5, state: "done", finished: -8 }),
        task("burger", 3, { resource: "grill", quality: 20 }),
      ],
      arrival: 6,
      deadline: 10,
    },
  ];
  const [slot] = schedule(jobs, [], options);
  // Fries finished 8 min ago; handoff is in 6, so they are 14 old with a 5-minute window.
  assert.equal(slot.tasks[0].over, 9);
  assert.equal(slot.tasks[1].over, 0);
  assert.equal(slot.quality, 9);
});

test("the planner prefers a sequence that protects fragile dishes", () => {
  const options: Options = { resources: [{ id: "fryer", capacity: 1 }] };
  const fragile: Job = {
    id: "fragile",
    tasks: [task("f", 4, { resource: "fryer", quality: 1 })],
    arrival: 4,
    deadline: 8,
  };
  const sturdy: Job = {
    id: "sturdy",
    tasks: [task("s", 4, { resource: "fryer", quality: 60 })],
    arrival: 8,
    deadline: 20,
  };
  const p = plan([sturdy, fragile], ["sturdy", "fragile"], options);
  assert.equal(p.best.sequence[0], "fragile");
  assert.equal(p.best.metrics.quality, 0);
});

test("aging counts only past the limit and never a deliberate hold", () => {
  const old: Job = {
    id: "old",
    tasks: [task("o", 3)],
    arrival: 5,
    deadline: 9,
    received: -30,
  };
  const [slot] = schedule([old], ["old"], line());
  assert.equal(slot.aged, 30 - AGING_LIMIT);
  assert.equal(metrics([slot]).aged, 10);

  const held: Job = { ...old, arrival: 40, deadline: 44, received: -60 };
  const [heldSlot] = schedule([held], ["old"], line());
  assert.equal(heldSlot.held, true);
  assert.equal(heldSlot.aged, 0);
});

test("started tickets keep their place; only queued tickets can move", () => {
  const jobs: Job[] = [
    {
      id: "partial",
      tasks: [
        task("a", 5, { state: "cooking" }),
        task("b", 5),
      ],
      arrival: 30,
      deadline: 32,
    },
    { id: "urgent", tasks: [task("c", 2)], arrival: 2, deadline: 3 },
  ];
  const p = plan(jobs, ["urgent"], line());
  assert.deepEqual(p.best.sequence, ["urgent"]);
  assert.equal(p.best.slots[0].id, "partial");
  assert.equal(p.best.slots[0].tasks[0].start, 0);
});

test("a half-started ticket cannot overbook its own resource", () => {
  const jobs: Job[] = [
    {
      id: "t",
      tasks: [task("a", 6, { state: "cooking" }), task("b", 4)],
      arrival: 0,
      deadline: 30,
    },
  ];
  const slots = schedule(jobs, [], line());
  assert.equal(slots[0].tasks[1].start, 6);
  assertCapacity(jobs, slots, line().resources);
});

test("exact search matches brute force on every ordering", () => {
  const options = line(2);
  const jobs: Job[] = [
    { id: "a", tasks: [task("a1", 9)], arrival: 5, deadline: 8 },
    { id: "b", tasks: [task("b1", 3)], arrival: 4, deadline: 6 },
    { id: "c", tasks: [task("c1", 7)], arrival: 20, deadline: 25 },
    { id: "d", tasks: [task("d1", 5)], arrival: 9, deadline: 12 },
  ];
  const all: string[][] = [];
  const walk = (p: string[], r: string[]) =>
    r.length
      ? r.forEach((x) => walk([...p, x], r.filter((y) => y !== x)))
      : all.push(p);
  walk([], ["a", "b", "c", "d"]);
  const lowest = Math.min(
    ...all.map((s) => metrics(schedule(jobs, s, options)).score),
  );
  assert.equal(plan(jobs, ["a", "b", "c", "d"], options).best.metrics.score, lowest);
});

test("never reshuffles for a tie or a trivial gain", () => {
  const jobs: Job[] = [
    { id: "a", tasks: [task("a1", 5)], arrival: 5, deadline: 8 },
    { id: "b", tasks: [task("b1", 5)], arrival: 5, deadline: 8 },
  ];
  const p = plan(jobs, ["b", "a"], line(2));
  assert.deepEqual(p.best.sequence, ["b", "a"]);
  assert.equal(p.shouldChange, false);
});

const rush = (n: number): Job[] =>
  Array.from({ length: n }, (_, i) => {
    const arrival = (i * 37) % 90;
    return {
      id: `o${String(i).padStart(2, "0")}`,
      tasks: [
        task(`o${i}a`, 3 + ((i * 13) % 12), { resource: "grill", quality: 15 }),
        task(`o${i}b`, 3 + ((i * 5) % 5), { resource: "fryer", quality: 6 }),
        task(`o${i}c`, 2, { resource: "cold", quality: 30 }),
      ],
      pack: 2,
      arrival,
      deadline: arrival + 5,
    };
  });
const rushOptions: Options = {
  resources: [
    { id: "grill", capacity: 3 },
    { id: "fryer", capacity: 2 },
    { id: "cold", capacity: 2 },
  ],
};

test("a rush of 40 tickets stays feasible, fast and deterministic", () => {
  const jobs = rush(40);
  const sequence = jobs.map((j) => j.id);
  const started = performance.now();
  const p = plan(jobs, sequence, rushOptions);
  assert.ok(performance.now() - started < 1500);
  assert.equal(p.method, "heuristic");
  assertCapacity(jobs, p.best.slots, rushOptions.resources);
  assert.ok(p.best.metrics.score < p.current.metrics.score);
  assert.deepEqual(p, plan(jobs, sequence, rushOptions));
});

test("the heuristic lands close to exact on a queue exact can still solve", () => {
  const jobs = rush(7);
  const ids = jobs.map((j) => j.id);
  const score = (s: string[]) => metrics(schedule(jobs, s, rushOptions)).score;
  let lowest = Infinity;
  const walk = (p: string[], r: string[]) => {
    if (!r.length) lowest = Math.min(lowest, score(p));
    else r.forEach((x) => walk([...p, x], r.filter((y) => y !== x)));
  };
  walk([], ids);
  const found = plan(jobs, ids, rushOptions);
  assert.equal(found.method, "heuristic");
  assert.ok(
    found.best.metrics.score <= lowest * 1.1,
    `${found.best.metrics.score} vs optimal ${lowest}`,
  );
});

test("rejects malformed sequences and unknown resources", () => {
  assert.throws(() => schedule(delayed(), ["1043", "1043"], line()));
  assert.throws(() => schedule(delayed(), ["1043"], line()));
  assert.throws(() =>
    schedule(delayed(), ["1043", "1044"], { resources: [{ id: "x", capacity: 1 }] }),
  );
  assert.throws(() =>
    schedule(delayed(), ["1043", "1044"], { resources: [{ id: "line", capacity: 0 }] }),
  );
});
