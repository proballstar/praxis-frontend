import { test } from "node:test";
import assert from "node:assert/strict";
import { tk } from "../lib/tk/api";
import { buildSnapshot } from "../lib/tk/snapshot";
import { MIN, T0, ZONE, fresh } from "./tk-helpers";
import { formatTime } from "../lib/tk/time";

const at = (ms: number) => formatTime(ms, ZONE);

test("spec example: an impossible target is shown honestly, not hidden", async () => {
  const f = fresh();
  // Driver ETA 6:15. Burger well done is 10 minutes, so it can't finish by the 6:14 target.
  const { orderId } = await tk.createOrder(f.db, {
    channel: "delivery",
    customer: "Maya R.",
    etaMinutes: 10,
    items: [
      { recipe: "burger", qty: 1, modifiers: ["well done"] },
      { recipe: "fries", qty: 1 },
      { recipe: "shake", qty: 1 },
    ],
  });
  const snap = await buildSnapshot(f.db);
  const o = snap.orders.find((x) => x.id === orderId)!;
  assert.equal(at(o.expectedMs), "6:15 PM");
  assert.equal(at(o.targetMs), "6:14 PM");
  const burger = o.tasks.find((t) => t.name === "Grill burger")!;
  assert.equal(burger.durationMin, 10);
  assert.equal(at(burger.plannedStartMs!), "6:05 PM");
  assert.equal(at(burger.plannedEndMs!), "6:15 PM");
  const pack = o.tasks.find((t) => t.kind === "pack")!;
  assert.equal(at(pack.plannedStartMs!), "6:15 PM");
  assert.equal(at(pack.plannedEndMs!), "6:16 PM");
  assert.equal(o.plan.risk, "at_risk");
  assert.equal(o.plan.minutesAfterTarget, 2);
  assert.equal(o.plan.minutesAfterEta, 1);
  assert.equal(snap.solver.last?.status, "optimal");
  // The other components wait so food isn't held: they finish with the burger.
  const fries = o.tasks.find((t) => t.name === "Fry fries")!;
  const shake = o.tasks.find((t) => t.name === "Make shake")!;
  assert.equal(at(fries.plannedEndMs!), "6:15 PM");
  assert.equal(at(shake.plannedEndMs!), "6:15 PM");
  assert.match(o.explanation.steps[4].detail, /2 min after the target/);
  assert.match(o.explanation.steps[4].detail, /does not invent a faster schedule/);
  assert.match(o.explanation.caveat, /may also affect these times/);
});

test("a feasible order aims to finish at the target", async () => {
  const f = fresh();
  const { orderId } = await tk.createOrder(f.db, {
    channel: "delivery",
    etaMinutes: 25,
    items: [
      { recipe: "burger", qty: 1 },
      { recipe: "fries", qty: 1 },
    ],
  });
  const o = (await buildSnapshot(f.db)).orders.find((x) => x.id === orderId)!;
  assert.equal(o.plan.risk, "on_time");
  assert.equal(at(o.plan.bagReadyMs!), "6:29 PM");
  assert.equal(at(o.targetMs), "6:29 PM");
});
