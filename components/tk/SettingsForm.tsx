"use client";
import { FormEvent, useMemo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import type { Config, Recipe, Station } from "@/lib/tk/types";
import { Button, Field, inputClass } from "@/components/ui";
import { DictateDish } from "@/components/DictateDish";

const TICK_S = 30;
const toMin = (ticks: number) => ticks / 2;
const toTicks = (min: number) => Math.round(min * 2);

function Num({ label, value, onChange, min = 0, max = 999, step = 1, hint }: { label: string; value: number; onChange: (n: number) => void; min?: number; max?: number; step?: number; hint?: string }) {
  return (
    <Field label={label} hint={hint}>
      <input className={inputClass} type="number" inputMode="decimal" min={min} max={max} step={step} value={Number.isNaN(value) ? "" : value} onChange={(e) => onChange(e.target.value === "" ? NaN : Number(e.target.value))} />
    </Field>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <fieldset className="space-y-3">
      <legend className="text-base font-black">{title}</legend>
      {hint && <p className="-mt-1 text-xs text-muted">{hint}</p>}
      {children}
    </fieldset>
  );
}

export function SettingsForm({ initial, submitLabel, onSubmit }: { initial: Config; submitLabel: string; onSubmit: (config: Config) => Promise<string | null> }) {
  const [c, setC] = useState<Config>(() => structuredClone(initial));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const zones = useMemo(() => {
    try {
      return (Intl as unknown as { supportedValuesOf: (k: string) => string[] }).supportedValuesOf("timeZone");
    } catch {
      return [];
    }
  }, []);
  const set = (p: Partial<Config>) => setC((x) => ({ ...x, ...p }));
  const stations = c.stations.filter((s) => s.id !== c.packStation);
  const patchStation = (id: string, p: Partial<Station>) => set({ stations: c.stations.map((s) => (s.id === id ? { ...s, ...p } : s)) });
  const patchRecipe = (i: number, p: Partial<Recipe>) => set({ recipes: c.recipes.map((r, k) => (k === i ? { ...r, ...p } : r)) });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const message = await onSubmit(c);
    if (message) setError(message);
    setBusy(false);
  }

  const addRecipe = (name = "", minutes = 8) => {
    const station = stations[0]?.id ?? "";
    set({
      recipes: [
        ...c.recipes,
        { id: "", name, category: "food", steps: [{ id: "s1", name: name ? `Prepare ${name}` : "", station, ticks: toTicks(minutes), after: [] }], modifiers: [] },
      ],
    });
  };

  return (
    <form onSubmit={submit} className="space-y-7">
      <Section title="Restaurant">
        <Field label="Restaurant name">
          <input className={inputClass} value={c.name} required maxLength={60} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="Time zone" hint="Every screen shows this zone's time, never the viewer's device time.">
          <input className={inputClass} list="zones" value={c.timezone} onChange={(e) => set({ timezone: e.target.value })} />
          <datalist id="zones">{zones.map((z) => <option key={z} value={z} />)}</datalist>
        </Field>
        <label className="flex min-h-14 items-center gap-3 text-sm font-semibold">
          <input type="checkbox" className="size-6" checked={c.clock24} onChange={(e) => set({ clock24: e.target.checked })} /> Show 24-hour time
        </label>
      </Section>

      <Section title="Timing" hint="Defaults are demo assumptions, not verified for a real kitchen.">
        <div className="grid grid-cols-2 gap-3">
          <Num label="Bag ready this early (min)" hint="Before the driver or pickup time" value={c.bufferMinutes} max={30} onChange={(n) => set({ bufferMinutes: n })} />
          <Num label="Check and bag (min)" step={0.5} min={0.5} max={30} value={toMin(c.packTicks)} onChange={(n) => set({ packTicks: toTicks(n) })} />
          <Num label="Driver estimate expires (min)" hint="After this it's flagged stale" min={1} max={120} value={c.staleEtaMinutes} onChange={(n) => set({ staleEtaMinutes: n })} />
          <Num label="Guess when driver time unknown (min)" min={1} max={120} value={c.defaultEtaMinutes} onChange={(n) => set({ defaultEtaMinutes: n })} />
          <Num label="Shelf slots" min={1} max={60} value={c.shelfSlots} onChange={(n) => set({ shelfSlots: n })} />
          <Num label="Driver may be early by (sec)" max={1800} value={c.uncertainty.earlyS} onChange={(n) => set({ uncertainty: { ...c.uncertainty, earlyS: n } })} />
          <Num label="Driver may be late by (sec)" max={3600} value={c.uncertainty.lateS} onChange={(n) => set({ uncertainty: { ...c.uncertainty, lateS: n } })} />
        </div>
      </Section>

      <Section title="Staff groups" hint="A person who covers several stations belongs to one group, so they can't be in two places at once.">
        <div className="space-y-2">
          {c.pools.map((p, i) => (
            <div key={p.id || i} className="flex gap-2">
              <input className={inputClass} aria-label="Staff group name" value={p.name} maxLength={40} onChange={(e) => set({ pools: c.pools.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)) })} />
              <input className={`${inputClass} w-20! shrink-0`} aria-label={`Staff in ${p.name}`} type="number" min={1} max={50} value={p.capacity || ""} onChange={(e) => set({ pools: c.pools.map((x, k) => (k === i ? { ...x, capacity: Number(e.target.value) } : x)) })} />
              <button type="button" aria-label={`Remove ${p.name}`} disabled={c.pools.length === 1} className="grid size-11 shrink-0 place-items-center text-muted disabled:opacity-30" onClick={() => set({ pools: c.pools.filter((_, k) => k !== i) })}>
                <Trash2 size={18} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
        <Button onClick={() => set({ pools: [...c.pools, { id: "", name: "", capacity: 1 }] })}>
          <Plus size={16} aria-hidden="true" /> Add staff group
        </Button>
      </Section>

      <Section title="Stations and equipment" hint="Equipment is what can run at once. Staff are shared across the stations of a group.">
        <div className="space-y-3">
          {c.stations.map((s, i) => (
            <div key={s.id || i} className="space-y-2 rounded-xl border border-line p-3">
              <div className="flex gap-2">
                <input className={inputClass} aria-label="Station name" value={s.name} maxLength={40} onChange={(e) => set({ stations: c.stations.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)) })} />
                <input className={`${inputClass} w-20! shrink-0`} aria-label={`Equipment at ${s.name}`} type="number" min={1} max={50} value={s.capacity || ""} onChange={(e) => set({ stations: c.stations.map((x, k) => (k === i ? { ...x, capacity: Number(e.target.value) } : x)) })} />
                <button type="button" aria-label={`Remove ${s.name}`} disabled={c.stations.length === 1 || s.id === c.packStation} className="grid size-11 shrink-0 place-items-center text-muted disabled:opacity-30" onClick={() => set({ stations: c.stations.filter((_, k) => k !== i) })}>
                  <Trash2 size={18} aria-hidden="true" />
                </button>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs text-muted">
                <label>
                  Staff group
                  <select className={inputClass} value={s.pool} onChange={(e) => patchStation(s.id, { pool: e.target.value })} aria-label={`Staff group for ${s.name}`}>
                    {c.pools.map((p) => <option key={p.id || p.name} value={p.id}>{p.name || "Unnamed"}</option>)}
                  </select>
                </label>
                <label>
                  Staff needed
                  <select className={inputClass} aria-label={`Staff needed at ${s.name}`} value={s.attend.mode} onChange={(e) => patchStation(s.id, { attend: e.target.value === "full" ? { mode: "full" } : { mode: "load_unload", loadTicks: 1, unloadTicks: 1 } })}>
                    <option value="full">The whole time</option>
                    <option value="load_unload">Only to load and unload</option>
                  </select>
                </label>
                {s.attend.mode === "load_unload" && (
                  <>
                    <label>
                      Loading (sec)
                      <input className={inputClass} type="number" min={0} step={TICK_S} value={s.attend.loadTicks * TICK_S} onChange={(e) => patchStation(s.id, { attend: { mode: "load_unload", loadTicks: Math.round(Number(e.target.value) / TICK_S), unloadTicks: (s.attend as { unloadTicks: number }).unloadTicks } })} />
                    </label>
                    <label>
                      Unloading (sec)
                      <input className={inputClass} type="number" min={0} step={TICK_S} value={s.attend.unloadTicks * TICK_S} onChange={(e) => patchStation(s.id, { attend: { mode: "load_unload", loadTicks: (s.attend as { loadTicks: number }).loadTicks, unloadTicks: Math.round(Number(e.target.value) / TICK_S) } })} />
                    </label>
                  </>
                )}
                <label>
                  Most portions per run
                  <input className={inputClass} type="number" min={0} max={20} placeholder="No batching" value={s.batchMax ?? ""} onChange={(e) => patchStation(s.id, { batchMax: Number(e.target.value) > 1 ? Number(e.target.value) : undefined })} />
                </label>
                <label className="flex items-end gap-2 pb-3 text-ink">
                  <input type="radio" name="pack" className="size-5" checked={c.packStation === s.id} onChange={() => set({ packStation: s.id })} /> Packing station
                </label>
              </div>
            </div>
          ))}
        </div>
        <Button onClick={() => set({ stations: [...c.stations, { id: "", name: "", capacity: 1, pool: c.pools[0]?.id ?? "", attend: { mode: "full" } }] })}>
          <Plus size={16} aria-hidden="true" /> Add station
        </Button>
      </Section>

      <Section title="Menu" hint="Each dish is one or more steps. A step can wait for an earlier one. Modifiers adjust a step's time.">
        <div className="space-y-3">
          {c.recipes.map((r, i) => (
            <div key={r.id || i} className="space-y-2 rounded-xl border border-line p-3">
              <div className="flex gap-2">
                <input className={inputClass} aria-label="Dish name" value={r.name} maxLength={60} onChange={(e) => patchRecipe(i, { name: e.target.value })} />
                <select className={`${inputClass} w-28! shrink-0`} aria-label={`Type for ${r.name || "dish"}`} value={r.category} onChange={(e) => patchRecipe(i, { category: e.target.value as Recipe["category"] })}>
                  <option value="food">Food</option>
                  <option value="drink">Drink</option>
                </select>
                <button type="button" aria-label={`Remove ${r.name || "dish"}`} className="grid size-11 shrink-0 place-items-center text-muted" onClick={() => set({ recipes: c.recipes.filter((_, k) => k !== i) })}>
                  <Trash2 size={18} aria-hidden="true" />
                </button>
              </div>
              {r.steps.map((s, si) => {
                const st = c.stations.find((x) => x.id === s.station);
                const upd = (p: Partial<typeof s>) => patchRecipe(i, { steps: r.steps.map((x, k) => (k === si ? { ...x, ...p } : x)) });
                return (
                  <div key={s.id} className="grid grid-cols-2 gap-2 rounded-md bg-raised p-2 text-xs text-muted sm:grid-cols-4">
                    <label className="col-span-2 sm:col-span-1">
                      Step
                      <input className={inputClass} aria-label={`Step name for ${r.name || "dish"}`} value={s.name} maxLength={60} onChange={(e) => upd({ name: e.target.value })} />
                    </label>
                    <label>
                      Station
                      <select className={inputClass} aria-label={`Station for ${s.name || "step"}`} value={s.station} onChange={(e) => upd({ station: e.target.value })}>
                        {c.stations.map((x) => <option key={x.id || x.name} value={x.id}>{x.name || "Unnamed"}</option>)}
                      </select>
                    </label>
                    <label>
                      Minutes
                      <input className={inputClass} aria-label={`Minutes for ${s.name || "step"}`} type="number" step={0.5} min={0.5} max={240} value={toMin(s.ticks) || ""} onChange={(e) => upd({ ticks: toTicks(Number(e.target.value)) })} />
                    </label>
                    <label>
                      After
                      <select className={inputClass} aria-label={`Wait for, ${s.name || "step"}`} value={s.after[0] ?? ""} onChange={(e) => upd({ after: e.target.value ? [e.target.value] : [] })} disabled={si === 0}>
                        <option value="">Nothing</option>
                        {r.steps.slice(0, si).map((x) => <option key={x.id} value={x.id}>{x.name || x.id}</option>)}
                      </select>
                    </label>
                    {st?.batchMax && (
                      <label className="col-span-2 flex items-center gap-2 text-ink">
                        <input type="checkbox" className="size-5" checked={!!s.batchable} onChange={(e) => upd({ batchable: e.target.checked })} /> Portions can share a run
                      </label>
                    )}
                    {r.steps.length > 1 && (
                      <button type="button" className="col-span-2 min-h-14 text-left font-semibold text-bad underline" onClick={() => patchRecipe(i, { steps: r.steps.filter((_, k) => k !== si).map((x) => ({ ...x, after: x.after.filter((a) => a !== s.id) })) })}>
                        Remove step
                      </button>
                    )}
                  </div>
                );
              })}
              <Button onClick={() => patchRecipe(i, { steps: [...r.steps, { id: `s${r.steps.length + 1}-${Date.now() % 1000}`, name: "", station: stations[0]?.id ?? "", ticks: toTicks(2), after: [r.steps.at(-1)!.id] }] })}>
                <Plus size={16} aria-hidden="true" /> Add step
              </Button>
              <div className="space-y-1">
                {r.modifiers.map((m, mi) => (
                  <div key={mi} className="flex gap-2">
                    <input className={inputClass} aria-label={`Modifier for ${r.name || "dish"}`} placeholder="e.g. well done" value={m.name} onChange={(e) => patchRecipe(i, { modifiers: r.modifiers.map((x, k) => (k === mi ? { ...x, name: e.target.value } : x)) })} />
                    <input className={`${inputClass} w-24! shrink-0`} aria-label={`Minutes added by ${m.name || "modifier"}`} type="number" step={0.5} min={-120} max={120} value={toMin(m.addTicks)} onChange={(e) => patchRecipe(i, { modifiers: r.modifiers.map((x, k) => (k === mi ? { ...x, addTicks: toTicks(Number(e.target.value)) } : x)) })} />
                    <button type="button" aria-label="Remove modifier" className="grid size-11 shrink-0 place-items-center text-muted" onClick={() => patchRecipe(i, { modifiers: r.modifiers.filter((_, k) => k !== mi) })}>
                      <Trash2 size={18} aria-hidden="true" />
                    </button>
                  </div>
                ))}
                <button type="button" className="min-h-14 text-sm font-semibold text-brand underline" onClick={() => patchRecipe(i, { modifiers: [...r.modifiers, { name: "", addTicks: 2 }] })}>
                  Add a modifier that changes the time
                </button>
              </div>
            </div>
          ))}
        </div>
        <Button onClick={() => addRecipe()}>
          <Plus size={16} aria-hidden="true" /> Add dish
        </Button>
        <DictateDish onHeard={(d) => addRecipe(d.name, d.minutes)} />
      </Section>

      <Section title="Easy to forget" hint="Checked before sealing. These are extras, so they don't count as items in the bag.">
        <textarea className={`${inputClass} min-h-24 py-2`} aria-label="Packing reminders, one per line" value={c.reminders.join("\n")} onChange={(e) => set({ reminders: e.target.value.split("\n") })} />
      </Section>

      <details className="rounded-xl border border-line p-3">
        <summary className="min-h-14 cursor-pointer py-2 text-sm font-black">Advanced scheduling</summary>
        <div className="mt-3 space-y-3">
          <p className="text-xs text-muted">
            Illustrative defaults. Calibrate holding penalties and arrival weights with the restaurant. They are assumptions, not a trained model.
          </p>
          <div className="grid grid-cols-3 gap-3">
            <Num label="Early weight %" value={c.uncertainty.weights.early} onChange={(n) => set({ uncertainty: { ...c.uncertainty, weights: { ...c.uncertainty.weights, early: n } } })} />
            <Num label="Expected %" value={c.uncertainty.weights.expected} onChange={(n) => set({ uncertainty: { ...c.uncertainty, weights: { ...c.uncertainty.weights, expected: n } } })} />
            <Num label="Late %" value={c.uncertainty.weights.late} onChange={(n) => set({ uncertainty: { ...c.uncertainty, weights: { ...c.uncertainty.weights, late: n } } })} />
          </div>
          <div className="grid grid-cols-3 gap-3">
            {c.holding.after.map((a, i) => (
              <Num key={i} label={`Penalty ${i + 1} after (min)`} step={0.5} value={toMin(a)} onChange={(n) => set({ holding: { ...c.holding, after: c.holding.after.map((x, k) => (k === i ? toTicks(n) : x)) } })} />
            ))}
            {c.holding.slope.map((a, i) => (
              <Num key={i} label={`Penalty ${i + 1} weight`} min={1} max={20} value={a} onChange={(n) => set({ holding: { ...c.holding, slope: c.holding.slope.map((x, k) => (k === i ? n : x)) } })} />
            ))}
          </div>
          <Num label="Time limit per plan (sec)" min={0.5} max={30} step={0.5} value={c.solver.seconds} onChange={(n) => set({ solver: { ...c.solver, seconds: n } })} />
        </div>
      </details>

      {error && (
        <p role="alert" className="rounded-xl bg-bad-soft p-3 text-sm font-bold text-bad">
          {error}
        </p>
      )}
      <Button tone="primary" type="submit" disabled={busy} className="min-h-14 w-full text-base">
        {submitLabel}
      </Button>
    </form>
  );
}
