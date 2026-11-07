/**
 * Times the planner around the exhaustive-search cutoff, and one what-if
 * simulation path. Run: npm run bench:planner
 * Queues are generated deterministically so results are comparable between runs.
 */
import { EXACT_LIMIT, Job, Options, plan } from "../lib/engine";

const options: Options = {
  resources: [
    { id: "grill", capacity: 3 },
    { id: "fryer", capacity: 2 },
    { id: "oven", capacity: 1 },
    { id: "assembly", capacity: 2 },
  ],
};

function queue(n: number): Job[] {
  return Array.from({ length: n }, (_, i) => {
    const arrival = 4 + ((i * 17) % 40);
    return {
      id: `o${i}`,
      tasks: [
        { id: `a${i}`, resource: "grill", state: "pending", minutes: 4 + ((i * 7) % 8), quality: 12 },
        { id: `b${i}`, resource: "fryer", state: "pending", minutes: 4, quality: 6 },
        { id: `c${i}`, resource: i % 2 ? "oven" : "assembly", state: "pending", minutes: 3 + (i % 9), quality: 20 },
      ],
      pack: 2,
      arrival,
      deadline: arrival + 5,
      received: -((i * 5) % 12),
    };
  });
}

console.log(`exact search cutoff: ${EXACT_LIMIT} queued tickets (3 dishes each)\n`);
console.log("tickets  method     sequences  ms");
for (const n of [3, 5, 6, 7, 8, 10, 12, 20, 40]) {
  const jobs = queue(n);
  const t = performance.now();
  const p = plan(jobs, jobs.map((j) => j.id), options);
  const ms = performance.now() - t;
  console.log(
    `${String(n).padEnd(8)} ${p.method.padEnd(10)} ${String(p.examined).padEnd(10)} ${ms.toFixed(1)}`,
  );
}
