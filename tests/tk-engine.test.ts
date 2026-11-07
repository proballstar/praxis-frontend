import { test } from "node:test";
import assert from "node:assert/strict";
import { tk } from "../lib/tk/api";
import { closeDb, openDb } from "../lib/tk/db";
import { buildSnapshot, OrderView } from "../lib/tk/snapshot";
import { TaskRow, TkError } from "../lib/tk/types";
import { Fresh, MIN, T0, ZONE, fresh } from "./tk-helpers";
import { formatTime } from "../lib/tk/time";

const at = (ms: number) => formatTime(ms, ZONE);

const burgerFries = (eta = 25) => ({
  channel: "delivery" as const,
  customer: "Maya R.",
  driverName: "Chris D.",
  etaMinutes: eta,
  items: [
    { recipe: "burger", qty: 1, modifiers: ["well done"] },
    { recipe: "fries", qty: 1 },
  ],
});

const view = async (f: Fresh, id: string): Promise<OrderView> =>
  (await buildSnapshot(f.db)).orders.find((o) => o.id === id)!;

const rows = (f: Fresh, id: string) =>
  f.db.all<TaskRow>("SELECT * FROM tasks WHERE order_id = ? ORDER BY created_ms, id", id);

/** Marks every food task done in dependency order, on a clock that waits for each. */
async function finishAll(f: Fresh, id: string) {
  const food = rows(f, id).filter((t) => t.kind !== "pack");
  for (const t of food.sort((a, b) => a.planned_start_ms! - b.planned_start_ms!)) {
    f.set(Math.max(f.db.now(), t.planned_end_ms!));
    await tk.task(f.db, { taskId: t.id, action: "done", scope: "task" });
  }
}

const packAll = async (f: Fresh, id: string) => {
  const o = await view(f, id);
  for (const i of o.items) await tk.check(f.db, id, `item:${i.id}`, true);
  for (const r of o.reminders) await tk.check(f.db, id, `rem:${r.name}`, true);
};

/** No station or staff group is ever overbooked by the plan. */
function assertNoOverlap(f: Fresh) {
  const config = JSON.parse(f.db.get<{ json: string }>("SELECT json FROM config")!.json);
  const tasks = f.db
    .all<TaskRow>(
      "SELECT t.* FROM tasks t JOIN orders o ON o.id = t.order_id WHERE o.status IN ('DRAFT','RELEASED') AND t.status != 'DONE' AND t.planned_start_ms IS NOT NULL",
    );
  // A batch shares one run.
  const unique = new Map<string, TaskRow>();
  for (const t of tasks) unique.set(t.batch_id ?? t.id, t);
  const all = [...unique.values()];
  const ticks = new Set<number>();
  for (const t of all) for (let m = t.planned_start_ms!; m < t.planned_end_ms!; m += 30_000) ticks.add(m);
  for (const st of config.stations) {
    for (const m of ticks) {
      const used = all.filter((t) => t.station_id === st.id && t.planned_start_ms! <= m && m < t.planned_end_ms!).length;
      assert.ok(used <= st.capacity, `${st.id} has ${used}/${st.capacity} at ${at(m)}`);
    }
  }
  for (const pool of config.pools) {
    for (const m of ticks) {
      let used = 0;
      for (const t of all) {
        const st = config.stations.find((s: { id: string }) => s.id === t.station_id);
        if (st.pool !== pool.id) continue;
        const s = t.planned_start_ms!;
        const e = t.planned_end_ms!;
        const a = st.attend;
        const spans = a.mode === "load_unload" && (a.loadTicks + a.unloadTicks) * 30_000 < e - s
          ? [[s, s + a.loadTicks * 30_000], [e - a.unloadTicks * 30_000, e]]
          : [[s, e]];
        if (spans.some(([x, y]) => x <= m && m < y)) used++;
      }
      assert.ok(used <= pool.capacity, `${pool.id} staff ${used}/${pool.capacity} at ${at(m)}`);
    }
  }
}

