"use client";
import { FormEvent, useRef, useState } from "react";
import { Minus, Plus, X } from "lucide-react";
import { Button, Field, inputClass } from "@/components/ui";
import { useKitchen } from "./kitchen";

type Channel = "delivery" | "walk_in" | "phone";
type Line = {
  key: string;
  recipe: string;
  qty: number;
  modifiers: string[];
  allergen: string;
  custom?: { name: string; station: string; minutes: number };
};

const PRESETS = [5, 10, 15, 20, 30, 45];
const CHANNELS: [Channel, string][] = [
  ["delivery", "Delivery"],
  ["walk_in", "Walk-in"],
  ["phone", "Phone"],
];

export function NewOrderSheet({ onDone }: { onDone: () => void }) {
  const { snap, call, toast } = useKitchen();
  const [channel, setChannel] = useState<Channel>("delivery");
  const [customer, setCustomer] = useState("");
  const [driver, setDriver] = useState("");
  const [minutes, setMinutes] = useState<number | null>(20);
  const [lines, setLines] = useState<Line[]>([]);
  const [allergen, setAllergen] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);
  if (!snap) return null;
  const recipes = snap.config.recipes;
  const stations = snap.config.stations.filter((s) => s.id !== snap.config.packStation);

  const add = (recipe: string) =>
    setLines((all) => {
      const plain = all.find((l) => l.recipe === recipe && !l.modifiers.length && !l.allergen && !l.custom);
      if (plain) return all.map((l) => (l === plain ? { ...l, qty: Math.min(20, l.qty + 1) } : l));
      return [...all, { key: `l${++seq.current}`, recipe, qty: 1, modifiers: [], allergen: "" }];
    });
  const patch = (key: string, p: Partial<Line>) => setLines((all) => all.map((l) => (l.key === key ? { ...l, ...p } : l)));
  const toggleMod = (l: Line, name: string) =>
    patch(l.key, { modifiers: l.modifiers.includes(name) ? l.modifiers.filter((m) => m !== name) : [...l.modifiers, name] });
  const total = lines.reduce((n, l) => n + l.qty, 0);
  const incomplete = lines.some((l) => l.custom && (!l.custom.name.trim() || !l.custom.minutes));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const r = await call("/api/orders", {
      channel,
      customer,
      driverName: channel === "delivery" ? driver : "",
      allergen,
      ...(channel === "delivery"
        ? minutes === null
          ? {}
          : { etaMinutes: minutes }
        : { promisedMinutes: minutes ?? 20 }),
      items: lines.map((l) =>
        l.custom
          ? { name: l.custom.name, station: l.custom.station, minutes: l.custom.minutes, qty: l.qty, modifiers: l.modifiers, allergen: l.allergen }
          : { recipe: l.recipe, qty: l.qty, modifiers: l.modifiers, allergen: l.allergen },
      ),
    });
    setBusy(false);
    if (!r.ok) return setError(r.error ?? "Couldn't add that order.");
    const number = (r.data?.result as { number?: number } | undefined)?.number;
    toast(`Draft #${number} created. Review it, then release it to the kitchen.`);
    onDone();
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <div role="group" aria-label="Order type" className="grid grid-cols-3 gap-2">
        {CHANNELS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-pressed={channel === id}
            onClick={() => setChannel(id)}
            className={`min-h-14 rounded-xl border text-base font-bold ${channel === id ? "border-brand bg-brand text-on-brand" : "border-line bg-raised"}`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-4">
        <Field label="Customer name">
          <input className={inputClass} value={customer} maxLength={60} onChange={(e) => setCustomer(e.target.value)} />
        </Field>
        {channel === "delivery" && (
          <Field label="Driver name" hint="Optional">
            <input className={inputClass} value={driver} maxLength={60} onChange={(e) => setDriver(e.target.value)} />
          </Field>
        )}
      </div>

      <div>
        <p className="mb-1.5 text-sm font-semibold">
          {channel === "delivery" ? "Driver arrives in" : "Promised pickup in"}
        </p>
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={minutes === m}
              onClick={() => setMinutes(m)}
              className={`min-h-14 min-w-16 rounded-xl border px-3 text-base font-semibold ${minutes === m ? "border-brand bg-brand text-on-brand" : "border-line bg-raised"}`}
            >
              {m} min
            </button>
          ))}
          {channel === "delivery" && (
            <button
              type="button"
              aria-pressed={minutes === null}
              onClick={() => setMinutes(null)}
              className={`min-h-14 rounded-xl border px-3 text-base font-semibold ${minutes === null ? "border-brand bg-brand text-on-brand" : "border-line bg-raised"}`}
            >
              Not known: guess {snap.config.defaultEtaMinutes} min
            </button>
          )}
          <input
            className={`${inputClass} w-24!`}
            aria-label="Minutes"
            type="number"
            inputMode="numeric"
            min={0}
            max={360}
            value={minutes ?? ""}
            onChange={(e) => setMinutes(e.target.value === "" ? null : Number(e.target.value))}
          />
        </div>
        {channel === "delivery" && minutes === null && (
          <p className="mt-1 text-xs text-warn">A guessed time is marked as a guess. Update it when the driver app shows a real one.</p>
        )}
      </div>

      <fieldset>
        <legend className="mb-1.5 text-sm font-semibold">Items</legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {recipes.map((r) => {
            const qty = lines.filter((l) => l.recipe === r.id).reduce((n, l) => n + l.qty, 0);
            return (
              <button
                key={r.id}
                type="button"
                onClick={() => add(r.id)}
                className={`min-h-14 rounded-xl border px-3 text-left text-base font-semibold ${qty ? "border-brand bg-soft" : "border-line bg-raised"}`}
              >
                {qty > 0 && <b className="mr-1 text-brand">{qty} ×</b>}
                {r.name}
              </button>
            );
          })}
        </div>
        <Button
          className="mt-2"
          onClick={() =>
            setLines((all) => [
              ...all,
              {
                key: `l${++seq.current}`,
                recipe: "",
                qty: 1,
                modifiers: [],
                allergen: "",
                custom: { name: "", station: stations[0]?.id ?? "", minutes: 8 },
              },
            ])
          }
        >
          <Plus size={16} aria-hidden="true" /> Dish not on the menu
        </Button>
      </fieldset>

      {lines.length > 0 && (
        <div className="space-y-2" aria-label="Order lines">
          {lines.map((l) => {
            const recipe = recipes.find((r) => r.id === l.recipe);
            return (
              <div key={l.key} className="space-y-2 rounded-xl border border-line p-3">
                <div className="flex items-center justify-between gap-2">
                  {l.custom ? (
                    <input
                      className={inputClass}
                      aria-label="Dish name"
                      placeholder="Dish name"
                      value={l.custom.name}
                      maxLength={60}
                      onChange={(e) => patch(l.key, { custom: { ...l.custom!, name: e.target.value } })}
                    />
                  ) : (
                    <b className="text-base">{recipe?.name}</b>
                  )}
                  <div className="flex shrink-0 items-center gap-1">
                    <Button aria-label="One less" onClick={() => (l.qty > 1 ? patch(l.key, { qty: l.qty - 1 }) : setLines((a) => a.filter((x) => x.key !== l.key)))}>
                      <Minus size={16} aria-hidden="true" />
                    </Button>
                    <output className="w-8 text-center text-lg font-black">{l.qty}</output>
                    <Button aria-label="One more" onClick={() => patch(l.key, { qty: Math.min(20, l.qty + 1) })}>
                      <Plus size={16} aria-hidden="true" />
                    </Button>
                    <button type="button" aria-label="Remove line" className="grid size-11 place-items-center text-muted" onClick={() => setLines((a) => a.filter((x) => x.key !== l.key))}>
                      <X size={18} aria-hidden="true" />
                    </button>
                  </div>
                </div>
                {l.custom && (
                  <div className="flex gap-2">
                    <select
                      className={inputClass}
                      aria-label="Station"
                      value={l.custom.station}
                      onChange={(e) => patch(l.key, { custom: { ...l.custom!, station: e.target.value } })}
                    >
                      {stations.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                    <input
                      className={`${inputClass} w-24!`}
                      aria-label="Prep minutes"
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={120}
                      value={l.custom.minutes || ""}
                      onChange={(e) => patch(l.key, { custom: { ...l.custom!, minutes: Number(e.target.value) } })}
                    />
                  </div>
                )}
                {(recipe?.modifiers.length ?? 0) > 0 && (
                  <div className="flex flex-wrap gap-2" role="group" aria-label={`Modifiers for ${recipe?.name}`}>
                    {recipe!.modifiers.map((m) => (
                      <button
                        key={m.name}
                        type="button"
                        aria-pressed={l.modifiers.includes(m.name)}
                        onClick={() => toggleMod(l, m.name)}
                        className={`min-h-14 rounded-full border px-3 text-sm font-semibold ${l.modifiers.includes(m.name) ? "border-warn bg-warn-soft text-warn" : "border-line bg-raised"}`}
                      >
                        {m.name}
                      </button>
                    ))}
                  </div>
                )}
                <input
                  className={inputClass}
                  aria-label={`Note or allergy for ${recipe?.name ?? "dish"}`}
                  placeholder="Allergy or note for this item (optional)"
                  value={l.allergen}
                  maxLength={120}
                  onChange={(e) => patch(l.key, { allergen: e.target.value })}
                />
                {l.qty > 1 && (
                  <button
                    type="button"
                    className="min-h-14 text-sm font-semibold text-brand underline"
                    onClick={() =>
                      setLines((all) => [
                        ...all.map((x) => (x.key === l.key ? { ...x, qty: x.qty - 1 } : x)),
                        { ...l, key: `l${++seq.current}`, qty: 1, modifiers: [], allergen: "" },
                      ])
                    }
                  >
                    Customize just one
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      <Field label="Order allergy or note" hint="Shown on the receipt, every station and the packing screen. Never batched with other food.">
        <textarea className={`${inputClass} min-h-20 py-2`} value={allergen} maxLength={200} onChange={(e) => setAllergen(e.target.value)} />
      </Field>

      {error && (
        <p role="alert" className="rounded-xl bg-bad-soft p-3 text-sm font-semibold text-bad">
          {error}
        </p>
      )}
      <Button tone="primary" type="submit" disabled={busy || !total || incomplete} className="min-h-14 w-full text-base">
        Create draft ({total} item{total === 1 ? "" : "s"})
      </Button>
    </form>
  );
}
