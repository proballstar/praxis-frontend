import { test } from "node:test";
import assert from "node:assert/strict";
import { tk } from "../lib/tk/api";
import { closeDb, openDb } from "../lib/tk/db";
import { buildSnapshot } from "../lib/tk/snapshot";
import { replan, runSolver } from "../lib/tk/planner";
import { TaskRow } from "../lib/tk/types";
import { MIN, T0, ZONE, fresh } from "./tk-helpers";
import { clockParts, formatTime } from "../lib/tk/time";

const rows = (db: ReturnType<typeof fresh>["db"], id: string) =>
  db.all<TaskRow>("SELECT * FROM tasks WHERE order_id = ? ORDER BY created_ms, id", id);

const burger = (eta: number) => ({
  channel: "delivery" as const,
  etaMinutes: eta,
  items: [{ recipe: "burger", qty: 1 }],
});

test("9a. a missed start is flagged without rewriting the receipt", async () => {
  const f = fresh();
  const a = await tk.createOrder(f.db, burger(20));
  await tk.issue(f.db, a.orderId);
  const before = rows(f.db, a.orderId).map((t) => [t.planned_start_ms, t.planned_end_ms]);
  const planned = rows(f.db, a.orderId).find((t) => t.name === "Grill burger")!.planned_start_ms!;
  f.set(planned + 6 * MIN);
  const snap = await buildSnapshot(f.db);
  const o = snap.orders[0];
  assert.deepEqual(o.plan.missedStarts, ["Grill burger"]);
  assert.ok(snap.warnings.some((w) => w.includes("should have started already")));
  assert.deepEqual(rows(f.db, a.orderId).map((t) => [t.planned_start_ms, t.planned_end_ms]), before, "receipt unchanged");
  const task = o.tasks.find((t) => t.name === "Grill burger")!;
  assert.equal(task.slid, true);
  assert.ok(task.projectedStartMs! > task.plannedStartMs!);
  assert.ok(o.plan.slippedMin >= 5);
  closeDb(f.file);
});