test("1. orders compete for configured capacity without overlaps", async () => {
  const f = fresh();
  await tk.createOrder(f.db, burgerFries(12));
  await tk.createOrder(f.db, {
    channel: "walk_in",
    customer: "Jordan P.",
    promisedMinutes: 12,
    items: [
      { recipe: "burger", qty: 3 },
      { recipe: "fries", qty: 2 },
    ],
  });
  await tk.createOrder(f.db, burgerFries(13));
  assertNoOverlap(f);
  const snap = await buildSnapshot(f.db);
  // Five burgers on a two-burner grill can't all start together.
  const burgers = snap.orders.flatMap((o) => o.tasks).filter((t) => t.name === "Grill burger");
  assert.equal(burgers.length, 5);
  const starts = new Set(burgers.map((t) => t.plannedStartMs));
  assert.ok(starts.size >= 3, "burgers spread across time");
  closeDb(f.file);
});

test("2. the receipt carries every item, modifier, target and time", async () => {
  const f = fresh();
  const { orderId, number } = await tk.createOrder(f.db, {
    channel: "delivery",
    customer: "Maya R.",
    driverName: "Chris D.",
    etaMinutes: 25,
    items: [
      { recipe: "burger", qty: 2, modifiers: ["well done"] },
      { recipe: "shake", qty: 1 },
    ],
    allergen: "Peanut allergy",
  });
  const o = await view(f, orderId);
  assert.equal(o.number, number);
  assert.equal(o.customer, "Maya R.");
  assert.equal(o.pickupCode, `A${number}`);
  assert.equal(o.channel, "delivery");
  assert.equal(o.driver?.name, "Chris D.");
  assert.equal(at(o.driver!.arrivalMs), "6:30 PM");
  assert.equal(o.driver?.ageMinutes, 0);
  assert.equal(o.itemCount, 3);
  assert.deepEqual(o.items.find((i) => i.name === "Burger")?.modifiers, ["well done"]);
  assert.equal(o.allergen.flag, true);
  assert.equal(o.status, "DRAFT");
  const grill = o.tasks.filter((t) => t.stationName === "Grill");
  assert.equal(grill.length, 2);
  assert.ok(grill.every((t) => t.plannedStartMs !== null && t.plannedEndMs! - t.plannedStartMs! === 10 * MIN));
  assert.ok(o.tasks.every((t) => t.kind === "pack" || t.allergen === "Peanut allergy"));
  assert.ok(o.plan.bagReadyMs !== null);
  closeDb(f.file);
});

test("3. a released receipt is frozen; drafts move; at-risk is flagged", async () => {
  const f = fresh();
  const a = await tk.createOrder(f.db, burgerFries(25));
  const b = await tk.createOrder(f.db, burgerFries(25));
  await tk.issue(f.db, a.orderId);
  const before = rows(f, a.orderId).map((t) => [t.id, t.status, t.planned_start_ms, t.planned_end_ms, t.station_id]);
  const draftBefore = rows(f, b.orderId).map((t) => t.planned_start_ms);
  assert.ok(rows(f, a.orderId).every((t) => t.status === "ISSUED" && t.released_version === 1));

  // The driver is now running 12 minutes late for the issued order and early for the draft.
  await tk.updateEta(f.db, { orderId: a.orderId, minutesFromNow: 8 });
  await tk.updateEta(f.db, { orderId: b.orderId, minutesFromNow: 40 });
  const after = rows(f, a.orderId).map((t) => [t.id, t.status, t.planned_start_ms, t.planned_end_ms, t.station_id]);
  assert.deepEqual(after, before, "issued instructions unchanged");
  assert.notDeepEqual(rows(f, b.orderId).map((t) => t.planned_start_ms), draftBefore, "the draft moved");

  const o = await view(f, a.orderId);
  assert.equal(o.plan.lockedAtRisk, true);
  assert.equal(o.plan.risk, "at_risk");
  const snap = await buildSnapshot(f.db);
  assert.ok(snap.warnings.some((w) => w.includes(`Order #${o.number} is at risk`)));
  assert.equal(snap.orders.find((x) => x.id === b.orderId)!.plan.risk, "on_time");
  closeDb(f.file);
});

