import { test } from "node:test";
import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  Action,
  COOLDOWN_MS,
  KitchenSettings,
  Service,
  ServiceError,
  brief,
  dueItems,
  emptyService,
  etaStatus,
  isService,
  itemOverdue,
  itemsText,
  jobsFor,
  migrate,
  planFor,
  planKey,
  recommendation,
  reduce,
  report,
  starterMenu,
  starterResources,
} from "../lib/service";
import { apply, load } from "../lib/store";

const T0 = Date.UTC(2026, 10, 7, 23, 0);
const MIN = 60_000;
const at = (m: number) => T0 + m * MIN;

const settings = (over: Partial<KitchenSettings> = {}): KitchenSettings => ({
  name: "Test Kitchen",
  resources: [{ id: "line", name: "Line", capacity: 1 }],
  graceMinutes: 2,
  packMinutes: 0,
  holdBufferMinutes: 2,
  staleEtaMinutes: 15,
  menu: [
    { id: "bowl", name: "Bowl", minutes: 6, resource: "line", qualityMinutes: 15 },
  ],
  ...over,
});

let counter = 0;
const uid = () => `id${++counter}`;

function run(s: Service, actions: Action[], minute = 0) {
  return actions.reduce((x, a) => reduce(x, a, at(minute), uid), s);
}

const kitchen = (capacity = 1) =>
  run(emptyService(), [
    {
      type: "configure",
      settings: settings({
        resources: [{ id: "line", name: "Line", capacity }],
      }),
    },
  ]);

const real = () =>
  run(emptyService(), [
    {
      type: "configure",
      settings: settings({
        resources: starterResources(),
        menu: starterMenu(),
        packMinutes: 2,
      }),
    },
  ]);

function withOrders(s: Service, ...rows: [string, number, number][]) {
  return run(
    s,
    rows.map(([ref, prep, etaMinutes]) => ({
      type: "addOrder",
      order: {
        ref,
        lines: [{ name: "Bowl", qty: 1, minutes: prep, resource: "line" }],
        etaMinutes,
      },
    })),
  );
}

const order = (s: Service, ref: string) =>
  s.orders.find((o) => o.ref === ref)!;
const id = (s: Service, ref: string) => order(s, ref).id;
const start = (s: Service, ref: string, minute = 0) =>
  run(s, [{ type: "startItems", id: id(s, ref) }], minute);

test("nothing works until the kitchen is set up", () => {
  assert.throws(
    () =>
      reduce(
        emptyService(),
        {
          type: "addOrder",
          order: { lines: [{ name: "x", qty: 1, minutes: 5 }], etaMinutes: 5 },
        },
        T0,
      ),
    ServiceError,
  );
  assert.throws(
    () => run(emptyService(), [{ type: "configure", settings: settings({ name: " " }) }]),
    /restaurant name/,
  );
});

test("settings reject bad resources and windows", () => {
  const configure = (over: Partial<KitchenSettings>) =>
    run(emptyService(), [{ type: "configure", settings: settings(over) }]);
  assert.throws(() => configure({ resources: [] }), /at least one resource/);
  assert.throws(
    () => configure({ resources: [{ id: "x", name: "X", capacity: 0 }] }),
    /capacity/,
  );
  assert.throws(
    () =>
      configure({
        menu: [{ id: "a", name: "A", minutes: 5, resource: "nope", qualityMinutes: 5 }],
      }),
    /Choose a resource/,
  );
  assert.throws(
    () =>
      configure({
        menu: [{ id: "a", name: "A", minutes: 5, resource: "line", qualityMinutes: 0 }],
      }),
    /Quality window/,
  );
  assert.throws(() => configure({ holdBufferMinutes: 99 }), /Preparation buffer/);
});

