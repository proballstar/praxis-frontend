"use client";
import { useState } from "react";
import { PackageCheck, Printer } from "lucide-react";
import type { OrderView } from "@/lib/tk/snapshot";
import { Button, Pill, Sheet, inputClass } from "@/components/ui";
import { useKitchen } from "./kitchen";

type SealResult = {
  slot: string;
  warnings: string[];
  label: { slot: string; number: number; customer: string; channel: string; count: number };
  orderId: string;
};

function CheckRow({ label, detail, checked, onChange, onMissing }: { label: string; detail?: string; checked: boolean; onChange: (v: boolean) => void; onMissing?: () => void }) {
  return (
    <li className="flex items-center justify-between gap-3 rounded-xl border border-line bg-raised px-3 py-1">
      <label className="flex min-h-18 min-w-0 flex-1 cursor-pointer items-center gap-4 py-3 text-lg">
        <input type="checkbox" className="size-9 shrink-0 accent-[var(--brand)]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span>
          <b>{label}</b>
          {detail && <b className="ml-2 rounded bg-warn-soft px-2 text-warn">{detail}</b>}
        </span>
      </label>
      {onMissing && (
        <button type="button" className="min-h-14 shrink-0 text-sm font-semibold text-bad underline" onClick={onMissing}>
          Missing?
        </button>
      )}
    </li>
  );
}

