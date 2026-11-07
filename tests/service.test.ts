import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  Action,
  Service,
  ServiceError,
  brief,
  emptyService,
  estimatePrep,
  jobsFor,
  overdueMinutes,
  planFor,
  planKey,
  recommendation,
  reduce,
  report,
} from "../lib/service";
import { apply, load } from "../lib/store";

const T0 = Date.UTC(2026, 10, 7, 23, 0);
const MIN = 60_000;
const at = (m: number) => T0 + m * MIN;

function kitchen(stations = 1): Service {
  let n = 0;
  return run(
    emptyService(),
    [
      {
        type: "configure",
        settings: {
          name: "Test Kitchen",
          stations,
          graceMinutes: 2, packMinutes: 0,
          menu: [{ id: "m1", name: "Bowl", minutes: 6 }],
        },
      },
    ],
    0,
    () => `id${++n}`,
  );
}

function run(s: Service, actions: Action[], minute = 0, id?: () => string) {
  return actions.reduce((x, a) => reduce(x, a, at(minute), id), s);
}

function withOrders(s: Service, ...rows: [string, number, number][]) {
  return run(
    s,
    rows.map(([ref, prep, etaMinutes]) => ({
      type: "addOrder",
      order: { ref, items: "Bowl", prep, etaMinutes },
    })),
    0,
    ((n) => () => `o${s.rev}-${++n}`)(0),
  );
}

const id = (s: Service, ref: string) =>
  s.orders.find((o) => o.ref === ref)!.id;

test("nothing works until the kitchen is set up", () => {
  assert.throws(
    () =>
      reduce(
        emptyService(),
        { type: "addOrder", order: { items: "x", prep: 5, etaMinutes: 5 } },
        T0,
      ),
    ServiceError,
  );
  assert.throws(
    () =>
      reduce(
        emptyService(),
        {
          type: "configure",
          settings: { name: " ", stations: 2, graceMinutes: 5, packMinutes: 0, menu: [] },
        },
        T0,
      ),
    /restaurant name/,
  );
});

test("a full ticket: queued, cooking, ready, handed off", () => {
  let s = withOrders(kitchen(), ["1", 10, 12]);
  const o = id(s, "1");
  s = run(s, [{ type: "start", id: o }], 1);
  assert.equal(s.orders[0].status, "cooking");
  assert.equal(s.orders[0].station, 1);
  assert.deepEqual(s.queue, []);
  s = run(s, [{ type: "ready", id: o }], 11);
  assert.equal(s.orders[0].station, undefined);
  s = run(s, [{ type: "pickedUp", id: o }], 13);
  assert.equal(s.orders[0].status, "done");
  assert.equal(s.orders[0].pickedUpAt, at(13));
});

test("the input state is never mutated and the revision advances", () => {
  const s = withOrders(kitchen(), ["1", 10, 12]);
  const before = structuredClone(s);
  const next = run(s, [{ type: "start", id: id(s, "1") }]);
  assert.deepEqual(s, before);
  assert.equal(next.rev, s.rev + 1);
});

test("a full kitchen refuses another start", () => {
  const s = withOrders(kitchen(), ["1", 10, 12], ["2", 10, 12]);
  const a = run(s, [{ type: "start", id: id(s, "1") }]);
  assert.throws(
    () => run(a, [{ type: "start", id: id(s, "2") }]),
    /Every station is busy/,
  );
});

test("double taps fail cleanly instead of repeating", () => {
  const s = withOrders(kitchen(), ["1", 10, 12]);
  const o = id(s, "1");
  const started = run(s, [{ type: "start", id: o }]);
  assert.throws(
    () => run(started, [{ type: "start", id: o }]),
    /already moved on/,
  );
  const done = run(started, [{ type: "ready", id: o }]);
  assert.throws(() => run(done, [{ type: "ready", id: o }]), ServiceError);
});

test("duplicate open tickets are refused; refs can repeat once closed", () => {
  const s = withOrders(kitchen(), ["77", 5, 5]);
  assert.throws(() => withOrders(s, ["77", 5, 5]), /already on the board/);
  const closed = run(s, [{ type: "cancel", id: id(s, "77") }]);
  assert.equal(withOrders(closed, ["77", 5, 5]).orders.length, 2);
});