test("each ordered dish becomes its own task on its resource", () => {
  const menu = starterMenu();
  const burger = menu.find((m) => m.name === "Burger")!;
  const fries = menu.find((m) => m.name === "Fries")!;
  const s = run(real(), [
    {
      type: "addOrder",
      order: {
        ref: "1",
        lines: [
          { menuId: burger.id, qty: 2, note: "no onion" },
          { menuId: fries.id, qty: 1 },
        ],
        etaMinutes: 10,
      },
    },
  ]);
  const o = order(s, "1");
  assert.equal(o.items.length, 3);
  assert.deepEqual(
    o.items.map((i) => [i.resource, i.qualityMinutes]),
    [
      ["grill", 12],
      ["grill", 12],
      ["fryer", 6],
    ],
  );
  assert.equal(new Set(o.items.map((i) => i.id)).size, 3);
  assert.equal(itemsText(o.items), "2 × Burger (no onion), 1 × Fries");
});

test("a full ticket: dishes finish, then it is packed and handed off", () => {
  let s = withOrders(kitchen(), ["1", 10, 12]);
  const o = id(s, "1");
  s = run(s, [{ type: "startItems", id: o }], 1);
  assert.equal(order(s, "1").status, "cooking");
  assert.deepEqual(s.queue, []);
  s = run(s, [{ type: "itemsDone", id: o }], 11);
  assert.equal(order(s, "1").items[0].status, "done");
  assert.equal(order(s, "1").status, "cooking");
  s = run(s, [{ type: "ready", id: o }], 12);
  s = run(s, [{ type: "pickedUp", id: o }], 13);
  assert.equal(order(s, "1").status, "done");
  assert.equal(order(s, "1").pickedUpAt, at(13));
});

test("Ready finishes dishes still cooking, but refuses unstarted ones", () => {
  let s = run(kitchen(2), [
    {
      type: "addOrder",
      order: {
        ref: "1",
        lines: [
          { name: "A", qty: 1, minutes: 5 },
          { name: "B", qty: 1, minutes: 5 },
        ],
        etaMinutes: 5,
      },
    },
  ]);
  const [a] = order(s, "1").items;
  s = run(s, [{ type: "startItems", id: id(s, "1"), itemIds: [a.id] }]);
  assert.throws(() => run(s, [{ type: "ready", id: id(s, "1") }]), /still has dishes/);
  s = start(s, "1", 1);
  s = run(s, [{ type: "ready", id: id(s, "1") }], 6);
  assert.equal(order(s, "1").items.every((i) => i.status === "done"), true);
});

test("the input state is never mutated and the revision advances", () => {
  const s = withOrders(kitchen(), ["1", 10, 12]);
  const before = structuredClone(s);
  const next = start(s, "1");
  assert.deepEqual(s, before);
  assert.equal(next.rev, s.rev + 1);
});

test("resource capacity is enforced, and starts what fits", () => {
  let s = run(kitchen(2), [
    {
      type: "addOrder",
      order: {
        ref: "1",
        lines: [{ name: "Bowl", qty: 3, minutes: 5, resource: "line" }],
        etaMinutes: 5,
      },
    },
  ]);
  s = start(s, "1");
  assert.deepEqual(
    order(s, "1").items.map((i) => i.status),
    ["cooking", "cooking", "pending"],
  );
  assert.throws(() => start(s, "1"), /line is full/);
  const before = s.undo.length;
  assert.throws(() => start(s, "1"));
  assert.equal(s.undo.length, before);
});

test("simultaneous claims on the last unit: one wins, one is told why", () => {
  const s = withOrders(kitchen(), ["1", 10, 12], ["2", 10, 12]);
  const a = start(s, "1");
  assert.throws(() => start(a, "2"), /is full/);
});

test("double taps fail cleanly instead of repeating", () => {
  const s = withOrders(kitchen(), ["1", 10, 12]);
  const o = id(s, "1");
  const started = run(s, [{ type: "startItems", id: o }]);
  assert.throws(() => run(started, [{ type: "startItems", id: o }]), /Nothing left/);
  const done = run(started, [{ type: "ready", id: o }]);
  assert.throws(() => run(done, [{ type: "ready", id: o }]), /moved on/);
});

