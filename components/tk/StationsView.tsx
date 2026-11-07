"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, Check, Play, RotateCcw, Wrench } from "lucide-react";
import type { StationGroup } from "@/lib/tk/snapshot";
import { Button, Pill, inputClass } from "@/components/ui";
import { mmss, useKitchen } from "./kitchen";

const SAVED = "praxis-station";

function StationCard({
  g,
  index,
  onDone,
  onStart,
  early,
  onOverride,
  onDismiss,
}: {
  g: StationGroup;
  index: number;
  onDone: () => void;
  onStart: () => void;
  early: string | null;
  onOverride: (reason: string) => void;
  onDismiss: () => void;
}) {
  const { now, fmt } = useKitchen();
  const [reason, setReason] = useState("");
  const cooking = g.status === "COOKING";
  const blocked = !!g.blockedBy;
  const due = now >= g.plannedStartMs;
  const left = g.expectedEndMs - now;

  return (
    <article
      aria-label={`${g.name} for order ${g.orderNumber}`}
      className={`tk-station min-w-0 space-y-5 rounded-2xl border-2 bg-panel p-5 shadow-sm sm:p-6 ${g.remake ? "border-bad" : cooking ? "border-brand" : due && !blocked ? "border-warn" : "border-line"}`}
    >
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-baseline gap-x-3">
            <span className="text-4xl font-black tracking-tight">#{g.orderNumber}</span>
            <span className="text-2xl font-bold">
              {g.qty} × {g.name}
            </span>
          </p>
          <div className="mt-1 flex flex-wrap gap-2">
            {g.remake && <Pill tone="bad">REMAKE</Pill>}
            {g.batch && <Pill tone="quiet">BATCH OF {g.qty}</Pill>}
            {g.modifiers.map((m) => (
              <b key={m} className="rounded bg-warn-soft px-2 py-0.5 text-base text-warn">
                {m}
              </b>
            ))}
          </div>
        </div>
        {index < 9 && (
          <kbd className="grid size-10 shrink-0 place-items-center rounded-xl border-2 border-line text-xl font-black" aria-hidden="true">
            {index + 1}
          </kbd>
        )}
      </header>

      {g.allergen && (
        <p role="alert" className="rounded-xl bg-bad-soft p-2 text-base font-black text-bad">
          ALLERGY: {g.allergen}
        </p>
      )}

      <div aria-live="off">
        {cooking ? (
          <p className={`text-4xl font-black tracking-tight tabular-nums ${left < 0 ? "text-bad" : ""}`} role="timer">
            {left < 0 ? `OVER by ${mmss(-left)}` : `${mmss(left)} left`}
          </p>
        ) : blocked ? (
          <p className="text-xl font-bold text-muted">Waiting for {g.blockedBy}</p>
        ) : due ? (
          <p className="text-4xl font-black tracking-tight text-warn">START NOW</p>
        ) : (
          <p className="text-xl font-bold tabular-nums">
            Starts in {mmss(g.plannedStartMs - now)} <span className="text-muted">({fmt(g.plannedStartMs)})</span>
          </p>
        )}
        <p className="text-sm text-muted">
          Planned {fmt(g.plannedStartMs)} → {fmt(g.plannedEndMs)} · {g.durationMin} min
        </p>
      </div>

      <div className="flex gap-2">
        {!cooking && (
          <Button className="min-h-24 flex-1 text-xl font-black" disabled={blocked} onClick={onStart} aria-label={`Start ${g.name} for order ${g.orderNumber}`}>
            <Play size={20} aria-hidden="true" /> START
          </Button>
        )}
        <Button
          tone="primary"
          className="min-h-24 flex-[2] text-3xl font-black shadow-sm"
          disabled={blocked}
          onClick={onDone}
          aria-label={`Done: ${g.qty} ${g.name} for order ${g.orderNumber}`}
          aria-keyshortcuts={index < 9 ? String(index + 1) : undefined}
        >
          <Check size={24} aria-hidden="true" /> DONE{g.qty > 1 ? ` (${g.qty})` : ""}
        </Button>
      </div>

      {early && (
        <div role="group" aria-label="Manager override" className="space-y-2 rounded-xl border border-warn bg-warn-soft p-3">
          <p className="flex items-center gap-2 text-sm font-bold text-warn">
            <AlertTriangle size={16} aria-hidden="true" /> {early}
          </p>
          <input
            className={inputClass}
            aria-label="Reason for finishing early"
            placeholder="Manager override: why is it done early?"
            value={reason}
            maxLength={200}
            onChange={(e) => setReason(e.target.value)}
          />
          <div className="flex gap-2">
            <Button className="flex-1" onClick={onDismiss}>
              Not done yet
            </Button>
            <Button tone="danger" className="flex-1" disabled={!reason.trim()} onClick={() => onOverride(reason)}>
              Done early (recorded)
            </Button>
          </div>
        </div>
      )}
    </article>
  );
}