test("3b. a manager can withdraw unstarted work, then issue a replacement", async () => {
  const f = fresh();
  const a = await tk.createOrder(f.db, burgerFries(25));
  await tk.issue(f.db, a.orderId);
  await assert.rejects(() => tk.withdraw(f.db, a.orderId, ""), /Say why/);
  await tk.updateEta(f.db, { orderId: a.orderId, minutesFromNow: 8 });
  await tk.withdraw(f.db, a.orderId, "Driver is much earlier");
  const o = await view(f, a.orderId);
  assert.equal(o.status, "DRAFT");
  assert.equal(o.plan.version, 2);
  assert.match(o.plan.withdrawnNote, /Replaces version 1: Driver is much earlier/);
  assert.ok(o.tasks.every((t) => t.status === "PLANNED"));
  await tk.issue(f.db, a.orderId);
  assert.ok(rows(f, a.orderId).every((t) => t.released_version === 2));
  closeDb(f.file);
});

test("4. completion is recorded by a person; a timer never completes food", async () => {
  const f = fresh();
  const a = await tk.createOrder(f.db, burgerFries(25));
  await assert.rejects(() => tk.task(f.db, { taskId: rows(f, a.orderId)[0].id, action: "start" }), /Release this order/);
  await tk.issue(f.db, a.orderId);
  const burger = rows(f, a.orderId).find((t) => t.name === "Grill burger")!;

  // An hour passes. Nothing completes on its own.
  f.advance(60);
  assert.equal(rows(f, a.orderId).find((t) => t.id === burger.id)!.status, "ISSUED");
  const snap = await buildSnapshot(f.db);
  const card = snap.stations.find((s) => s.id === "grill")!.groups.find((g) => g.orderId === a.orderId)!;
  assert.equal(card.status, "ISSUED");

  // One tap on DONE records an inferred start, flagged as inferred.
  await tk.task(f.db, { taskId: burger.id, action: "done" });
  const d = rows(f, a.orderId).find((t) => t.id === burger.id)!;
  assert.equal(d.status, "DONE");
  assert.equal(d.start_inferred, 1);
  assert.equal(d.actual_start_ms, burger.planned_start_ms);
  assert.equal(d.actual_end_ms, f.db.now());
  assert.ok(f.db.get("SELECT 1 FROM events WHERE type = 'task_done' AND task_id = ?", burger.id));
  closeDb(f.file);
});

test("4b. an early DONE is refused unless a manager records why", async () => {
  const f = fresh();
  const a = await tk.createOrder(f.db, burgerFries(25));
  await tk.issue(f.db, a.orderId);
  const burger = rows(f, a.orderId).find((t) => t.name === "Grill burger")!;
  f.set(burger.planned_start_ms!);
  await tk.task(f.db, { taskId: burger.id, action: "start" });
  assert.equal(rows(f, a.orderId).find((t) => t.id === burger.id)!.start_inferred, 0);
  f.advance(2);
  await assert.rejects(
    () => tk.task(f.db, { taskId: burger.id, action: "done" }),
    (e: unknown) => e instanceof TkError && e.code === "too_early",
  );
  await assert.rejects(() => tk.task(f.db, { taskId: burger.id, action: "done", managerOverride: true }), /too_early|Not ready/);
  await tk.task(f.db, { taskId: burger.id, action: "done", managerOverride: true, reason: "Customer asked for it rare" });
  assert.equal(rows(f, a.orderId).find((t) => t.id === burger.id)!.status, "DONE");
  assert.ok(f.db.get("SELECT 1 FROM events WHERE type = 'early_done_override'"));
  closeDb(f.file);
});

test("4c. a bumped item can be reopened, and extended while cooking", async () => {
  const f = fresh();
  const a = await tk.createOrder(f.db, burgerFries(25));
  await tk.issue(f.db, a.orderId);
  const burger = rows(f, a.orderId).find((t) => t.name === "Grill burger")!;
  f.set(burger.planned_end_ms!);
  await tk.task(f.db, { taskId: burger.id, action: "done" });
  await tk.task(f.db, { taskId: burger.id, action: "reopen", reason: "Bumped by mistake" });
  const r = rows(f, a.orderId).find((t) => t.id === burger.id)!;
  assert.equal(r.status, "COOKING");
  assert.equal(r.actual_end_ms, null);
  await tk.task(f.db, { taskId: burger.id, action: "extend", minutes: 3 });
  assert.equal(rows(f, a.orderId).find((t) => t.id === burger.id)!.extra_ticks, 6);
  closeDb(f.file);
});