test("a blank ticket number gets the next one", () => {
  const s = withOrders(kitchen(), ["1500", 5, 5]);
  const next = reduce(
    s,
    { type: "addOrder", order: { items: "Bowl", prep: 5, etaMinutes: 5 } },
    T0,
    () => "auto",
  );
  assert.equal(next.orders.at(-1)!.ref, "1501");
});

test("bad input is rejected", () => {
  const s = kitchen();
  const add = (order: object) =>
    reduce(s, { type: "addOrder", order } as Action, T0);
  assert.throws(() => add({ items: "", prep: 5, etaMinutes: 5 }), ServiceError);
  assert.throws(() => add({ items: "x", prep: 0, etaMinutes: 5 }), ServiceError);
  assert.throws(() => add({ items: "x", prep: 5, etaMinutes: -1 }), ServiceError);
  assert.throws(() => add({ items: "x", prep: 2.5, etaMinutes: 5 }), ServiceError);
  assert.throws(() => reduce(s, { type: "nope" } as never, T0), /Unknown/);
});

test("delays extend the job, and only from the real present", () => {
  let s = withOrders(kitchen(), ["1", 10, 12]);
  const o = id(s, "1");
  s = run(s, [{ type: "start", id: o }]);
  s = run(s, [{ type: "addTime", id: o, minutes: 8 }], 4);
  assert.equal(jobsFor(s, at(4))[0].remaining, 14);
  // 30 minutes in, 12 past the 18-minute estimate: +5 means five from now.
  assert.equal(overdueMinutes(s.orders[0], at(30)), 12);
  s = run(s, [{ type: "addTime", id: o, minutes: 5 }], 30);
  assert.equal(jobsFor(s, at(30))[0].remaining, 5);
});

test("an order past its estimate still projects forward", () => {
  let s = withOrders(kitchen(), ["1", 10, 12]);
  s = run(s, [{ type: "start", id: id(s, "1") }]);
  assert.equal(jobsFor(s, at(25))[0].remaining, 1);
});

test("real clock: the delay scenario produces the recommendation", () => {
  let s = withOrders(kitchen(), ["1042", 10, 10], ["1043", 12, 26], ["1044", 4, 18]);
  s = run(s, [{ type: "start", id: id(s, "1042") }]);
  s = run(s, [{ type: "addTime", id: id(s, "1042"), minutes: 8 }], 4);
  const p = planFor(s, at(4));
  assert.equal(p.current.metrics.wait, 28);
  assert.equal(p.best.metrics.wait, 20);
  assert.deepEqual(
    p.best.sequence.map((x) => s.orders.find((o) => o.id === x)!.ref),
    ["1044", "1043"],
  );
  assert.equal(recommendation(s, p), true);

  const dismissed = run(
    s,
    [{ type: "dismissPlan", sequence: p.best.sequence }],
    4,
  );
  assert.equal(dismissed.dismissedPlan, planKey(p.best.sequence));
  assert.equal(recommendation(dismissed, p), false);

  const applied = run(s, [{ type: "applyPlan", sequence: p.best.sequence, baseRev: s.rev }], 4);
  assert.deepEqual(applied.queue, p.best.sequence);
  const after = planFor(applied, at(4));
  assert.equal(after.current.metrics.wait, 20);
  assert.equal(after.shouldChange, false);
  assert.equal(applied.orders.find((o) => o.ref === "1042")!.status, "cooking");
});

test("a plan reviewed against an older board is refused", () => {
  const s = withOrders(kitchen(), ["1", 5, 9], ["2", 5, 9]);
  const sequence = [...s.queue].reverse();
  const changed = withOrders(s, ["3", 5, 9]);
  assert.throws(
    () => run(changed, [{ type: "applyPlan", sequence, baseRev: s.rev }]),
    /board changed/,
  );
  assert.throws(
    () =>
      run(s, [
        { type: "applyPlan", sequence: [s.queue[0], s.queue[0]], baseRev: s.rev },
      ]),
    /board changed/,
  );
});