function Outage({ kind, id, name, capacity, outage }: { kind: "station" | "pool"; id: string; name: string; capacity: number; outage: { unitsOut: number; untilMs: number } | null }) {
  const { call, toast, fmt } = useKitchen();
  const [open, setOpen] = useState(false);
  const [units, setUnits] = useState(1);
  const [minutes, setMinutes] = useState(30);
  const apply = async (unitsOut: number) => {
    const r = await call("/api/capacity", { kind, id, unitsOut, minutes });
    if (!r.ok) toast(r.error ?? "Couldn't update that.");
    else setOpen(false);
  };
  return (
    <div className="rounded-2xl border border-line bg-panel p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm">
          <b>{name}</b>: {capacity - (outage?.unitsOut ?? 0)} of {capacity} available
          {outage && <span className="font-bold text-bad"> · {outage.unitsOut} out until {fmt(outage.untilMs)}</span>}
        </p>
        <div className="flex gap-2">
          {outage && <Button onClick={() => apply(0)}>Back in service</Button>}
          <Button onClick={() => setOpen(!open)} aria-expanded={open}>
            <Wrench size={16} aria-hidden="true" /> {outage ? "Change" : "Report a problem"}
          </Button>
        </div>
      </div>
      {open && (
        <div className="mt-3 space-y-2">
          {capacity > 1 && (
            <div className="flex flex-wrap items-center gap-2" role="group" aria-label="How many are out">
              <span className="text-sm font-semibold">Out of action:</span>
              {Array.from({ length: capacity }, (_, i) => i + 1).map((n) => (
                <button key={n} type="button" aria-pressed={units === n} onClick={() => setUnits(n)} className={`min-h-14 min-w-14 rounded-xl border px-2 font-bold ${units === n ? "border-brand bg-brand text-on-brand" : "border-line bg-raised"}`}>
                  {n}
                </button>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2" role="group" aria-label="For how long">
            <span className="text-sm font-semibold">For:</span>
            {[10, 20, 30, 60, 120].map((m) => (
              <button key={m} type="button" aria-pressed={minutes === m} onClick={() => setMinutes(m)} className={`min-h-14 rounded-xl border px-3 font-bold ${minutes === m ? "border-brand bg-brand text-on-brand" : "border-line bg-raised"}`}>
                {m} min
              </button>
            ))}
          </div>
          <Button tone="primary" className="w-full" onClick={() => apply(Math.min(units, capacity))}>
            Apply and replan drafts
          </Button>
          <p className="text-xs text-muted">Issued receipts won&apos;t change by themselves. Praxis warns if locked work no longer fits.</p>
        </div>
      )}
    </div>
  );
}

export function StationsView() {
  const { snap, call, toast } = useKitchen();
  const [selected, setSelected] = useState("");
  const [early, setEarly] = useState<{ key: string; message: string } | null>(null);
  const groupsRef = useRef<StationGroup[]>([]);

  useEffect(() => {
    const saved = localStorage.getItem(SAVED);
    if (saved) setSelected(saved);
  }, []);
  const station = snap?.stations.find((s) => s.id === selected) ?? snap?.stations[0];
  const groups = station?.groups ?? [];
  groupsRef.current = groups;

  const send = useCallback(
    async (g: StationGroup, action: "start" | "done" | "reopen", extra: object = {}) => {
      const r = await call(`/api/tasks/${g.taskIds[0]}`, { action, scope: g.batch ? "batch" : "task", ...extra });
      if (r.ok) return setEarly(null);
      if (r.code === "too_early") setEarly({ key: g.key, message: r.error ?? "Not ready yet." });
      else toast(r.error ?? "That didn't work.");
    },
    [call, toast],
  );

  // Keys 1-9 bump the matching visible card. Ignored while typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement;
      if (el.matches("input, textarea, select, [contenteditable='true']")) return;
      if (document.querySelector("[role='dialog']")) return;
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > 9) return;
      const g = groupsRef.current[n - 1];
      if (g && !g.blockedBy) void send(g, "done");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [send]);

  if (!snap || !station) return null;
  const due = (s: (typeof snap.stations)[number]) => s.groups.filter((g) => !g.blockedBy).length;
  const pool = snap.pools.find((p) => p.id === station.pool);

  return (
    <div className="mx-auto max-w-5xl overflow-x-clip px-4 pb-12 sm:px-6">
      <div role="tablist" aria-label="Stations" className="w-full max-w-full min-w-0 mb-5 flex max-w-full gap-2 flex-wrap pb-2">
        {snap.stations.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={station.id === s.id}
            onClick={() => {
              setSelected(s.id);
              localStorage.setItem(SAVED, s.id);
              setEarly(null);
            }}
            className={`min-h-14 shrink-0 rounded-xl border-2 px-5 text-lg font-black ${station.id === s.id ? "border-brand bg-brand text-on-brand" : "border-line bg-panel"}`}
          >
            {s.name}
            {s.groups.length > 0 && <span className="ml-2 rounded-full bg-bg px-2 text-sm text-ink">{due(s)}</span>}
            {s.outage && <span aria-label="problem reported"> ⚠</span>}
          </button>
        ))}
      </div>

      <div className="mb-3 space-y-2">
        <Outage kind="station" id={station.id} name={`${station.name} equipment`} capacity={station.capacity} outage={station.outage} />
        {pool && <Outage kind="pool" id={pool.id} name={`${pool.name} staff`} capacity={pool.capacity} outage={pool.outage} />}
      </div>

      <p className="mb-3 text-sm text-muted">
        Sorted by planned start. Tap DONE, or press the number on a card. Nothing is marked done by a timer.
      </p>

      {!groups.length && (
        <p className="rounded-xl border border-dashed border-line p-8 text-center text-lg text-muted">
          Nothing to make at {station.name} right now. Released orders show up here.
        </p>
      )}
      <div className="grid items-start gap-5 lg:grid-cols-2">
        {groups.map((g, i) => (
          <StationCard
            key={g.key}
            g={g}
            index={i}
            onStart={() => send(g, "start")}
            onDone={() => send(g, "done")}
            early={early?.key === g.key ? early.message : null}
            onOverride={(reason) => send(g, "done", { managerOverride: true, reason })}
            onDismiss={() => setEarly(null)}
          />
        ))}
      </div>

      {station.recentDone.length > 0 && (
        <section className="mt-8" aria-label="Recently done">
          <h2 className="mb-2 text-sm font-black tracking-wider text-muted">RECENTLY DONE (tap if bumped by mistake)</h2>
          <ul className="space-y-2">
            {station.recentDone.map((g) => (
              <li key={g.key} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-line p-3">
                <span>
                  <b>#{g.orderNumber}</b> {g.qty} × {g.name}
                  {g.startInferred && <span className="ml-2 text-xs text-muted">(start was inferred, not observed)</span>}
                </span>
                <Button onClick={() => send(g, "reopen", { reason: "Bumped by mistake" })}>
                  <RotateCcw size={16} aria-hidden="true" /> Put back
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