test("4d. a batch moves together and never completes unrelated tasks", async () => {
  const f = fresh();
  const a = await tk.createOrder(f.db, {
    channel: "walk_in",
    promisedMinutes: 30,
    items: [
      { recipe: "fries", qty: 3 },
      { recipe: "rings", qty: 1 },
    ],
  });
  const fries = rows(f, a.orderId).filter((t) => t.name === "Fry fries");
  assert.equal(fries.length, 3);
  assert.equal(new Set(fries.map((t) => t.batch_id)).size, 1, "three portions share one run");
  assert.equal(new Set(fries.map((t) => t.planned_start_ms)).size, 1);
  await tk.issue(f.db, a.orderId);
  const snap = await buildSnapshot(f.db);
  const card = snap.stations.find((s) => s.id === "fryer")!.groups.find((g) => g.name === "Fries")!;
  assert.equal(card.qty, 3);
  assert.equal(card.batch, true);
  f.set(Math.max(...fries.map((t) => t.planned_end_ms!)));
  await tk.task(f.db, { taskId: fries[0].id, action: "done", scope: "batch" });
  const after = rows(f, a.orderId);
  assert.ok(after.filter((t) => t.name === "Fry fries").every((t) => t.status === "DONE"));
  assert.equal(after.find((t) => t.name === "Fry rings")!.status, "ISSUED");
  closeDb(f.file);
});

test("4d1. fryer batches split at equipment batchMax and never cross orders", async () => {
  const f = fresh();
  const a = await tk.createOrder(f.db, { channel: "walk_in", promisedMinutes: 30, items: [{ recipe: "fries", qty: 5 }] });
  const b = await tk.createOrder(f.db, { channel: "walk_in", promisedMinutes: 30, items: [{ recipe: "fries", qty: 2 }] });
  const aa = rows(f, a.orderId).filter((t) => t.name === "Fry fries");
  const bb = rows(f, b.orderId).filter((t) => t.name === "Fry fries");
  assert.equal(new Set(aa.map((t) => t.batch_id)).size, 2); // one 4-portion batch plus one unbatched portion
  assert.equal(aa.filter((t) => t.batch_id).length, 4);
  assert.equal(new Set(bb.map((t) => t.batch_id)).size, 1);
  assert.notEqual(aa[0].batch_id, bb[0].batch_id);
  await tk.issue(f.db, a.orderId);
  const frozen = () => rows(f, a.orderId).map(t => ({id:t.id,batch:t.batch_id,start:t.planned_start_ms,end:t.planned_end_ms,station:t.station_id}));
  const issued = frozen();
  await tk.createOrder(f.db, { channel: "delivery", etaMinutes: 10, items: [{ recipe: "fries", qty: 3 }] });
  assert.deepEqual(frozen(), issued, "new work cannot change issued batch membership or intervals");
  assertNoOverlap(f);
  closeDb(f.file);
});

test("4e. modifiers and allergies keep portions out of a shared batch", async () => {
  const f = fresh();
  const mod = await tk.createOrder(f.db, {
    channel: "walk_in",
    promisedMinutes: 30,
    items: [{ recipe: "fries", qty: 3, modifiers: ["extra crispy"] }],
  });
  assert.ok(rows(f, mod.orderId).filter((t) => t.kind === "food").every((t) => t.batch_id === null));
  const allergy = await tk.createOrder(f.db, {
    channel: "walk_in",
    promisedMinutes: 30,
    allergen: "Shellfish",
    items: [{ recipe: "fries", qty: 3 }],
  });
  assert.ok(rows(f, allergy.orderId).filter((t) => t.kind === "food").every((t) => t.batch_id === null));
  assertNoOverlap(f);
  closeDb(f.file);
});

