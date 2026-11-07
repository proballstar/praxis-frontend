"use client";
import { use, useEffect, useState } from "react";
import { Printer } from "lucide-react";
import { Button } from "@/components/ui";
import { KitchenProvider, useKitchen } from "@/components/tk/kitchen";
import { planGroups } from "@/components/tk/Receipt";

function Sheet({ id }: { id: string }) {
  const { snap, call, fmt } = useKitchen();
  const [label, setLabel] = useState(false);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => setLabel(new URLSearchParams(location.search).get("view") === "label"), []);
  if (!snap) return <p className="p-8 text-center text-muted">Loading…</p>;
  const o = snap.orders.find((x) => x.id === id);
  if (!o) return <p className="p-8 text-center">That order isn&apos;t on the board any more.</p>;

  const print = async () => {
    // Print once per order. A second print needs an explicit second tap.
    if (!label && o.printed.count > 0 && !confirming) return setConfirming(true);
    if (!label) await call(`/api/orders/${o.id}/print`, {});
    setConfirming(false);
    window.print();
  };

  if (label)
    return (
      <div className="mx-auto max-w-sm p-6">
        <div className="no-print mb-4 flex justify-end">
          <Button tone="primary" onClick={print}><Printer size={16} aria-hidden="true" /> Print label</Button>
        </div>
        <div className="print-sheet rounded-xl border-4 border-black p-6 text-center">
          <p className="text-8xl font-black">{o.slot ?? "—"}</p>
          <p className="mt-2 text-4xl font-black">#{o.number}</p>
          <p className="text-3xl font-bold">{o.customer}</p>
          <p className="mt-2 text-xl">{o.source} · {o.itemCount} item{o.itemCount === 1 ? "" : "s"}</p>
        </div>
      </div>
    );

  const pack = o.tasks.find((t) => t.kind === "pack");
  return (
    <div className="mx-auto max-w-xl p-4">
      <div className="no-print mb-4 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <a href="/" className="text-sm font-semibold underline">Back to the board</a>
          <Button tone="primary" onClick={print}><Printer size={16} aria-hidden="true" /> {confirming ? "Print again" : "Print receipt"}</Button>
        </div>
        {o.printed.count > 0 && (
          <p role="status" className="rounded-lg bg-warn-soft p-2 text-sm font-semibold text-warn">
            Already printed {o.printed.count} time{o.printed.count === 1 ? "" : "s"}, last at {fmt(o.printed.lastMs)}. Receipts print once per order. {confirming ? "Tap again to print another copy." : ""}
          </p>
        )}
        {o.status === "DRAFT" && <p className="rounded-lg bg-warn-soft p-2 text-sm text-warn">This is a draft. Times may change before it&apos;s released. Print after releasing.</p>}
      </div>

      <article aria-label={`Receipt for order ${o.number}`} className="print-sheet space-y-3 rounded-xl border-2 border-black bg-white p-5 text-black">
        <header>
          <p className="text-4xl font-black">Order #{o.number}</p>
          <p className="text-xl font-bold">{o.customer} · {o.channel === "delivery" ? "Delivery" : o.channel === "walk_in" ? "Walk-in" : "Phone"}</p>
          <p className="text-lg">Pickup code <b className="text-2xl">{o.pickupCode}</b></p>
          <p className="text-sm">{o.status === "DRAFT" ? "DRAFT" : `ISSUED v${o.plan.version}`}{o.printed.count ? " · reprint" : ""}</p>
        </header>

        <section className="border-y border-black py-2 text-base">
          {o.driver ? (
            <>
              <p>Driver {o.driver.name} ETA <b>{fmt(o.driver.arrivalMs)}</b> <i>(estimate, updated {fmt(o.driver.updatedMs)})</i></p>
            </>
          ) : (
            <p>Promised pickup <b>{fmt(o.promisedMs)}</b></p>
          )}
          <p>Aim to have the checked bag ready at <b>{fmt(o.targetMs)}</b></p>
        </section>

        {o.allergen.flag && <p className="border-2 border-black p-2 text-xl font-black">ALLERGY: {o.allergen.note || "see items"}</p>}

        <section>
          <p className="text-sm font-black">{o.itemCount} ITEM{o.itemCount === 1 ? "" : "S"}</p>
          <ul className="text-lg">
            {o.items.map((i) => (
              <li key={i.id}><b>{i.qty} × {i.name}</b>{i.modifiers.length ? <b> — {i.modifiers.join(", ")}</b> : ""}{i.allergen ? <b> — {i.allergen}</b> : ""}</li>
            ))}
          </ul>
        </section>

        <section className="space-y-2 font-mono text-sm">
          {planGroups(o).map((g) => (
            <div key={g.station}>
              <p className="font-black">{g.station}</p>
              {g.rows.map((r) => (
                <p key={r.key}>{fmt(r.task.plannedStartMs)} Start {r.qty} × {r.label} ({r.task.durationMin + r.task.extraMin} min) → {fmt(r.task.plannedEndMs)}</p>
              ))}
            </div>
          ))}
          {pack && (
            <div>
              <p className="font-black">PACK</p>
              <p>{fmt(pack.plannedStartMs)} Check and bag ({pack.durationMin} min) → {fmt(pack.plannedEndMs)}</p>
            </div>
          )}
        </section>

        <p className="border-t border-black pt-2 text-lg font-black">
          Bag ready est. {fmt(o.plan.bagReadyMs)} — {o.plan.risk === "at_risk" ? `AT RISK: ${o.plan.minutesAfterTarget} min after target${o.plan.minutesAfterEta ? ` / ${o.plan.minutesAfterEta} min after ${o.driver ? "driver ETA" : "promise"}` : ""}` : o.plan.risk === "on_time" ? "ON TIME" : "NO PLAN"}
        </p>
        <p className="text-xs">Illustrative kitchen receipt. Not a DoorDash receipt, and not connected to a printer service.</p>
      </article>
    </div>
  );
}

export default function PrintPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return (
    <KitchenProvider>
      <Sheet id={id} />
    </KitchenProvider>
  );
}
