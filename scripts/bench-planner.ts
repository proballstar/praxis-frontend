/**
 * Times the planner around the exhaustive-search cutoff. Run: npm run bench:planner
 * Queues are generated deterministically so results are comparable between runs.
 */
import { EXACT_LIMIT, Job, plan } from "../lib/engine";

function queue(n: number): Job[] {
  return Array.from({ length: n }, (_, i) => {
    const arrival = 4 + ((i * 17) % 40);
    return {
      id: `o${i}`,
      remaining: 3 + ((i * 7) % 11),
      pack: 2,
      arrival,
      deadline: arrival + 5,
      received: -((i * 5) % 12),
    };
  });
}

console.log(`exact search cutoff: ${EXACT_LIMIT} queued orders\n`);
console.log("queued  method     sequences  stations  ms");
for (const n of [3, 5, 7, 8, 9, 10, 12, 20, 40]) {
  for (const stations of [1, 3]) {
    const jobs = queue(n);
    const sequence = jobs.map((j) => j.id);
    const t = performance.now();
    const p = plan(jobs, sequence, { stations });
    const ms = performance.now() - t;
    console.log(
      `${String(n).padEnd(7)} ${p.method.padEnd(10)} ${String(p.examined).padEnd(10)} ${String(stations).padEnd(9)} ${ms.toFixed(1)}`,
    );
  }
}
