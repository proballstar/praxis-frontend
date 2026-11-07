"use client";
import { FormEvent, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { KitchenSettings, MAX_STATIONS, MenuItem } from "@/lib/service";
import { Button, Field, inputClass } from "./ui";
import { DictateDish } from "./DictateDish";

export function KitchenForm({
  initial,
  submitLabel,
  onSubmit,
}: {
  initial: KitchenSettings;
  submitLabel: string;
  onSubmit: (settings: KitchenSettings) => Promise<unknown>;
}) {
  const [name, setName] = useState(initial.name);
  const [stations, setStations] = useState(String(initial.stations));
  const [grace, setGrace] = useState(String(initial.graceMinutes));
  const [pack, setPack] = useState(String(initial.packMinutes ?? 2));
  const [menu, setMenu] = useState<MenuItem[]>(initial.menu);
  const [busy, setBusy] = useState(false);

  const edit = (id: string, change: Partial<MenuItem>) =>
    setMenu((m) => m.map((x) => (x.id === id ? { ...x, ...change } : x)));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    await onSubmit({
      name,
      stations: Number(stations),
      graceMinutes: Number(grace),
      packMinutes: Number(pack),
      menu,
    });
    setBusy(false);
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <Field label="Restaurant name">
        <input
          className={inputClass}
          value={name}
          required
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <div className="grid grid-cols-3 gap-4">
        <Field
          label="Cooking stations"
          hint="Orders you can cook at the same time"
        >
          <input
            className={inputClass}
            type="number"
            inputMode="numeric"
            min={1}
            max={MAX_STATIONS}
            required
            value={stations}
            onChange={(e) => setStations(e.target.value)}
          />
        </Field>
        <Field
          label="Packing (min)"
          hint="Bagging and checking after cooking, before ready"
        >
          <input
            className={inputClass}
            type="number"
            inputMode="numeric"
            min={0}
            max={30}
            required
            value={pack}
            onChange={(e) => setPack(e.target.value)}
          />
        </Field>
        <Field
          label="Pickup grace (min)"
          hint="Minutes after the courier arrives before an order counts as late"
        >
          <input
            className={inputClass}
            type="number"
            inputMode="numeric"
            min={0}
            max={60}
            required
            value={grace}
            onChange={(e) => setGrace(e.target.value)}
          />
        </Field>
      </div>
      <fieldset>
        <legend className="mb-1 text-sm font-semibold">
          Menu and prep minutes
        </legend>
        <p className="mb-2 text-xs text-muted">
          Used to estimate each ticket. You can change the estimate on any
          order.
        </p>
        <div className="space-y-2">
          {menu.map((item) => (
            <div key={item.id} className="flex gap-2">
              <input
                className={inputClass}
                aria-label="Dish name"
                value={item.name}
                maxLength={60}
                onChange={(e) => edit(item.id, { name: e.target.value })}
              />
              <input
                className={`${inputClass} w-20! shrink-0`}
                aria-label={`Prep minutes for ${item.name || "dish"}`}
                type="number"
                inputMode="numeric"
                min={1}
                max={240}
                required
                value={item.minutes || ""}
                onChange={(e) =>
                  edit(item.id, { minutes: Number(e.target.value) })
                }
              />
              <button
                type="button"
                aria-label={`Remove ${item.name || "dish"}`}
                className="grid size-11 shrink-0 place-items-center rounded-lg text-muted hover:bg-raised"
                onClick={() =>
                  setMenu((m) => m.filter((x) => x.id !== item.id))
                }
              >
                <Trash2 size={18} />
              </button>
            </div>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            onClick={() =>
              setMenu((m) => [
                ...m,
                { id: crypto.randomUUID(), name: "", minutes: 8 },
              ])
            }
          >
            <Plus size={16} /> Add dish
          </Button>
        </div>
        <DictateDish
          onHeard={(dish) =>
            setMenu((m) => [
              ...m,
              { id: crypto.randomUUID(), name: dish.name, minutes: dish.minutes },
            ])
          }
        />
      </fieldset>
      <Button tone="primary" type="submit" disabled={busy} className="w-full">
        {submitLabel}
      </Button>
    </form>
  );
}