test("manual moves respect the ends of the queue", () => {
  const s = withOrders(kitchen(), ["1", 5, 9], ["2", 5, 9]);
  const moved = run(s, [{ type: "move", id: id(s, "2"), direction: -1 }]);
  assert.equal(moved.queue[0], id(s, "2"));
  assert.equal(
    reduce(s, { type: "move", id: id(s, "1"), direction: -1 }, T0),
    s,
  );
});

test("couriers: running late, arriving early, arriving late", () => {
  const s = withOrders(kitchen(), ["1", 5, 20]);
  const o = id(s, "1");
  const moved = run(s, [{ type: "courierEta", id: o, minutes: 30 }], 5);
  assert.equal(moved.orders[0].arrival, at(35));
  assert.equal(moved.orders[0].deadline, at(37));

  const early = run(s, [{ type: "courierHere", id: o }], 5);
  assert.equal(early.orders[0].arrival, at(5));
  assert.equal(early.orders[0].deadline, at(22));

  const late = run(s, [{ type: "courierHere", id: o }], 30);
  assert.equal(late.orders[0].arrival, at(30));
  assert.equal(late.orders[0].deadline, at(32));
});

test("undo reverses the last change, repeatedly", () => {
  let s = withOrders(kitchen(), ["1", 5, 9]);
  const o = id(s, "1");
  s = run(s, [{ type: "start", id: o }]);
  s = run(s, [{ type: "ready", id: o }], 5);
  s = run(s, [{ type: "undo" }], 6);
  assert.equal(s.orders[0].status, "cooking");
  assert.equal(s.orders[0].station, 1);
  s = run(s, [{ type: "undo" }], 6);
  assert.equal(s.orders[0].status, "queued");
  assert.deepEqual(s.queue, [o]);
  s = run(s, [{ type: "undo" }], 6);
  assert.equal(s.orders.length, 0);
  assert.throws(() => run(s, [{ type: "undo" }]), /Nothing to undo/);
});

test("stations in use cannot be removed; removing others drops old undo", () => {
  const settings = (stations: number) =>
    ({ name: "K", stations, graceMinutes: 2, packMinutes: 0, menu: [] });
  let s = withOrders(kitchen(3), ["1", 5, 9], ["2", 5, 9], ["3", 5, 9]);
  s = run(s, [
    { type: "start", id: id(s, "1") },
    { type: "start", id: id(s, "2") },
  ]);
  assert.throws(
    () => run(s, [{ type: "configure", settings: settings(1) }]),
    /still cooking/,
  );
  const narrowed = run(s, [{ type: "configure", settings: settings(2) }]);
  assert.equal(narrowed.stations, 2);
  assert.deepEqual(narrowed.undo, []);
});

test("cancel frees the station", () => {
  let s = withOrders(kitchen(), ["1", 5, 9], ["2", 5, 9]);
  s = run(s, [{ type: "start", id: id(s, "1") }]);
  s = run(s, [
    { type: "cancel", id: id(s, "1") },
    { type: "start", id: id(s, "2") },
  ]);
  assert.equal(s.orders[1].station, 1);
});

test("sample orders are labeled, removable, and left out of results", () => {
  let s = run(kitchen(), [{ type: "loadSample" }]);
  assert.equal(s.orders.length, 3);
  assert.ok(s.orders.every((o) => o.sample));
  assert.equal(s.orders.filter((o) => o.status === "cooking").length, 1);
  assert.equal(report(s.orders).orders, 0);
  planFor(s, T0);
  s = run(s, [{ type: "clearSample" }]);
  assert.deepEqual(s.orders, []);
  assert.deepEqual(s.queue, []);
});

test("sample orders load even if the same tickets closed earlier", () => {
  let s = withOrders(kitchen(), ["1042", 5, 9]);
  s = run(s, [{ type: "cancel", id: id(s, "1042") }, { type: "loadSample" }]);
  assert.equal(s.orders.filter((o) => o.sample).length, 3);
  assert.equal(s.queue.length, 2);
});

