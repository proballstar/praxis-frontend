"use client";
import { FormEvent, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { KitchenResource, KitchenSettings, MenuItem } from "@/lib/service";
import { Button, Field, inputClass } from "./ui";
import { DictateDish } from "./DictateDish";

function Numeric({
  label,
  hint,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  min: number;
  max: number;
  onChange: (value: string) => void;
}) {
  return (
    <Field label={label} hint={hint}>
      <input
        className={inputClass}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        required
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </Field>
  );
}

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
  const [resources, setResources] = useState<KitchenResource[]>(initial.resources);
  const [grace, setGrace] = useState(String(initial.graceMinutes));
  const [pack, setPack] = useState(String(initial.packMinutes));
  const [buffer, setBuffer] = useState(String(initial.holdBufferMinutes));
  const [stale, setStale] = useState(String(initial.staleEtaMinutes));
  const [menu, setMenu] = useState<MenuItem[]>(initial.menu);
  const [busy, setBusy] = useState(false);

  const edit = (id: string, change: Partial<MenuItem>) =>
    setMenu((m) => m.map((x) => (x.id === id ? { ...x, ...change } : x)));
  const editResource = (id: string, change: Partial<KitchenResource>) =>
    setResources((all) =>
      all.map((r) => (r.id === id ? { ...r, ...change } : r)),
    );
  const firstResource = resources[0]?.id ?? "";
  const addDish = (dish: Partial<MenuItem> = {}) =>
    setMenu((m) => [
      ...m,
      {
        id: crypto.randomUUID(),
        name: "",
        minutes: 8,
        resource: firstResource,
        qualityMinutes: 15,
        ...dish,
      },
    ]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    await onSubmit({
      name,
      resources,
      graceMinutes: Number(grace),
      packMinutes: Number(pack),
      holdBufferMinutes: Number(buffer),
      staleEtaMinutes: Number(stale),
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

      <fieldset>
        <legend className="mb-1 text-sm font-semibold">
          Resources and capacity
        </legend>
        <p className="mb-2 text-xs text-muted">
          Each station, and how many dishes it can work on at once.
        </p>
        <div className="space-y-2">
          {resources.map((r) => (
            <div key={r.id} className="flex gap-2">
              <input
                className={inputClass}
                aria-label="Resource name"
                value={r.name}
                required
                maxLength={40}
                onChange={(e) => editResource(r.id, { name: e.target.value })}
              />
              <input
                className={`${inputClass} w-20! shrink-0`}
                aria-label={`Capacity of ${r.name || "resource"}`}
                type="number"
                inputMode="numeric"
                min={1}
                max={50}
                required
                value={r.capacity || ""}
                onChange={(e) =>
                  editResource(r.id, { capacity: Number(e.target.value) })
                }
              />
              <button
                type="button"
                aria-label={`Remove ${r.name || "resource"}`}
                disabled={resources.length === 1}
                className="grid size-11 shrink-0 place-items-center rounded-lg text-muted hover:bg-raised disabled:opacity-30"
                onClick={() => {
                  const fallback = resources.find((x) => x.id !== r.id)?.id ?? "";
                  setResources((all) => all.filter((x) => x.id !== r.id));
                  setMenu((m) =>
                    m.map((x) =>
                      x.resource === r.id ? { ...x, resource: fallback } : x,
                    ),
                  );
                }}
              >
                <Trash2 size={18} />
              </button>
            </div>
          ))}
        </div>
        <Button
          className="mt-2"
          onClick={() =>
            setResources((all) => [
              ...all,
              { id: crypto.randomUUID(), name: "", capacity: 1 },
            ])
          }
        >
          <Plus size={16} /> Add resource
        </Button>
      </fieldset>

      <div className="grid grid-cols-2 gap-4">
        <Numeric
          label="Packing (min)"
          hint="Bagging and checking after the last dish"
          value={pack}
          min={0}
          max={30}
          onChange={setPack}
        />
        <Numeric
          label="Pickup grace (min)"
          hint="After the courier arrives, before it counts as late"
          value={grace}
          min={0}
          max={60}
          onChange={setGrace}
        />
        <Numeric
          label="Preparation buffer (min)"
          hint="Finish this far ahead of the courier"
          value={buffer}
          min={0}
          max={15}
          onChange={setBuffer}
        />
        <Numeric
          label="Courier time expires (min)"
          hint="After this, confirm it before holding food"
          value={stale}
          min={5}
          max={120}
          onChange={setStale}
        />
      </div>

      <fieldset>
        <legend className="mb-1 text-sm font-semibold">Menu</legend>
        <p className="mb-2 text-xs text-muted">
          Prep minutes, where it’s made, and how many minutes it stays at its
          best. Quality windows are preferences, not food-safety limits.
        </p>
        <div className="space-y-3">
          {menu.map((item) => (
            <div key={item.id} className="space-y-1.5 rounded-lg border border-line p-2">
              <div className="flex gap-2">
                <input
                  className={inputClass}
                  aria-label="Dish name"
                  value={item.name}
                  maxLength={60}
                  onChange={(e) => edit(item.id, { name: e.target.value })}
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
              <div className="grid grid-cols-3 gap-2">
                <label className="text-xs text-muted">
                  Prep min
                  <input
                    className={inputClass}
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
                </label>
                <label className="text-xs text-muted">
                  Made on
                  <select
                    className={inputClass}
                    aria-label={`Resource for ${item.name || "dish"}`}
                    value={item.resource}
                    onChange={(e) => edit(item.id, { resource: e.target.value })}
                  >
                    {resources.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name || "Unnamed"}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-xs text-muted">
                  Best for min
                  <input
                    className={inputClass}
                    aria-label={`Quality window for ${item.name || "dish"}`}
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={240}
                    required
                    value={item.qualityMinutes || ""}
                    onChange={(e) =>
                      edit(item.id, { qualityMinutes: Number(e.target.value) })
                    }
                  />
                </label>
              </div>
            </div>
          ))}
        </div>
        <Button className="mt-2" onClick={() => addDish()}>
          <Plus size={16} /> Add dish
        </Button>
        <DictateDish
          onHeard={(dish) => addDish({ name: dish.name, minutes: dish.minutes })}
        />
      </fieldset>
      <Button tone="primary" type="submit" disabled={busy} className="w-full">
        {submitLabel}
      </Button>
    </form>
  );
}
