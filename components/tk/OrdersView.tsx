"use client";
import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui";
import { useKitchen } from "./kitchen";
import { ReceiptCard } from "./Receipt";

type Filter = "active" | "drafts" | "released";

export function OrdersView({ onNew }: { onNew: () => void }) {
  const { snap, call, toast } = useKitchen();
  const [filter, setFilter] = useState<Filter>("active");
  if (!snap) return null;
  const open = snap.orders.filter((o) => o.status === "DRAFT" || o.status === "RELEASED");
  const shown = open
    .filter((o) => (filter === "drafts" ? o.status === "DRAFT" : filter === "released" ? o.status === "RELEASED" : true))
    .sort((a, b) => a.targetMs - b.targetMs || a.number - b.number);
  const drafts = open.filter((o) => o.status === "DRAFT").length;
  const released = open.length - drafts;

  if (!open.length)
    return (
      <div className="mx-auto mt-12 max-w-sm px-4 text-center">
        <h2 className="text-2xl font-black">No open orders</h2>
        <p className="mt-2 text-muted">Add an order as it comes in. Praxis plans every component and station for it.</p>
        <Button tone="primary" className="mt-5 min-h-14 w-full text-base" onClick={onNew}>
          <Plus size={18} aria-hidden="true" /> New order
        </Button>
        <Button
          className="mt-2 w-full"
          onClick={async () => {
            const r = await call("/api/sample", { action: "load" });
            if (!r.ok) toast(r.error ?? "Couldn't load samples.");
          }}
        >
          Try it with sample orders
        </Button>
      </div>
    );

  const chips: [Filter, string][] = [
    ["active", `All (${open.length})`],
    ["drafts", `Drafts (${drafts})`],
    ["released", `Released (${released})`],
  ];
  return (
    <div className="mx-auto max-w-7xl px-4 pb-12 sm:px-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div role="group" aria-label="Filter orders" className="flex max-w-full flex-wrap gap-2">
          {chips.map(([id, label]) => (
            <button
              key={id}
              type="button"
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
              className={`min-h-14 rounded-xl border px-3 text-sm font-bold sm:px-5 sm:text-base ${filter === id ? "border-brand bg-brand text-on-brand" : "border-line bg-panel"}`}
            >
              {label}
            </button>
          ))}
        </div>
        {open.some((o) => o.sample) && (
          <button
            type="button"
            className="min-h-14 text-sm font-semibold underline"
            onClick={() => call("/api/sample", { action: "clear" })}
          >
            Clear sample orders
          </button>
        )}
      </div>
      {drafts > 0 && (
        <p className="mb-5 rounded-2xl border border-warn/20 bg-warn-soft p-4 text-base font-semibold text-warn">
          {drafts} draft{drafts === 1 ? "" : "s"} waiting. Drafts can still move when estimates change. A manager releases each
          one to send it to the stations.
        </p>
      )}
      <div className="grid items-start gap-5 xl:grid-cols-2">
        {shown.map((o) => (
          <ReceiptCard key={o.id} order={o} />
        ))}
      </div>
    </div>
  );
}