test("shift report uses what actually happened", () => {
  let s = withOrders(kitchen(), ["1", 10, 12], ["2", 10, 12]);
  const [a, b] = [id(s, "1"), id(s, "2")];
  s = run(s, [{ type: "start", id: a }]);
  s = run(s, [{ type: "ready", id: a }, { type: "start", id: b }], 11);
  s = run(s, [{ type: "pickedUp", id: a }], 12);
  s = run(s, [{ type: "ready", id: b }], 24);
  assert.throws(() => run(s, [{ type: "endShift" }], 25), /still open/);
  s = run(s, [{ type: "pickedUp", id: b }], 25);
  assert.deepEqual(report(s.orders), {
    orders: 2,
    onTime: 1,
    late: 1,
    avgCourierWait: 6,
    avgOverrun: 2,
  });
  s = run(s, [{ type: "endShift" }], 26);
  assert.equal(s.shifts.length, 1);
  assert.equal(s.shifts[0].orders, 2);
  assert.deepEqual(s.orders, []);
  assert.equal(s.configured, true);
});

test("prep estimate: longest dish, plus a minute per extra dish", () => {
  assert.equal(estimatePrep([]), 0);
  assert.equal(estimatePrep([{ minutes: 8, qty: 1 }]), 8);
  assert.equal(
    estimatePrep([
      { minutes: 8, qty: 2 },
      { minutes: 4, qty: 1 },
    ]),
    10,
  );
});

test("brief states the facts, including lateness it cannot fix", () => {
  assert.match(brief(kitchen(), T0), /board is clear/);
  let s = withOrders(kitchen(), ["1042", 10, 10], ["1043", 12, 26], ["1044", 4, 18]);
  s = run(s, [{ type: "start", id: id(s, "1042") }]);
  s = run(s, [{ type: "addTime", id: id(s, "1042"), minutes: 8 }], 4);
  const text = brief(s, at(4));
  assert.match(text, /#1044 → #1043/);
  assert.match(text, /28 → 20/);
  assert.match(text, /Still late/);
});

test("store survives restarts, serializes writers, and protects bad data", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "praxis-"));
  const file = path.join(dir, "nested", "service.json");
  process.env.PRAXIS_DATA_FILE = file;
  assert.equal((await load()).configured, false);
  await apply({
    type: "configure",
    settings: { name: "K", stations: 2, graceMinutes: 5, packMinutes: 0, menu: [] },
  });
  const added = await Promise.all(
    Array.from({ length: 25 }, (_, i) =>
      apply({
        type: "addOrder",
        order: { ref: `${i}`, items: "Bowl", prep: 5, etaMinutes: 5 },
      }),
    ),
  );
  assert.equal(added.at(-1)!.orders.length, 25);
  const saved = await load();
  assert.equal(saved.orders.length, 25);
  assert.equal(saved.queue.length, 25);

  await assert.rejects(() => apply({ type: "undo" }).then(() => apply({ type: "nope" } as never)));
  assert.equal((await load()).orders.length, 24);

  writeFileSync(file, "{broken");
  await assert.rejects(() => load());
  await assert.rejects(() =>
    apply({
      type: "configure",
      settings: { name: "K", stations: 2, graceMinutes: 5, packMinutes: 0, menu: [] },
    }),
  );
  assert.equal(readFileSync(file, "utf8"), "{broken");
  delete process.env.PRAXIS_DATA_FILE;
});

test("an approval is refused once the board has changed since it was shown", () => {
  const s = withOrders(kitchen(), ["1", 5, 9], ["2", 5, 9]);
  const shown = s.rev;
  const actions: Action[] = [{ type: "cancel", id: id(s, "1") }];
  // Someone else taps Start on another device after the proposal was made.
  const moved = run(s, [{ type: "start", id: id(s, "2") }]);
  assert.throws(
    () => run(moved, [{ type: "batch", label: "x", baseRev: shown, actions }]),
    /out of date/,
  );
  // With the current revision, the same approval is accepted.
  const ok = run(moved, [
    { type: "batch", label: "x", baseRev: moved.rev, actions },
  ]);
  assert.equal(ok.orders[0].status, "cancelled");
});

test("a double-tapped approval applies once", () => {
  const s = withOrders(kitchen(), ["1", 5, 9]);
  const actions: Action[] = [{ type: "cancel", id: id(s, "1") }];
  const first = run(s, [{ type: "batch", label: "x", baseRev: s.rev, actions }]);
  assert.throws(
    () => run(first, [{ type: "batch", label: "x", baseRev: s.rev, actions }]),
    /out of date/,
  );
});