test("duplicate open tickets are refused; refs can repeat once closed", () => {
  const s = withOrders(kitchen(), ["77", 5, 5]);
  assert.throws(() => withOrders(s, ["77", 5, 5]), /already on the board/);
  const closed = run(s, [{ type: "cancel", id: id(s, "77") }]);
  assert.equal(withOrders(closed, ["77", 5, 5]).orders.length, 2);
});

test("bad input is rejected", () => {
  const s = kitchen();
  const add = (o: object) =>
    reduce(s, { type: "addOrder", order: o } as Action, T0);
  const line = [{ name: "x", qty: 1, minutes: 5 }];
  assert.throws(() => add({ lines: [], etaMinutes: 5 }), ServiceError);
  assert.throws(() => add({ lines: line, etaMinutes: -1 }), ServiceError);
  assert.throws(
    () => add({ lines: [{ name: "x", qty: 1, minutes: 0 }], etaMinutes: 5 }),
    ServiceError,
  );
  assert.throws(
    () => add({ lines: [{ name: "x", qty: 1, minutes: 2.5 }], etaMinutes: 5 }),
    ServiceError,
  );
  assert.throws(
    () => add({ lines: [{ name: "x", qty: 0, minutes: 5 }], etaMinutes: 5 }),
    ServiceError,
  );
  assert.throws(
    () => add({ lines: [{ menuId: "gone", qty: 1 }], etaMinutes: 5 }),
    /no longer on the menu/,
  );
  assert.throws(() => reduce(s, { type: "nope" } as never, T0), /Unknown/);
});

test("delays extend unfinished dishes, and only from the real present", () => {
  let s = withOrders(kitchen(), ["1", 10, 12]);
  const o = id(s, "1");
  s = run(s, [{ type: "startItems", id: o }]);
  s = run(s, [{ type: "addTime", id: o, minutes: 8 }], 4);
  assert.equal(jobsFor(s, at(4))[0].tasks[0].minutes, 14);
  assert.equal(itemOverdue(order(s, "1").items[0], at(30)), 12);
  s = run(s, [{ type: "addTime", id: o, minutes: 5 }], 30);
  assert.equal(jobsFor(s, at(30))[0].tasks[0].minutes, 5);
});

test("a dish past its estimate still projects forward", () => {
  const s = start(withOrders(kitchen(), ["1", 10, 12]), "1");
  assert.equal(jobsFor(s, at(25))[0].tasks[0].minutes, 1);
});

test("real clock: the delay scenario produces the recommendation", () => {
  let s = withOrders(kitchen(), ["1042", 10, 10], ["1043", 12, 26], ["1044", 4, 18]);
  s = start(s, "1042");
  s = run(s, [{ type: "addTime", id: id(s, "1042"), minutes: 8 }], 4);
  const p = planFor(s, at(4));
  assert.equal(p.current.metrics.wait, 28);
  assert.equal(p.best.metrics.wait, 20);
  assert.deepEqual(
    p.best.sequence.map((x) => s.orders.find((o) => o.id === x)!.ref),
    ["1044", "1043"],
  );
  assert.equal(recommendation(s, p, at(4)), true);

  const dismissed = run(
    s,
    [{ type: "dismissPlan", sequence: p.best.sequence }],
    4,
  );
  assert.equal(dismissed.dismissedPlan, planKey(p.best.sequence));
  assert.equal(recommendation(dismissed, p, at(5)), false);

  const applied = run(
    s,
    [{ type: "applyPlan", sequence: p.best.sequence, baseRev: s.rev }],
    4,
  );
  assert.deepEqual(applied.queue, p.best.sequence);
  const after = planFor(applied, at(4));
  assert.equal(after.current.metrics.wait, 20);
  assert.equal(after.shouldChange, false);
  assert.equal(order(applied, "1042").status, "cooking");
});