test("4f. a step waits for the one before it", async () => {
  const f = fresh();
  const a = await tk.createOrder(f.db, {
    channel: "walk_in",
    promisedMinutes: 20,
    items: [{ recipe: "chicken", qty: 1 }],
  });
  const [fry, build] = rows(f, a.orderId).filter((t) => t.kind === "food");
  assert.ok(build.planned_start_ms! >= fry.planned_end_ms!);
  await tk.issue(f.db, a.orderId);
  await assert.rejects(() => tk.task(f.db, { taskId: build.id, action: "done" }), /Wait for "Fry chicken"/);
  closeDb(f.file);
});

test("5. packing opens only when everything is done; seal needs checks, allergen ack and the count", async () => {
  const f = fresh();
  const a = await tk.createOrder(f.db, {
    ...burgerFries(25),
    allergen: "Peanut allergy",
    items: [
      { recipe: "burger", qty: 1 },
      { recipe: "fries", qty: 2 },
      { recipe: "shake", qty: 1 },
    ],
  });
  await tk.issue(f.db, a.orderId);
  let o = await view(f, a.orderId);
  assert.equal(o.phase, "cooking");
  await assert.rejects(() => tk.check(f.db, a.orderId, `item:${o.items[0].id}`, true), /Every item must be finished/);
  await assert.rejects(() => tk.seal(f.db, a.orderId, { count: 4 }), /Every item must be finished/);

  await finishAll(f, a.orderId);
  o = await view(f, a.orderId);
  assert.equal(o.phase, "ready_to_pack");
  assert.equal(o.itemCount, 4, "count policy: ordered items including drinks");
  await assert.rejects(() => tk.check(f.db, a.orderId, "item:nope", true), /isn't on this order/);

  await assert.rejects(() => tk.seal(f.db, a.orderId, { count: 4, allergenAck: true }), /Check every item/);
  for (const i of o.items) await tk.check(f.db, a.orderId, `item:${i.id}`, true);
  await assert.rejects(() => tk.seal(f.db, a.orderId, { count: 4, allergenAck: true }), /Check every item/);
  for (const r of o.reminders) await tk.check(f.db, a.orderId, `rem:${r.name}`, true);
  await assert.rejects(
    () => tk.seal(f.db, a.orderId, { count: 4 }),
    (e: unknown) => e instanceof TkError && e.code === "allergen_ack_required",
  );
  await assert.rejects(
    () => tk.seal(f.db, a.orderId, { count: 3, allergenAck: true }),
    (e: unknown) => e instanceof TkError && e.code === "count_mismatch",
  );
  const sealed = await tk.seal(f.db, a.orderId, { count: 4, allergenAck: true });
  assert.equal(sealed.slot, "S1");
  assert.deepEqual(sealed.label, { slot: "S1", number: o.number, customer: "Maya R.", channel: "DoorDash", count: 4 });
  const again = await tk.seal(f.db, a.orderId, { count: 4, allergenAck: true });
  assert.equal(again.slot, "S1");
  closeDb(f.file);
});

test("5b. sealing warns when another bag shares a first name", async () => {
  const f = fresh();
  const make = async (customer: string) => {
    const a = await tk.createOrder(f.db, { channel: "walk_in", customer, promisedMinutes: 20, items: [{ recipe: "soda", qty: 1 }] });
    await tk.issue(f.db, a.orderId);
    await finishAll(f, a.orderId);
    await packAll(f, a.orderId);
    return tk.seal(f.db, a.orderId, { count: 1 });
  };
  assert.deepEqual((await make("Maya Torres")).warnings, []);
  const second = await make("Mayra Lee");
  assert.equal(second.warnings.length, 1);
  assert.match(second.warnings[0], /Another bag on the shelf \(S1, order #\d+\) is for "Maya Torres"/);
  closeDb(f.file);
});

test("6. a wrong code never hands off; the right code finds the slot and frees it", async () => {
  const f = fresh();
  const a = await tk.createOrder(f.db, { channel: "walk_in", customer: "Jordan P.", promisedMinutes: 15, items: [{ recipe: "soda", qty: 1 }] });
  const code = (await view(f, a.orderId)).pickupCode;
  assert.equal(tk.lookup(f.db, "ZZZ9").match, false);
  assert.equal((tk.lookup(f.db, "ZZZ9") as { message: string }).message, "No matching order, check the app.");
  assert.equal(tk.lookup(f.db, code).match, false, "a draft isn't visible at the counter");
  await tk.issue(f.db, a.orderId);
  const waiting = tk.lookup(f.db, code.toLowerCase());
  assert.equal(waiting.match && waiting.state, "not_sealed");
  assert.match((waiting as { message: string }).message, /isn't sealed yet\. About \d+ min to go/);

  await finishAll(f, a.orderId);
  await packAll(f, a.orderId);
  await tk.seal(f.db, a.orderId, { count: 1 });
  const found = tk.lookup(f.db, ` ${code} `);
  assert.equal(found.match && found.state, "sealed");
  assert.equal(found.match && found.slot, "S1");

  await assert.rejects(
    () => tk.tryHandoff(f.db, a.orderId, "WRONG"),
    (e: unknown) => e instanceof TkError && e.code === "wrong_code" && e.status === 403,
  );
  assert.equal((await view(f, a.orderId)).status, "SEALED");
  assert.ok(f.db.get("SELECT 1 FROM events WHERE type = 'handoff_rejected'"));
  assert.equal((await buildSnapshot(f.db)).shelf[0].orderId, a.orderId);

  await tk.handoff(f.db, a.orderId, code);
  assert.equal((await view(f, a.orderId)).status, "HANDED_OFF");
  assert.equal((await buildSnapshot(f.db)).shelf[0].orderId, null, "the slot is free again");
  assert.match((tk.lookup(f.db, code) as { message: string }).message, /already handed off/);
  const next = await tk.createOrder(f.db, { channel: "walk_in", customer: "Lee", promisedMinutes: 15, items: [{ recipe: "soda", qty: 1 }] });
  await tk.issue(f.db, next.orderId);
  await finishAll(f, next.orderId);
  await packAll(f, next.orderId);
  assert.equal((await tk.seal(f.db, next.orderId, { count: 1 })).slot, "S1", "the freed slot is reused");
  closeDb(f.file);
});

test("7. a remake returns only that item to its station without duplicating the count", async () => {
  const f = fresh();
  const a = await tk.createOrder(f.db, {
    channel: "delivery",
    customer: "Sam K.",
    etaMinutes: 25,
    items: [
      { recipe: "burger", qty: 1 },
      { recipe: "fries", qty: 1 },
    ],
  });
  await tk.issue(f.db, a.orderId);
  await finishAll(f, a.orderId);
  let o = await view(f, a.orderId);
  const fries = o.items.find((i) => i.name === "Fries")!;
  const burger = o.items.find((i) => i.name === "Burger")!;
  await tk.check(f.db, a.orderId, `item:${fries.id}`, true);
  await tk.check(f.db, a.orderId, `item:${burger.id}`, true);
  const issuedBefore = rows(f, a.orderId).filter((t) => t.kind === "food").map((t) => [t.id, t.status, t.planned_start_ms]);

  await assert.rejects(() => tk.remake(f.db, { orderId: a.orderId, itemId: fries.id, reason: "" }), /Say what was missing/);
  const r = await tk.remake(f.db, { orderId: a.orderId, itemId: fries.id, reason: "Fries missing from bag" });
  assert.equal(r.issued.length, 1);

  o = await view(f, a.orderId);
  const remake = o.tasks.filter((t) => t.remake);
  assert.equal(remake.length, 1);
  assert.equal(remake[0].stationName, "Fryer");
  assert.equal(remake[0].status, "ISSUED");
  assert.ok(remake[0].plannedStartMs! >= f.db.now());
  assert.equal(o.itemCount, 2, "count is unchanged");
  assert.equal(o.items.find((i) => i.id === fries.id)!.checked, false, "the missing item's check is cleared");
  assert.equal(o.items.find((i) => i.id === burger.id)!.checked, true, "other checks stay");
  assert.equal(o.phase, "cooking", "packing waits for the remake");
  assert.deepEqual(
    rows(f, a.orderId).filter((t) => t.kind === "food").map((t) => [t.id, t.status, t.planned_start_ms]),
    issuedBefore,
    "original history and other work untouched",
  );
  const snap = await buildSnapshot(f.db);
  const card = snap.stations.find((s) => s.id === "fryer")!.groups.find((g) => g.remake)!;
  assert.equal(card.name, "Remake: Fries");
  assert.ok(!snap.stations.find((s) => s.id === "grill")!.groups.some((g) => g.orderId === a.orderId && g.status !== "DONE"));
  closeDb(f.file);
});

test("7b. remaking a sealed bag is a manager exception; a handed-off bag is refused", async () => {
  const f = fresh();
  const a = await tk.createOrder(f.db, { channel: "walk_in", customer: "Alex T.", promisedMinutes: 15, items: [{ recipe: "soda", qty: 2 }] });
  await tk.issue(f.db, a.orderId);
  await finishAll(f, a.orderId);
  await packAll(f, a.orderId);
  await tk.seal(f.db, a.orderId, { count: 2 });
  const item = (await view(f, a.orderId)).items[0];
  await assert.rejects(
    () => tk.remake(f.db, { orderId: a.orderId, itemId: item.id, reason: "Missing soda" }),
    (e: unknown) => e instanceof TkError && e.code === "manager_exception",
  );
  assert.equal((await view(f, a.orderId)).status, "SEALED");
  await tk.remake(f.db, { orderId: a.orderId, itemId: item.id, reason: "Missing soda", managerException: true });
  const o = await view(f, a.orderId);
  assert.equal(o.status, "RELEASED");
  assert.equal(o.slot, "S1", "the shelf slot is kept");
  closeDb(f.file);
});

test("8. the mock outbound log records release, qualifying changes and ready-now, never the network", async () => {
  const f = fresh();
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    throw new Error("no network in mock mode");
  }) as typeof fetch;
  try {
    const a = await tk.createOrder(f.db, burgerFries(25));
    assert.equal(f.db.all("SELECT * FROM outbound_log").length, 0, "drafts are never sent");
    await tk.issue(f.db, a.orderId);
    const log = () => f.db.all<{ reason: string; mode: string; ready_ms: number }>("SELECT * FROM outbound_log ORDER BY id");
    assert.deepEqual(log().map((l) => l.reason), ["released"]);
    assert.equal(log()[0].mode, "mock");

    await tk.updateEta(f.db, { orderId: a.orderId, minutesFromNow: 24 });
    assert.equal(log().length, 1, "a change of a minute or less is not sent");

    // Cooking runs over, so the estimate slides by more than two minutes.
    const burger = rows(f, a.orderId).find((t) => t.name === "Grill burger")!;
    f.set(burger.planned_start_ms!);
    await tk.task(f.db, { taskId: burger.id, action: "start" });
    await tk.task(f.db, { taskId: burger.id, action: "extend", minutes: 6 });
    assert.deepEqual(log().map((l) => l.reason), ["released", "estimate_changed"]);
    assert.ok(log()[1].ready_ms > log()[0].ready_ms + 2 * MIN);

    await finishAll(f, a.orderId).catch(() => undefined);
    const t = rows(f, a.orderId).filter((x) => x.kind !== "pack");
    f.set(Math.max(f.db.now(), ...t.map((x) => (x.actual_start_ms ?? x.planned_start_ms!) + (x.duration_ticks + x.extra_ticks) * 30_000)));
    for (const x of t.filter((y) => y.status !== "DONE")) await tk.task(f.db, { taskId: x.id, action: "done" });
    await packAll(f, a.orderId);
    await tk.seal(f.db, a.orderId, { count: 2 });
    assert.equal(log().at(-1)!.reason, "ready_now");
    assert.equal(log().at(-1)!.ready_ms, f.db.now());

    const sent = log().length;
    const walkIn = await tk.createOrder(f.db, { channel: "walk_in", promisedMinutes: 10, items: [{ recipe: "soda", qty: 1 }] });
    await tk.issue(f.db, walkIn.orderId);
    assert.equal(log().length, sent, "walk-in orders aren't sent to DoorDash");
    assert.equal(calls, 0);
    assert.ok((await buildSnapshot(f.db)).outbound.every((o) => o.mode === "mock"));
  } finally {
    globalThis.fetch = realFetch;
  }
  closeDb(f.file);
});
