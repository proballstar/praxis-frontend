"use client";
import { FormEvent, useRef, useState } from "react";
import { Minus, Plus, X } from "lucide-react";
import { KitchenResource, MenuItem, NewOrder, OrderLine } from "@/lib/service";
import { Button, Field, inputClass } from "./ui";

const ETA_CHOICES = [5, 10, 15, 20, 30, 45];

type DraftLine = {
  name: string;
  qty: number;
  note: string;
  menuId: string | null;
  /** The dish needs a person to check it before the order can be added. */
  uncertain: boolean;
};

type Line = DraftLine & {
  key: string;
  minutes: number | null;
  resource: string;
  confirmed: boolean;
};

function ReviewLine({
  line,
  menu,
  resources,
  onChange,
  onRemove,
}: {
  line: Line;
  menu: MenuItem[];
  resources: KitchenResource[];
  onChange: (change: Partial<Line>) => void;
  onRemove: () => void;
}) {
  const unmatched = line.menuId === null;
  const unresolved = unmatched
    ? !line.minutes
    : line.uncertain && !line.confirmed;
  return (
    <div
      aria-label={`Review ${line.name}`}
      role="group"
      className={`space-y-2 rounded-lg border p-3 ${unresolved ? "border-warn bg-warn-soft" : "border-line"}`}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm">
          <b>
            {line.qty} × {line.name}
          </b>
          {line.note && <span className="text-muted"> ({line.note})</span>}
          {unresolved && (
            <span className="block text-xs font-semibold text-warn">
              {unmatched ? "Not on the menu" : "Check this reading"}
            </span>
          )}
        </p>
        <button
          type="button"
          aria-label={`Remove ${line.name}`}
          className="grid size-9 shrink-0 place-items-center rounded text-muted"
          onClick={onRemove}
        >
          <X size={16} />
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select
          className={`${inputClass} flex-1`}
          aria-label={`Dish for ${line.name}`}
          value={line.menuId ?? ""}
          onChange={(e) =>
            onChange({
              menuId: e.target.value || null,
              confirmed: true,
            })
          }
        >
          <option value="">One-off dish</option>
          {menu.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        {unmatched && (
          <>
            <input
              className={`${inputClass} w-20!`}
              aria-label={`Prep minutes for ${line.name}`}
              type="number"
              inputMode="numeric"
              min={1}
              max={240}
              placeholder="min"
              value={line.minutes ?? ""}
              onChange={(e) =>
                onChange({ minutes: Number(e.target.value) || null })
              }
            />
            <select
              className={`${inputClass} w-28!`}
              aria-label={`Resource for ${line.name}`}
              value={line.resource}
              onChange={(e) => onChange({ resource: e.target.value })}
            >
              {resources.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </>
        )}
      </div>
      {!unmatched && line.uncertain && (
        <label className="flex min-h-9 items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="size-5"
            checked={line.confirmed}
            onChange={(e) => onChange({ confirmed: e.target.checked })}
          />
          This is right
        </label>
      )}
    </div>
  );
}

export function NewOrderForm({
  menu,
  resources,
  onSubmit,
}: {
  menu: MenuItem[];
  resources: KitchenResource[];
  onSubmit: (order: NewOrder) => Promise<boolean>;
}) {
  const [ref, setRef] = useState("");
  const [customer, setCustomer] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [eta, setEta] = useState<number | null>(20);
  const [busy, setBusy] = useState(false);
  const nextKey = useRef(0);

  const newLine = (line: DraftLine): Line => ({
    ...line,
    key: `line-${++nextKey.current}`,
    minutes: null,
    resource: resources[0]?.id ?? "",
    confirmed: false,
  });

  const quantity = (menuId: string) =>
    lines
      .filter((l) => l.menuId === menuId)
      .reduce((n, l) => n + l.qty, 0);

  const change = (dish: MenuItem, by: number) =>
    setLines((all) => {
      const plain = all.find(
        (l) => l.menuId === dish.id && !l.note && !l.uncertain,
      );
      if (plain) {
        const qty = plain.qty + by;
        return qty > 0
          ? all.map((l) => (l === plain ? { ...l, qty } : l))
          : all.filter((l) => l !== plain);
      }
      if (by < 0) return all;
      return [
        ...all,
        newLine({
          name: dish.name,
          qty: 1,
          note: "",
          menuId: dish.id,
          uncertain: false,
        }),
      ];
    });

  const update = (key: string, patch: Partial<Line>) =>
    setLines((all) =>
      all.map((l) => {
        if (l.key !== key) return l;
        return { ...l, ...patch };
      }),
    );

  const review = lines.filter(
    (l) => l.menuId === null || l.uncertain || l.note,
  );
  const blocked = lines.some((l) =>
    l.menuId === null ? !l.minutes : l.uncertain && !l.confirmed,
  );

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const orderLines: OrderLine[] = lines.map((l) =>
      l.menuId
        ? { menuId: l.menuId, qty: l.qty, note: l.note }
        : {
            name: l.name,
            qty: l.qty,
            note: l.note,
            minutes: l.minutes ?? undefined,
            resource: l.resource,
          },
    );
    const saved = await onSubmit({
      ref,
      customer,
      lines: orderLines,
      etaMinutes: eta,
    });
    if (!saved) setBusy(false);
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <div className="grid grid-cols-2 gap-4">
        <Field label="Ticket number" hint="Leave blank to number it for you">
          <input
            className={inputClass}
            value={ref}
            maxLength={20}
            onChange={(e) => setRef(e.target.value)}
          />
        </Field>
        <Field label="Customer" hint="Optional">
          <input
            className={inputClass}
            value={customer}
            maxLength={60}
            onChange={(e) => setCustomer(e.target.value)}
          />
        </Field>
      </div>

      <fieldset>
        <legend className="mb-1.5 text-sm font-semibold">Items</legend>
        {review.length > 0 && (
          <div className="mb-2 space-y-2">
            {review.map((line) => (
              <ReviewLine
                key={line.key}
                line={line}
                menu={menu}
                resources={resources}
                onChange={(patch) => update(line.key, patch)}
                onRemove={() =>
                  setLines((all) => all.filter((l) => l.key !== line.key))
                }
              />
            ))}
          </div>
        )}
        <div className="grid grid-cols-2 gap-2">
          {menu.map((m) => {
            const qty = quantity(m.id);
            return (
              <div
                key={m.id}
                className={`flex min-h-12 items-center rounded-lg border ${qty ? "border-brand bg-soft" : "border-line bg-raised"}`}
              >
                <button
                  type="button"
                  className="min-h-12 min-w-0 flex-1 px-3 text-left text-sm font-medium"
                  onClick={() => change(m, 1)}
                >
                  <span className="block truncate">
                    {qty > 0 && <b className="mr-1 text-brand">{qty} ×</b>}
                    {m.name}
                  </span>
                </button>
                {qty > 0 && (
                  <button
                    type="button"
                    aria-label={`One less ${m.name}`}
                    className="grid size-12 shrink-0 place-items-center text-muted"
                    onClick={() => change(m, -1)}
                  >
                    <Minus size={16} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
        <Button
          className="mt-2"
          onClick={() =>
            setLines((all) => [
              ...all,
              newLine({
                name: "Off-menu dish",
                qty: 1,
                note: "",
                menuId: null,
                uncertain: true,
              }),
            ])
          }
        >
          <Plus size={16} /> Dish not on the menu
        </Button>
      </fieldset>

      <div>
        <p className="mb-1.5 text-sm font-semibold">Courier arrives in</p>
        <div className="flex flex-wrap gap-2">
          {ETA_CHOICES.map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={eta === m}
              onClick={() => setEta(m)}
              className={`min-h-11 min-w-14 rounded-lg border px-3 text-sm font-semibold ${eta === m ? "border-brand bg-brand text-on-brand" : "border-line bg-raised"}`}
            >
              {m} min
            </button>
          ))}
          <button
            type="button"
            aria-pressed={eta === null}
            onClick={() => setEta(null)}
            className={`min-h-11 rounded-lg border px-3 text-sm font-semibold ${eta === null ? "border-brand bg-brand text-on-brand" : "border-line bg-raised"}`}
          >
            Not known yet
          </button>
          <input
            className={`${inputClass} w-24!`}
            aria-label="Courier arrives in minutes"
            type="number"
            inputMode="numeric"
            min={0}
            max={240}
            value={eta ?? ""}
            onChange={(e) =>
              setEta(e.target.value === "" ? null : Number(e.target.value))
            }
          />
        </div>
      </div>

      <Button
        tone="primary"
        type="submit"
        disabled={busy || !lines.length || blocked}
        className="w-full"
      >
        Add to queue
      </Button>
      {blocked && (
        <p className="text-center text-xs text-warn">
          Resolve the highlighted items first.
        </p>
      )}
    </form>
  );
}