test("a declined recommendation stays quiet, then may return", () => {
  let s = withOrders(kitchen(), ["1042", 10, 10], ["1043", 12, 26], ["1044", 4, 18]);
  s = start(s, "1042");
  s = run(s, [{ type: "addTime", id: id(s, "1042"), minutes: 8 }], 4);
  const p = planFor(s, at(4));
  const declined = run(s, [{ type: "dismissPlan", sequence: p.best.sequence }], 4);
  assert.equal(recommendation(declined, p, at(5)), false);
  assert.equal(recommendation(declined, p, at(4) + COOLDOWN_MS - 1), false);
  assert.equal(recommendation(declined, p, at(4) + COOLDOWN_MS), true);
});

test("a just-approved first ticket is protected from a new recommendation", () => {
  let s = withOrders(kitchen(), ["1", 5, 30], ["2", 5, 30]);
  s = run(
    s,
    [{ type: "applyPlan", sequence: [...s.queue].reverse(), baseRev: s.rev }],
    0,
  );
  const live = planFor(s, at(1));
  const contested = {
    ...live,
    shouldChange: true,
    best: { ...live.best, sequence: [...s.queue].reverse() },
  };
  assert.equal(recommendation(s, contested, at(1)), false);
  assert.equal(recommendation(s, contested, at(4)), true);
});

test("protection belongs to the approved ticket, not the whole board", () => {
  let s = withOrders(kitchen(), ["1", 5, 30], ["2", 5, 30], ["3", 5, 30]);
  s = run(s, [{ type: "applyPlan", sequence: [...s.queue], baseRev: s.rev }]);
  s = run(s, [{ type: "cancel", id: id(s, "1") }]);
  const live = planFor(s, at(1));
  const contested = {
    ...live,
    shouldChange: true,
    best: { ...live.best, sequence: [...s.queue].reverse() },
  };
  assert.equal(recommendation(s, contested, at(1)), true);
});

