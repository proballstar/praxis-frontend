/**
 * Times the CP-SAT scheduler on rushes of growing size. Run: npm run bench:solver
 * Orders are generated deterministically so runs are comparable.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultConfig, validateConfig } from "../lib/tk/config";
import { openDb, saveConfig } from "../lib/tk/db";
import { createOrder } from "../lib/tk/engine";
import { replan } from "../lib/tk/planner";
import { buildSnapshot } from "../lib/tk/snapshot";

const recipes = ["burger", "fries", "shake", "chicken", "salad", "pizza", "rings", "soda"];

async function main() {
console.log("orders  tasks  status     solve_ms  stages (status letter + ms)");
for (const n of [2, 5, 10, 15, 20, 30]) {
  const db = openDb(path.join(mkdtempSync(path.join(tmpdir(), "bench-")), "bench.db"));
  const start = Date.UTC(2026, 10, 7, 23, 0, 0);
  db.clock = () => start;
  const config = defaultConfig();
  config.name = "Bench";
  config.timezone = "America/New_York";
  config.solver.seconds = 5;
  saveConfig(db, validateConfig(config));
  // Orders arrive together and are planned once, like a busy dinner service.
  db.tx(() => {
    for (let i = 0; i < n; i++)
      createOrder(
        db,
        {
          channel: i % 3 === 0 ? "walk_in" : "delivery",
          customer: `Guest ${i}`,
          ...(i % 3 === 0 ? { promisedMinutes: 15 + (i % 7) * 2 } : { etaMinutes: 12 + (i % 9) * 2 }),
          items: [
            { recipe: recipes[i % 8], qty: 1 + (i % 2) },
            { recipe: recipes[(i * 3 + 1) % 8], qty: 1 },
            { recipe: recipes[(i * 5 + 2) % 8], qty: 1 },
          ],
        },
        start,
      );
  });
  const summary = await replan(db, "bench");
  const snap = await buildSnapshot(db);
  const tasks = snap.orders.reduce((c, o) => c + o.tasks.length, 0);
  const risky = snap.orders.filter((o) => o.plan.risk === "at_risk").length;
  console.log(
    `${String(n).padEnd(7)} ${String(tasks).padEnd(6)} ${summary.status.padEnd(10)} ${String(summary.ms).padEnd(9)} ${summary.stages.map((s) => `${s.name}:${s.status[0]}${s.wall_ms}`).join(" ")}  (${risky} at risk)`,
  );
}
}
void main();
