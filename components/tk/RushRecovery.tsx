"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Change, Simulation } from "@/lib/tk/changes";
import { Button, Pill } from "@/components/ui";
import { useKitchen } from "./kitchen";

type Kind = "driver" | "time" | "equipment" | "staff";

const KINDS: [Kind, string][] = [
  ["driver", "Driver early or late"],
  ["time", "Order needs more time"],
  ["equipment", "Equipment down"],
  ["staff", "Staff short"],
];

const MINUTES: Record<Kind, number[]> = {
  driver: [0, 3, 5, 8, 10, 15, 20, 30],
  time: [2, 5, 8, 10, 15],
  equipment: [10, 20, 30, 60, 120],
  staff: [10, 20, 30, 60, 120],
};

function Choice({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" aria-pressed={selected} onClick={onClick} className={`min-h-14 min-w-12 rounded-xl border px-3 text-base font-semibold ${selected ? "border-brand bg-brand text-on-brand" : "border-line bg-raised"}`}>
      {children}
    </button>
  );
}

export function SimulationResult({ sim }: { sim: Simulation }) {
  const { fmt } = useKitchen();
  const rows = sim.orders.filter((o) => o.added || o.deltaMinutes || o.before?.risk !== o.after.risk);
  return (
    <div className="space-y-3">
      <p className="rounded-xl bg-raised p-3 text-base font-semibold">{sim.summary}</p>
      {rows.length > 0 && (
        <table className="w-full text-sm">
          <caption className="sr-only">Predicted effect on each order</caption>
          <thead className="text-left text-xs text-muted">
            <tr>
              <th className="pb-1 font-semibold">Order</th>
              <th className="pb-1 font-semibold">Bag ready</th>
              <th className="pb-1 font-semibold">Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              <tr key={o.number} className="border-t border-line">
                <td className="py-2 font-black">#{o.number}{o.added ? " (new)" : ""}</td>
                <td className="py-2 tabular-nums">
                  {o.before ? `${fmt(o.before.bagReadyMs)} → ` : ""}
                  <b>{fmt(o.after.bagReadyMs)}</b>
                  {o.deltaMinutes ? <span className={o.deltaMinutes > 0 ? " font-bold text-bad" : " font-bold text-brand"}> ({o.deltaMinutes > 0 ? "+" : ""}{o.deltaMinutes} min)</span> : null}
                </td>
                <td className="py-2">
                  {o.before && o.before.risk !== o.after.risk ? <span>{o.before.risk === "at_risk" ? "AT RISK" : "ON TIME"} → </span> : null}
                  {o.after.risk === "at_risk" ? <Pill tone="bad">AT RISK{o.after.minutesAfterTarget ? ` +${o.after.minutesAfterTarget}` : ""}</Pill> : <Pill tone="good">ON TIME</Pill>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {sim.warnings.map((w) => (
        <p key={w} className="rounded-xl bg-warn-soft p-2 text-sm font-semibold text-warn">{w}</p>
      ))}
      <p className="text-xs text-muted">Planning: {sim.solver.status} in {sim.solver.ms} ms. Issued receipts never change unless a manager withdraws them.</p>
    </div>
  );
}

export function RushRecovery({ onClose }: { onClose: () => void }) {
  const { snap, call, toast } = useKitchen();
  const open = useMemo(() => (snap?.orders ?? []).filter((o) => o.status === "DRAFT" || o.status === "RELEASED"), [snap?.orders]);
  const [kind, setKind] = useState<Kind>("driver");
  const [order, setOrder] = useState<number | null>(null);
  const [resource, setResource] = useState("");
  const [units, setUnits] = useState(1);
  const [minutes, setMinutes] = useState(10);
  const [sim, setSim] = useState<Simulation | null>(null);
  const [changes, setChanges] = useState<Change[]>([]);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  const run = useRef(0);

  const eligible = kind === "driver" ? open.filter((o) => o.channel === "delivery") : open;
  const chosenOrder = eligible.find((o) => o.number === order) ?? eligible[0];
  const stations = snap?.stations ?? [];
  const pools = snap?.pools ?? [];
  const chosenResource = kind === "equipment" ? (stations.find((s) => s.name === resource) ?? stations[0])?.name : (pools.find((p) => p.name === resource) ?? pools[0])?.name;
  const capacity = kind === "equipment" ? stations.find((s) => s.name === chosenResource)?.capacity ?? 1 : pools.find((p) => p.name === chosenResource)?.capacity ?? 1;

  const change: Change | null = useMemo(() => {
    if (kind === "driver") return chosenOrder ? { kind: "driver_eta", order: chosenOrder.number, minutes } : null;
    if (kind === "time") return chosenOrder ? { kind: "add_time", order: chosenOrder.number, minutes } : null;
    return chosenResource ? { kind: kind === "equipment" ? "equipment" : "staff", resource: chosenResource, units: Math.min(units, capacity), minutes } : null;
  }, [kind, chosenOrder, chosenResource, units, minutes, capacity]);

  useEffect(() => {
    if (!change) return void setSim(null);
    const id = ++run.current;
    setProblem("");
    const timer = setTimeout(async () => {
      const r = await call("/api/simulate", { changes: [change] });
      if (id !== run.current) return;
      if (!r.ok) {
        setSim(null);
        return setProblem(r.error ?? "Couldn't test that.");
      }
      setSim(r.data?.simulation as Simulation);
      setChanges(r.data?.changes as Change[]);
    }, 350);
    return () => clearTimeout(timer);
    // The board changing should refresh the result, so the board version is a dependency.
  }, [change, call, snap?.rev]);

  async function approve() {
    if (!sim) return;
    setBusy(true);
    const r = await call("/api/approve", { baseRev: sim.baseRev, changes });
    setBusy(false);
    if (!r.ok) return setProblem(r.error ?? "Couldn't apply that.");
    toast("Applied. Drafts were replanned. Issued receipts are unchanged.");
    onClose();
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">Try a change first. The live board stays exactly as it is until you approve.</p>
      <div className="flex flex-wrap gap-2" role="group" aria-label="What happened?">
        {KINDS.map(([id, label]) => (
          <Choice key={id} selected={kind === id} onClick={() => { setKind(id); setMinutes(MINUTES[id][2]); setUnits(1); }}>{label}</Choice>
        ))}
      </div>

      {(kind === "driver" || kind === "time") && (
        <div>
          <p className="mb-1.5 text-sm font-semibold">Which order?</p>
          <div className="flex flex-wrap gap-2">
            {eligible.map((o) => <Choice key={o.id} selected={chosenOrder?.number === o.number} onClick={() => setOrder(o.number)}>#{o.number}</Choice>)}
            {!eligible.length && <p className="text-sm text-muted">No matching orders.</p>}
          </div>
        </div>
      )}
      {(kind === "equipment" || kind === "staff") && (
        <div className="space-y-3">
          <div>
            <p className="mb-1.5 text-sm font-semibold">{kind === "equipment" ? "Which station?" : "Which staff group?"}</p>
            <div className="flex flex-wrap gap-2">
              {(kind === "equipment" ? stations.map((s) => s.name) : pools.map((p) => p.name)).map((n) => (
                <Choice key={n} selected={chosenResource === n} onClick={() => { setResource(n); setUnits(1); }}>{n}</Choice>
              ))}
            </div>
          </div>
          {capacity > 1 && (
            <div>
              <p className="mb-1.5 text-sm font-semibold">How many are out?</p>
              <div className="flex flex-wrap gap-2">
                {Array.from({ length: capacity }, (_, i) => i + 1).map((n) => <Choice key={n} selected={units === n} onClick={() => setUnits(n)}>{n} of {capacity}</Choice>)}
              </div>
            </div>
          )}
        </div>
      )}

      <div>
        <p className="mb-1.5 text-sm font-semibold">{kind === "driver" ? "Driver now arrives in" : kind === "time" ? "Extra minutes needed" : "Out for"}</p>
        <div className="flex flex-wrap gap-2">
          {MINUTES[kind].map((m) => <Choice key={m} selected={minutes === m} onClick={() => setMinutes(m)}>{m === 0 ? "Now" : `${m} min`}</Choice>)}
        </div>
      </div>

      <div className="space-y-3 border-t border-line pt-4" aria-live="polite">
        {problem && <p role="alert" className="rounded-xl bg-warn-soft p-3 text-sm font-semibold text-warn">{problem}</p>}
        {!problem && !sim && <p className="text-sm text-muted">Testing…</p>}
        {sim && !problem && <SimulationResult sim={sim} />}
        <div className="flex gap-2">
          <Button className="flex-1" onClick={onClose}>Cancel, keep the current plan</Button>
          <Button tone="primary" className="flex-1" disabled={!sim || busy || !!problem} onClick={approve}>Approve and replan drafts</Button>
        </div>
      </div>
    </div>
  );
}