test("9b. equipment loss reroutes drafts but never rewrites issued work", async () => {
  const f = fresh();
  const issued = await tk.createOrder(f.db, burger(20));
  await tk.issue(f.db, issued.orderId);
  const issuedBefore = rows(f.db, issued.orderId).map((t) => [t.planned_start_ms, t.planned_end_ms]);
  const draft = await tk.createOrder(f.db, { channel: "walk_in", promisedMinutes: 20, items: [{ recipe: "burger", qty: 2 }] });
  const startsBefore = rows(f.db, draft.orderId).filter((t) => t.kind === "food").map((t) => t.planned_start_ms!);

  // Both grill units go down for 30 minutes.
  await tk.capacity(f.db, { kind: "station", id: "grill", unitsOut: 2, minutes: 30 });
  const snap = await buildSnapshot(f.db);
  assert.equal(snap.stations.find((s) => s.id === "grill")!.outage?.unitsOut, 2);
  assert.deepEqual(rows(f.db, issued.orderId).map((t) => [t.planned_start_ms, t.planned_end_ms]), issuedBefore);
  // The locked burger is still using a unit that is now "gone", so the app asks for review.
  assert.ok(snap.warnings.some((w) => /Locked work needs more Grill/.test(w)), snap.warnings.join("|"));
  const draftStarts = rows(f.db, draft.orderId).filter((t) => t.kind === "food").map((t) => t.planned_start_ms!);
  assert.ok(Math.min(...draftStarts) >= T0 + 30 * MIN, "no draft burger is planned during the outage");
  assert.notDeepEqual(draftStarts, startsBefore);

  await tk.capacity(f.db, { kind: "station", id: "grill", unitsOut: 0 });
  assert.equal((await buildSnapshot(f.db)).stations.find((s) => s.id === "grill")!.outage, null);
  await assert.rejects(() => tk.capacity(f.db, { kind: "station", id: "grill", unitsOut: 9 }), /Units out must be/);
  await assert.rejects(() => tk.capacity(f.db, { kind: "station", id: "nope", unitsOut: 1 }), /doesn't exist/);
  closeDb(f.file);
});

test("9c. shared staff is a real constraint, not just equipment", async () => {
  // One hot-line cook covers the grill, fryer and oven, so only one thing is attended at a time.
  const f = fresh((c) => {
    c.pools.find((p) => p.id === "hot")!.capacity = 1;
  });
  const a = await tk.createOrder(f.db, {
    channel: "walk_in",
    promisedMinutes: 25,
    items: [
      { recipe: "burger", qty: 2 },
      { recipe: "pizza", qty: 1 },
    ],
  });
  const t = rows(f.db, a.orderId).filter((x) => x.station_id === "grill");
  assert.equal(t.length, 2);
  const [x, y] = t;
  // Two burgers are attended the whole time, so one cook can't grill both at once.
  assert.ok(x.planned_end_ms! <= y.planned_start_ms! || y.planned_end_ms! <= x.planned_start_ms!);
  closeDb(f.file);
});

test("9d. two simultaneous seals never share a shelf slot", async () => {
  const f = fresh();
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) {
    const a = await tk.createOrder(f.db, { channel: "walk_in", customer: `Guest ${i}`, promisedMinutes: 15, items: [{ recipe: "soda", qty: 1 }] });
    await tk.issue(f.db, a.orderId);
    ids.push(a.orderId);
  }
  for (const id of ids) {
    for (const t of rows(f.db, id).filter((x) => x.kind !== "pack")) {
      f.set(Math.max(f.db.now(), t.planned_end_ms!));
      await tk.task(f.db, { taskId: t.id, action: "done" });
    }
    const o = (await buildSnapshot(f.db)).orders.find((x) => x.id === id)!;
    await tk.check(f.db, id, `item:${o.items[0].id}`, true);
    for (const r of o.reminders) await tk.check(f.db, id, `rem:${r.name}`, true);
  }
  const results = await Promise.all(ids.map((id) => tk.seal(f.db, id, { count: 1 })));
  const slots = results.map((r) => r.slot);
  assert.equal(new Set(slots).size, 4, `slots ${slots.join(",")}`);
  assert.deepEqual([...slots].sort(), ["S1", "S2", "S3", "S4"]);
  closeDb(f.file);
});

test("9e. a full shelf says so instead of double-booking", async () => {
  const f = fresh((c) => {
    c.shelfSlots = 1;
  });
  const make = async () => {
    const a = await tk.createOrder(f.db, { channel: "walk_in", promisedMinutes: 15, items: [{ recipe: "soda", qty: 1 }] });
    await tk.issue(f.db, a.orderId);
    const t = rows(f.db, a.orderId).find((x) => x.kind === "food")!;
    f.set(Math.max(f.db.now(), t.planned_end_ms!));
    await tk.task(f.db, { taskId: t.id, action: "done" });
    const o = (await buildSnapshot(f.db)).orders.find((x) => x.id === a.orderId)!;
    await tk.check(f.db, a.orderId, `item:${o.items[0].id}`, true);
    for (const r of o.reminders) await tk.check(f.db, a.orderId, `rem:${r.name}`, true);
    return a.orderId;
  };
  const one = await make();
  const two = await make();
  await tk.seal(f.db, one, { count: 1 });
  await assert.rejects(() => tk.seal(f.db, two, { count: 1 }), /shelf is full/);
  assert.equal((await buildSnapshot(f.db)).orders.find((o) => o.id === two)!.status, "RELEASED");
  closeDb(f.file);
});

