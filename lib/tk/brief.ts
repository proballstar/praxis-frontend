import { MINUTE_MS, formatTime } from "./time";
import { Snapshot } from "./snapshot";

/** A plain-language status that needs no AI. Facts only. */
export function brief(s: Snapshot): string {
  const open = s.orders.filter((o) => o.status === "DRAFT" || o.status === "RELEASED");
  if (!s.configured) return "The kitchen isn't set up yet.";
  if (!open.length) return "The board is clear. No orders are open.";
  const fmt = (ms: number) => formatTime(ms, s.timezone, s.clock24);
  const lines: string[] = [];
  const drafts = open.filter((o) => o.status === "DRAFT");
  const released = open.filter((o) => o.status === "RELEASED");
  lines.push(
    `${open.length} open order${open.length === 1 ? "" : "s"}: ${released.length} released, ${drafts.length} waiting for a manager to release.`,
  );
  const risky = open.filter((o) => o.plan.risk === "at_risk");
  if (risky.length)
    lines.push(
      `At risk: ${risky.map((o) => `#${o.number} (bag ready ${fmt(o.plan.bagReadyMs!)}, ${o.plan.minutesAfterTarget} min after its target)`).join("; ")}.`,
    );
  else lines.push("Every order is on track for its pickup target.");
  const next = released
    .flatMap((o) => o.tasks.filter((t) => t.kind !== "pack" && t.status !== "DONE").map((t) => ({ o, t })))
    .filter((x) => x.t.plannedStartMs !== null)
    .sort((a, b) => a.t.plannedStartMs! - b.t.plannedStartMs!)[0];
  if (next) {
    const wait = Math.round((next.t.plannedStartMs! - s.serverNow) / MINUTE_MS);
    lines.push(
      `Next to start: ${next.t.name} for #${next.o.number} at the ${next.t.stationName.toLowerCase()}, ${wait <= 0 ? "now" : `at ${fmt(next.t.plannedStartMs!)}`}.`,
    );
  }
  const stale = open.filter((o) => o.driver?.stale);
  if (stale.length) lines.push(`Driver estimates to refresh: ${stale.map((o) => `#${o.number}`).join(", ")}.`);
  const out = s.stations.filter((st) => st.outage);
  if (out.length) lines.push(`Equipment out: ${out.map((st) => `${st.name} (${st.outage!.unitsOut} of ${st.capacity})`).join(", ")}.`);
  if (s.solver.last && !["optimal", "feasible", "skipped"].includes(s.solver.last.status))
    lines.push("The last planning attempt failed, so earlier plans are still showing. Please review.");
  return lines.join(" ");
}