function PackCard({ order, onSealed }: { order: OrderView; onSealed: (r: SealResult) => void }) {
  const { call, toast, fmt, minutesFrom } = useKitchen();
  const [count, setCount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [remake, setRemake] = useState<{ itemId: string; name: string } | null>(null);
  const [reason, setReason] = useState("");

  const food = order.items.filter((i) => i.category !== "drink");
  const drinks = order.items.filter((i) => i.category === "drink");
  const checkedAll = order.items.every((i) => i.checked) && order.reminders.every((r) => r.checked);
  const allergenOk = !order.allergen.flag || order.allergen.acknowledged;
  const counted = count !== "" && Number(count) === order.itemCount;
  const ready = checkedAll && allergenOk && counted;
  const wait = minutesFrom(order.targetMs);

  const check = async (key: string, checked: boolean) => {
    const r = await call(`/api/orders/${order.id}/check`, { key, checked });
    if (!r.ok) toast(r.error ?? "Couldn't save that check.");
  };

  async function seal() {
    setBusy(true);
    setError("");
    const r = await call(`/api/orders/${order.id}/seal`, { count: Number(count), allergenAck: order.allergen.acknowledged });
    setBusy(false);
    if (!r.ok) return setError(r.error ?? "Couldn't seal that bag.");
    onSealed({ ...(r.data?.result as Omit<SealResult, "orderId">), orderId: order.id });
    setCount("");
  }

  return (
    <article aria-label={`Pack order ${order.number}`} className="tk-pack min-w-0 space-y-5 rounded-2xl border-2 border-brand bg-panel p-5 shadow-sm sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <p className="flex flex-wrap items-baseline gap-x-3">
            <span className="text-4xl font-black tracking-tight">#{order.number}</span>
            <span className="text-xl font-bold">{order.customer}</span>
          </p>
          <p className="text-sm text-muted">
            {order.channel === "delivery" ? `Driver ${order.driver?.name ?? ""} · ETA ${fmt(order.expectedMs)}` : `Promised ${fmt(order.expectedMs)}`}
            {" · "}
            <b className={wait < 0 ? "text-bad" : ""}>{wait < 0 ? `${-wait} min past target` : `target in ${wait} min`}</b>
          </p>
        </div>
        <Pill tone="good">READY TO PACK</Pill>
      </header>

      {order.allergen.flag && (
        <div role="alert" className="space-y-2 rounded-xl bg-bad-soft p-3">
          <p className="text-lg font-black text-bad">ALLERGY: {order.allergen.note || "see items"}</p>
          <label className="flex min-h-14 cursor-pointer items-center gap-3 text-base font-bold text-bad">
            <input
              type="checkbox"
              className="size-9 accent-[var(--bad)]"
              checked={order.allergen.acknowledged}
              onChange={(e) => call(`/api/orders/${order.id}/allergen`, { acknowledged: e.target.checked })}
            />
            I checked the allergy note against this bag
          </label>
          <p className="text-xs text-bad">A reminder, not a replacement for your restaurant&apos;s allergy procedure.</p>
        </div>
      )}

      <section>
        <h3 className="mb-3 text-sm font-black tracking-wider text-muted">FOOD</h3>
        <ul className="space-y-2">
          {food.map((i) => (
            <CheckRow key={i.id} label={`${i.qty} × ${i.name}`} detail={i.modifiers.join(", ")} checked={i.checked} onChange={(v) => check(`item:${i.id}`, v)} onMissing={() => setRemake({ itemId: i.id, name: i.name })} />
          ))}
        </ul>
      </section>

      <section>
        <h3 className="mb-3 text-sm font-black tracking-wider text-muted">EASY TO FORGET</h3>
        <ul className="space-y-2">
          {drinks.map((i) => (
            <CheckRow key={i.id} label={`${i.qty} × ${i.name}`} detail={i.modifiers.join(", ")} checked={i.checked} onChange={(v) => check(`item:${i.id}`, v)} onMissing={() => setRemake({ itemId: i.id, name: i.name })} />
          ))}
          {order.reminders.map((r) => (
            <CheckRow key={r.name} label={r.name} checked={r.checked} onChange={(v) => check(`rem:${r.name}`, v)} />
          ))}
        </ul>
      </section>

      <section className="flex flex-wrap items-end gap-3 border-t border-line pt-3">
        <label className="block">
          <span className="block text-sm font-semibold">
            Count the items in the bag. Expected: <b className="text-lg">{order.itemCount}</b>
          </span>
          <input
            className={`${inputClass} mt-2 min-h-18 w-28 text-center text-3xl font-black`}
            inputMode="numeric"
            type="number"
            min={0}
            max={99}
            value={count}
            onChange={(e) => setCount(e.target.value)}
            aria-label={`Items counted for order ${order.number}`}
          />
        </label>
        <Button tone="primary" className="min-h-18 flex-1 text-xl font-black" disabled={!ready || busy} onClick={seal}>
          <PackageCheck size={22} aria-hidden="true" /> Seal bag
        </Button>
      </section>
      {!ready && (
        <p className="text-sm text-muted">
          {!checkedAll ? "Check every item and extra. " : ""}
          {!allergenOk ? "Confirm the allergy check. " : ""}
          {!counted ? `Enter the count (${order.itemCount}).` : ""}
        </p>
      )}
      {error && (
        <p role="alert" className="rounded-xl bg-bad-soft p-3 text-sm font-bold text-bad">
          {error}
        </p>
      )}

      {remake && (
        <Sheet title={`Remake: ${remake.name}`} onClose={() => setRemake(null)}>
          <div className="space-y-3">
            <p className="text-sm text-muted">
              Only this item goes back to its station. The original stays in the history and the count doesn&apos;t change.
            </p>
            <input className={inputClass} aria-label="What was missing?" placeholder="What was missing or wrong?" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
            <Button
              tone="primary"
              className="w-full"
              disabled={!reason.trim()}
              onClick={async () => {
                const r = await call(`/api/orders/${order.id}/remake`, { itemId: remake.itemId, reason });
                if (!r.ok) return toast(r.error ?? "Couldn't remake that.");
                toast(`${remake.name} sent back to its station.`);
                setRemake(null);
                setReason("");
              }}
            >
              Send back to the station
            </Button>
          </div>
        </Sheet>
      )}
    </article>
  );
}

function Cooking({ order }: { order: OrderView }) {
  const { fmt } = useKitchen();
  const food = order.tasks.filter((t) => t.kind !== "pack");
  const done = food.filter((t) => t.status === "DONE").length;
  return (
    <li className="rounded-xl border border-line bg-panel p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p>
          <b className="text-xl">#{order.number}</b> <span className="font-semibold">{order.customer}</span>
        </p>
        <p className="text-sm text-muted">
          {done} of {food.length} made · bag ready about <b>{fmt(order.plan.bagReadyMs)}</b>
        </p>
      </div>
      <ul className="mt-2 flex flex-wrap gap-2" aria-label="Component status">
        {food.map((t) => (
          <li
            key={t.id}
            className={`rounded-full px-3 py-1 text-sm font-semibold ${t.status === "DONE" ? "bg-soft text-brand" : t.status === "COOKING" ? "bg-warn-soft text-warn" : "bg-raised text-muted"}`}
          >
            {t.status === "DONE" ? "✓ " : t.status === "COOKING" ? "● " : "○ "}
            {t.remake ? "Remake: " : ""}
            {t.name}
            {t.status === "COOKING" ? " (cooking)" : t.status === "ISSUED" ? ` (${fmt(t.plannedStartMs)})` : ""}
          </li>
        ))}
      </ul>
    </li>
  );
}

export function PackingView() {
  const { snap } = useKitchen();
  const [sealed, setSealed] = useState<SealResult | null>(null);
  if (!snap) return null;
  const ready = snap.orders.filter((o) => o.phase === "ready_to_pack").sort((a, b) => a.expectedMs - b.expectedMs);
  const cooking = snap.orders.filter((o) => o.phase === "cooking").sort((a, b) => a.expectedMs - b.expectedMs);
  return (
    <div className="mx-auto max-w-4xl space-y-8 px-4 pb-12 sm:px-6">
      <section aria-label="Ready to pack">
        <h2 className="mb-4 text-2xl font-black tracking-tight">Ready to pack ({ready.length})</h2>
        {!ready.length && <p className="rounded-xl border border-dashed border-line p-6 text-center text-muted">Nothing is ready to pack yet.</p>}
        <div className="space-y-4">{ready.map((o) => <PackCard key={o.id} order={o} onSealed={setSealed} />)}</div>
      </section>
      {cooking.length > 0 && (
        <section aria-label="Still cooking">
          <h2 className="mb-4 text-2xl font-black tracking-tight">Still cooking ({cooking.length})</h2>
          <ul className="space-y-2">{cooking.map((o) => <Cooking key={o.id} order={o} />)}</ul>
        </section>
      )}
      {sealed && (
        <Sheet title="Bag sealed" onClose={() => setSealed(null)}>
          <div className="space-y-4 text-center">
            <p className="text-sm text-muted">Put it on shelf</p>
            <p className="text-7xl font-black" aria-label={`Shelf slot ${sealed.slot}`}>{sealed.slot}</p>
            <div className="rounded-xl border-2 border-dashed border-line p-4 text-left">
              <p className="text-4xl font-black tracking-tight">#{sealed.label.number} · {sealed.label.customer}</p>
              <p className="text-lg">{sealed.label.channel} · {sealed.label.count} item{sealed.label.count === 1 ? "" : "s"}</p>
            </div>
            {sealed.warnings.map((w) => (
              <p key={w} role="alert" className="rounded-xl bg-warn-soft p-3 text-left text-sm font-bold text-warn">{w}</p>
            ))}
            <div className="flex gap-2">
              <a href={`/print/${sealed.orderId}?view=label`} target="_blank" rel="noreferrer" className="inline-flex min-h-14 flex-1 items-center justify-center gap-2 rounded-xl border border-line bg-panel px-3.5 text-sm font-semibold hover:bg-raised">
                <Printer size={16} aria-hidden="true" /> Print bag label
              </a>
              <Button tone="primary" className="flex-1" onClick={() => setSealed(null)}>Done</Button>
            </div>
          </div>
        </Sheet>
      )}
    </div>
  );
}