test("9f. everything survives a restart, and a retried request does not repeat", async () => {
  const f = fresh();
  const created = await tk.createOrder(f.db, burger(20), { requestId: "req-1" });
  const again = await tk.createOrder(f.db, burger(20), { requestId: "req-1" });
  assert.equal(again.replayed, true);
  assert.equal(again.orderId, created.orderId);
  assert.equal(f.db.all("SELECT * FROM orders").length, 1, "the retry created nothing");
  await tk.issue(f.db, created.orderId, { requestId: "rel-1" });
  const rev = tk.rev(f.db);
  assert.equal((await tk.issue(f.db, created.orderId, { requestId: "rel-1" })).replayed, true);
  assert.equal(tk.rev(f.db), rev, "a replay changes nothing");
  const before = rows(f.db, created.orderId).map((t) => [t.id, t.status, t.planned_start_ms]);

  closeDb(f.file);
  const reopened = openDb(f.file);
  reopened.clock = f.db.clock;
  assert.deepEqual(rows(reopened, created.orderId).map((t) => [t.id, t.status, t.planned_start_ms]), before);
  const snap = await buildSnapshot(reopened);
  assert.equal(snap.orders[0].status, "RELEASED");
  assert.equal(snap.rev, rev);
  closeDb(f.file);
});

test("9g. a failed request leaves nothing half-done", async () => {
  const f = fresh();
  const rev = tk.rev(f.db);
  await assert.rejects(
    () =>
      tk.createOrder(f.db, {
        channel: "walk_in",
        promisedMinutes: 20,
        items: [
          { recipe: "burger", qty: 1 },
          { recipe: "unicorn steak", qty: 1 },
        ],
      }),
    /isn't on the menu/,
  );
  assert.equal(f.db.all("SELECT * FROM orders").length, 0);
  assert.equal(f.db.all("SELECT * FROM tasks").length, 0);
  assert.equal(tk.rev(f.db), rev);
  closeDb(f.file);
});

test("9h. a stale driver estimate is flagged and planned with a wider range", async () => {
  const f = fresh();
  const a = await tk.createOrder(f.db, burger(30));
  const fresh1 = (await buildSnapshot(f.db)).orders[0];
  assert.equal(fresh1.driver!.stale, false);
  f.advance(11);
  const snap = await buildSnapshot(f.db);
  const o = snap.orders[0];
  assert.equal(o.driver!.stale, true);
  assert.equal(o.driver!.ageMinutes, 11);
  assert.ok(snap.warnings.some((w) => w.includes("driver estimate is 11 min old")));
  assert.match(o.explanation.steps[0].detail, /widened because the estimate is stale/);
  await tk.updateEta(f.db, { orderId: a.orderId, minutesFromNow: 17, source: "driver app" });
  const refreshed = (await buildSnapshot(f.db)).orders[0];
  assert.equal(refreshed.driver!.stale, false);
  assert.equal(refreshed.driver!.source, "driver app");
  closeDb(f.file);
});