test("an approval is refused once the board has changed since it was shown", () => {
  const s = withOrders(kitchen(2), ["1", 5, 9], ["2", 5, 9]);
  const shown = s.rev;
  const actions: Action[] = [{ type: "cancel", id: id(s, "1") }];
  const moved = start(s, "2");
  assert.throws(
    () => run(moved, [{ type: "batch", label: "x", baseRev: shown, actions }]),
    /out of date/,
  );
  const ok = run(moved, [
    { type: "batch", label: "x", baseRev: moved.rev, actions },
  ]);
  assert.equal(order(ok, "1").status, "cancelled");
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

test("a double-tapped approval applies once", () => {
  const s = withOrders(kitchen(), ["1", 5, 9]);
  const actions: Action[] = [{ type: "cancel", id: id(s, "1") }];
  const first = run(s, [{ type: "batch", label: "x", baseRev: s.rev, actions }]);
  assert.throws(
    () => run(first, [{ type: "batch", label: "x", baseRev: s.rev, actions }]),
    /out of date/,
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
  assert.equal(order(moved, "1").arrival, at(35));
  assert.equal(order(moved, "1").deadline, at(37));

  const early = run(s, [{ type: "courierHere", id: o }], 5);
  assert.equal(order(early, "1").arrival, at(5));
  assert.equal(order(early, "1").deadline, at(22));

  const late = run(s, [{ type: "courierHere", id: o }], 30);
  assert.equal(order(late, "1").arrival, at(30));
  assert.equal(order(late, "1").deadline, at(32));
});

test("courier time trust: unknown, stale, confirmed, and no holds without it", () => {
  let s = run(kitchen(), [
    {
      type: "addOrder",
      order: {
        ref: "u",
        lines: [{ name: "Bowl", qty: 1, minutes: 5, resource: "line" }],
        etaMinutes: null,
      },
    },
  ]);
  assert.equal(etaStatus(s, order(s, "u"), at(0)), "unknown");
  assert.equal(jobsFor(s, at(0))[0].holdable, false);
  assert.throws(() => run(s, [{ type: "confirmEta", id: id(s, "u") }]), /Enter a courier time/);

  s = withOrders(kitchen(), ["1", 5, 60]);
  assert.equal(etaStatus(s, order(s, "1"), at(10)), "live");
  assert.equal(planFor(s, at(10)).current.slots[0].held, true);
  assert.equal(etaStatus(s, order(s, "1"), at(16)), "stale");
  assert.equal(planFor(s, at(16)).current.slots[0].held, false);

  const confirmed = run(s, [{ type: "confirmEta", id: id(s, "1") }], 16);
  assert.equal(etaStatus(confirmed, order(confirmed, "1"), at(17)), "live");
  assert.equal(planFor(confirmed, at(17)).current.slots[0].held, true);

  const passed = withOrders(kitchen(), ["2", 5, 5]);
  assert.equal(etaStatus(passed, order(passed, "2"), at(6)), "stale");
});

test("equipment down lowers capacity for a while, then recovers", () => {
  let s = run(kitchen(2), [
    { type: "resourceDown", resource: "line", units: 2, minutes: 10 },
  ]);
  s = withOrders(s, ["1", 5, 5]);
  assert.throws(() => start(s, "1"), /line is full/);
  assert.ok(planFor(s, at(0)).current.slots[0].start >= 10);
  assert.equal(start(s, "1", 10).orders[0].status, "cooking");
  assert.throws(
    () => run(s, [{ type: "resourceDown", resource: "x", units: 1, minutes: 5 }]),
    /doesn't exist/,
  );
  const back = run(s, [{ type: "resourceDown", resource: "line", units: 0, minutes: 0 }]);
  assert.equal(back.resources[0].down, undefined);
  assert.equal(start(back, "1").orders[0].status, "cooking");
});

test("the plan says which dishes are due, longest first", () => {
  const menu = starterMenu();
  const s = run(real(), [
    {
      type: "addOrder",
      order: {
        ref: "1",
        lines: [
          { menuId: menu.find((m) => m.name === "Burger")!.id, qty: 1 },
          { menuId: menu.find((m) => m.name === "Fries")!.id, qty: 1 },
        ],
        etaMinutes: 0,
      },
    },
  ]);
  const o = order(s, "1");
  const due = dueItems(o, planFor(s, at(0)).current.slots[0]);
  assert.deepEqual(due.map((i) => i.name), ["Burger"]);
});

test("undo reverses the last change, repeatedly", () => {
  let s = withOrders(kitchen(), ["1", 5, 9]);
  const o = id(s, "1");
  s = run(s, [{ type: "startItems", id: o }]);
  s = run(s, [{ type: "ready", id: o }], 5);
  s = run(s, [{ type: "undo" }], 6);
  assert.equal(order(s, "1").status, "cooking");
  assert.equal(order(s, "1").items[0].status, "cooking");
  s = run(s, [{ type: "undo" }], 6);
  assert.equal(order(s, "1").status, "queued");
  assert.deepEqual(s.queue, [o]);
  s = run(s, [{ type: "undo" }], 6);
  assert.equal(s.orders.length, 0);
  assert.throws(() => run(s, [{ type: "undo" }]), /Nothing to undo/);
});

test("undo also restores equipment that was marked down", () => {
  let s = kitchen(2);
  s = run(s, [{ type: "resourceDown", resource: "line", units: 1, minutes: 10 }]);
  s = run(s, [{ type: "undo" }]);
  assert.equal(s.resources[0].down, undefined);
});

test("a resource in use cannot be removed", () => {
  const s = withOrders(kitchen(), ["1", 5, 9]);
  assert.throws(
    () =>
      run(s, [
        {
          type: "configure",
          settings: settings({
            resources: [{ id: "other", name: "Other", capacity: 1 }],
            menu: [],
          }),
        },
      ]),
    /still on the board/,
  );
});

test("cancel frees capacity", () => {
  let s = withOrders(kitchen(), ["1", 5, 9], ["2", 5, 9]);
  s = start(s, "1");
  s = run(s, [{ type: "cancel", id: id(s, "1") }]);
  s = start(s, "2");
  assert.equal(order(s, "2").status, "cooking");
});

test("the sample rush starts calm and stays out of the results", () => {
  let s = run(real(), [{ type: "loadSample" }]);
  assert.equal(s.orders.length, 4);
  assert.ok(s.orders.every((o) => o.sample));
  assert.equal(s.queue.length, 3);
  assert.equal(order(s, "1042").status, "cooking");
  const p = planFor(s, at(0));
  assert.equal(p.shouldChange, false);
  assert.equal(p.current.metrics.late, 0);
  assert.equal(report(s.orders).orders, 0);
  s = run(s, [{ type: "clearSample" }]);
  assert.deepEqual(s.orders, []);
  assert.deepEqual(s.queue, []);
});

test("planning a few seconds later does not invent a late minute", () => {
  const s = run(real(), [{ type: "loadSample" }]);
  for (const seconds of [-14, -7, 0, 7, 14, 25]) {
    const p = planFor(s, at(0) + seconds * 1000);
    const first = p.current.slots.find((x) => x.id === id(s, "1042"))!;
    assert.equal(first.driverWait, 0, `${seconds}s`);
  }
});

test("sample orders load even if the same tickets closed earlier", () => {
  let s = withOrders(kitchen(), ["1042", 5, 9]);
  s = run(s, [{ type: "cancel", id: id(s, "1042") }, { type: "loadSample" }]);
  assert.equal(s.orders.filter((o) => o.sample).length, 4);
});

test("shift report uses what actually happened, at dish level", () => {
  let s = withOrders(kitchen(), ["1", 10, 12], ["2", 10, 12]);
  const [a, b] = [id(s, "1"), id(s, "2")];
  s = run(s, [{ type: "startItems", id: a }]);
  s = run(s, [{ type: "ready", id: a }, { type: "startItems", id: b }], 11);
  s = run(s, [{ type: "pickedUp", id: a }], 12);
  s = run(s, [{ type: "ready", id: b }], 24);
  assert.throws(() => run(s, [{ type: "endShift" }], 25), /still open/);
  s = run(s, [{ type: "pickedUp", id: b }], 42);
  assert.deepEqual(report(s.orders), {
    orders: 2,
    onTime: 1,
    late: 1,
    avgCourierWait: 6,
    avgOverrun: 2,
    avgFoodSitting: 9.5,
    pastWindow: 1,
  });
  s = run(s, [{ type: "endShift" }], 43);
  assert.equal(s.shifts.length, 1);
  assert.equal(s.shifts[0].orders, 2);
  assert.deepEqual(s.orders, []);
  assert.equal(s.configured, true);
});

test("brief states the facts, including lateness it cannot fix", () => {
  assert.match(brief(kitchen(), T0), /board is clear/);
  let s = withOrders(kitchen(), ["1042", 10, 10], ["1043", 12, 26], ["1044", 4, 18]);
  s = start(s, "1042");
  s = run(s, [{ type: "addTime", id: id(s, "1042"), minutes: 8 }], 4);
  const text = brief(s, at(4));
  assert.match(text, /#1044 → #1043/);
  assert.match(text, /28 → 20/);
  assert.match(text, /Still late/);
});

const v1 = () => ({
  version: 1,
  rev: 7,
  configured: true,
  name: "RAM",
  stations: 2,
  graceMinutes: 5,
  packMinutes: 3,
  menu: [{ id: "m1", name: "Burger", minutes: 8 }],
  orders: [
    { id: "a", ref: "1", customer: "A", items: "2 × Burger", prep: 10, extra: 2, receivedAt: at(0), arrival: at(5), deadline: at(10), status: "cooking", startedAt: at(1), station: 1 },
    { id: "b", ref: "2", customer: "B", items: "1 × Burger", prep: 8, extra: 0, receivedAt: at(1), arrival: at(20), deadline: at(25), status: "queued" },
    { id: "c", ref: "3", customer: "C", items: "1 × Burger", prep: 8, extra: 0, receivedAt: at(0), arrival: at(2), deadline: at(7), status: "ready", startedAt: at(0), readyAt: at(2) },
  ],
  queue: ["b"],
  dismissedPlan: null,
  undo: [],
  shiftStartedAt: at(0),
  shifts: [],
});

test("an old saved kitchen upgrades without losing running work", () => {
  const s = migrate(v1(), at(3)) as Service;
  assert.equal(isService(s), true);
  assert.deepEqual(s.resources, [{ id: "line", name: "Line", capacity: 2 }]);
  assert.equal(s.menu[0].resource, "line");
  assert.equal(s.packMinutes, 3);
  assert.equal(s.rev, 7);
  assert.deepEqual(s.queue, ["b"]);
  const [a, b, c] = s.orders;
  assert.equal(a.items[0].status, "cooking");
  assert.equal(a.items[0].minutes, 10);
  assert.equal(a.items[0].extra, 2);
  assert.equal(a.items[0].startedAt, at(1));
  assert.equal(b.items[0].status, "pending");
  assert.equal(c.items[0].status, "done");
  assert.equal(c.readyAt, at(2));
  planFor(s, at(3));
  assert.equal(migrate(s, at(3)), s);
});

test("store survives restarts, serializes writers, and protects bad data", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "praxis-"));
  const file = path.join(dir, "nested", "service.json");
  process.env.PRAXIS_DATA_FILE = file;
  assert.equal((await load()).configured, false);
  await apply({ type: "configure", settings: settings({ resources: [{ id: "line", name: "Line", capacity: 2 }] }) });
  const added = await Promise.all(
    Array.from({ length: 25 }, (_, i) =>
      apply({
        type: "addOrder",
        order: {
          ref: `${i}`,
          lines: [{ name: "Bowl", qty: 1, minutes: 5, resource: "line" }],
          etaMinutes: 5,
        },
      }),
    ),
  );
  assert.equal(added.at(-1)!.orders.length, 25);
  const saved = await load();
  assert.equal(saved.orders.length, 25);
  assert.equal(saved.queue.length, 25);

  writeFileSync(file, "{broken");
  await assert.rejects(() => load());
  await assert.rejects(() =>
    apply({ type: "configure", settings: settings() }),
  );
  assert.equal(readFileSync(file, "utf8"), "{broken");
  delete process.env.PRAXIS_DATA_FILE;
});

test("the store upgrades an old file in place on the next change", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "praxis-"));
  const file = path.join(dir, "service.json");
  writeFileSync(file, JSON.stringify(v1()));
  process.env.PRAXIS_DATA_FILE = file;
  assert.equal((await load()).version, 2);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).version, 1);
  await apply({ type: "courierHere", id: "b" });
  assert.equal(JSON.parse(readFileSync(file, "utf8")).version, 2);
  delete process.env.PRAXIS_DATA_FILE;
});

const live = path.join(process.cwd(), "data", "service.json");
test("the real saved kitchen on this machine upgrades cleanly", { skip: !existsSync(live) }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "praxis-"));
  const copy = path.join(dir, "service.json");
  copyFileSync(live, copy);
  const before = JSON.parse(readFileSync(copy, "utf8"));
  process.env.PRAXIS_DATA_FILE = copy;
  const upgraded = await load();
  assert.equal(upgraded.orders.length, before.orders.length);
  assert.equal(upgraded.name, before.name);
  planFor(upgraded, Date.now());
  delete process.env.PRAXIS_DATA_FILE;
});