test("9i. when no plan can be found, earlier plans stay and a human is asked to review", async () => {
  const f = fresh();
  const a = await tk.createOrder(f.db, burger(20));
  const before = rows(f.db, a.orderId).map((t) => [t.planned_start_ms, t.planned_end_ms]);

  const original = process.env.PRAXIS_PYTHON;
  process.env.PRAXIS_PYTHON = "/definitely/not/python";
  try {
    const b = await tk.createOrder(f.db, burger(20));
    const snap = await buildSnapshot(f.db);
    assert.equal(snap.solver.last?.status, "error");
    assert.match(snap.solver.last!.warnings.join(" "), /scheduling engine isn't available/);
    assert.deepEqual(rows(f.db, a.orderId).map((t) => [t.planned_start_ms, t.planned_end_ms]), before);
    assert.ok(rows(f.db, b.orderId).every((t) => t.planned_start_ms === null), "no invented plan");
    await assert.rejects(() => tk.issue(f.db, b.orderId), /no plan yet/);
    assert.ok(f.db.get("SELECT 1 FROM events WHERE type = 'plan_failed'"));
  } finally {
    if (original === undefined) delete process.env.PRAXIS_PYTHON;
    else process.env.PRAXIS_PYTHON = original;
  }
  // Once the engine is back, the next plan fills the gap.
  await replan(f.db, "recovered");
  assert.ok(rows(f.db, a.orderId).every((t) => t.planned_start_ms !== null));
  closeDb(f.file);
});

test("9j. the solver reports infeasible and unknown honestly", async () => {
  const infeasible = await runSolver(
    {
      horizon: 10,
      seconds: 1,
      weights: { wait: 3, stability: 1000, hold: [{ after: 4, slope: 1 }] },
      stations: [{ id: "s", capacity: 1 }],
      pools: [],
      units: [{ id: "u", order: "o", station: "s", dur: 50, earliest: 0, deps: [] }],
      orders: [],
    },
    1,
  );
  assert.equal(infeasible.status, "infeasible");

  // A hard model with a tiny time limit may not be proven optimal. It must say so.
  const units = Array.from({ length: 60 }, (_, i) => ({
    id: `u${i}`, order: `o${i % 20}`, station: "s", pool: "p", dur: 3 + (i % 7), earliest: 0, deps: [], weight: 1,
  }));
  const orders = Array.from({ length: 20 }, (_, i) => ({
    id: `o${i}`, target: 30 + i, pack: `u${i}`, food: [] as string[], done_ends: [],
    scenarios: [{ arrival: 32 + i, weight: 50 }, { arrival: 40 + i, weight: 50 }],
  }));
  const hard = await runSolver(
    {
      horizon: 600, seconds: 0.3, workers: 1,
      weights: { wait: 3, stability: 1000, hold: [{ after: 4, slope: 1 }, { after: 12, slope: 2 }] },
      stations: [{ id: "s", capacity: 3 }],
      pools: [{ id: "p", capacity: 3 }],
      units, orders,
    },
    0.3,
  );
  assert.ok(["optimal", "feasible", "unknown"].includes(hard.status), hard.status);
  if (hard.status === "feasible") assert.match(hard.warnings.join(" "), /not proven optimal/);
});

test("9k. a strict-priority solve: lateness is minimized before holding", async () => {
  // Two orders, one grill burner each time. Whichever is late must be as little as possible overall.
  const f = fresh((c) => {
    c.stations.find((s) => s.id === "grill")!.capacity = 1;
    c.pools.find((p) => p.id === "hot")!.capacity = 3;
  });
  const first = await tk.createOrder(f.db, burger(9));
  const second = await tk.createOrder(f.db, burger(30));
  const snap = await buildSnapshot(f.db);
  const a = snap.orders.find((o) => o.id === first.orderId)!;
  const b = snap.orders.find((o) => o.id === second.orderId)!;
  assert.equal(a.plan.risk, "at_risk", "an 8-minute burger can't make a 9-minute ETA with a 1-minute buffer and packing");
  assert.equal(b.plan.risk, "on_time");
  const [x, y] = [a, b].map((o) => o.tasks.find((t) => t.name === "Grill burger")!);
  assert.ok(x.plannedStartMs! < y.plannedStartMs!, "the urgent order takes the burner first");
  closeDb(f.file);
});

test("10. the clock is the server's, in the restaurant's zone, to the minute", async () => {
  const f = fresh();
  const snap = await buildSnapshot(f.db);
  assert.equal(snap.serverNow, T0);
  assert.equal(snap.timezone, ZONE);
  assert.deepEqual(clockParts(T0, ZONE), { hhmm: "6:05", suffix: "PM" });
  assert.deepEqual(clockParts(T0, ZONE, true), { hhmm: "18:05", suffix: "" });
  // The same instant reads differently in another zone: staff never see their device's zone.
  assert.equal(formatTime(T0, "America/Los_Angeles"), "3:05 PM");
  assert.equal(formatTime(T0, ZONE), "6:05 PM");
  closeDb(f.file);
});
