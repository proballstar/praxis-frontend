"use client";
import { useState } from "react";
import { Plus, ArrowUpRight, ClipboardList, Truck, Clock3 } from "lucide-react";
import { Button } from "@/components/ui";
import { useKitchen } from "./kitchen";
import { ReceiptCard } from "./Receipt";
type Filter = "active" | "drafts" | "released";
export function OrdersView({ onNew }: { onNew: () => void }) {
  const { snap, call, toast, fmt } = useKitchen();
  const [filter, setFilter] = useState<Filter>("active");
  const [selected, setSelected] = useState<string | null>(null);
  if (!snap) return null;
  const open = snap.orders.filter(
    (o) => o.status === "DRAFT" || o.status === "RELEASED",
  );
  const shown = open
    .filter((o) =>
      filter === "drafts"
        ? o.status === "DRAFT"
        : filter === "released"
          ? o.status === "RELEASED"
          : true,
    )
    .sort((a, b) => a.targetMs - b.targetMs || a.number - b.number);
  const drafts = open.filter((o) => o.status === "DRAFT").length;
  const current = shown.find((o) => o.id === selected) ?? shown[0];
  const chips: [Filter, string, number][] = [
    ["active", "All orders", open.length],
    ["drafts", "Drafts", drafts],
    ["released", "Released", open.length - drafts],
  ];
  if (!open.length)
    return (
      <section className="orders-empty">
        <div className="empty-order-art">
          <ClipboardList size={37} strokeWidth={1.4} />
          <span>
            <Plus size={13} />
          </span>
        </div>
        <span className="eyebrow">READY WHEN YOU ARE</span>
        <h2>
          A clear board.
          <br />A fresh start.
        </h2>
        <p>
          Add your first order. Praxis coordinates preparation around your
          stations and pickup times.
        </p>
        <Button tone="primary" onClick={onNew}>
          <Plus size={17} />
          New order
        </Button>
        <button
          className="sample-load"
          onClick={async () => {
            const r = await call("/api/sample", { action: "load" });
            if (!r.ok) toast(r.error ?? "Couldn’t load sample orders.");
          }}
        >
          Try it with sample orders
          <ArrowUpRight size={14} />
        </button>
        <div className="empty-flow">
          <span>01 Receive</span>
          <i />
          <span>02 Prepare</span>
          <i />
          <span>03 Pack & hand off</span>
        </div>
      </section>
    );
  return (
    <div className="order-workspace">
      <div className="order-toolbar">
        <div role="group" aria-label="Filter orders" className="order-filters">
          {chips.map(([id, label, n]) => (
            <button
              key={id}
              aria-pressed={filter === id}
              onClick={() => setFilter(id)}
            >
              {label}
              <span>{n}</span>
            </button>
          ))}
        </div>
        {open.some((o) => o.sample) && (
          <button
            className="clear-samples"
            onClick={() => call("/api/sample", { action: "clear" })}
          >
            Clear sample orders
          </button>
        )}
      </div>
      <div className="order-master-detail">
        <aside className="order-list" aria-label="Order list">
          <div className="order-list-heading">
            <span>ORDER QUEUE</span>
            <span>{shown.length} orders</span>
          </div>
          {shown.map((o) => (
            <button
              key={o.id}
              className={`order-list-card ${current?.id === o.id ? "is-selected" : ""}`}
              onClick={() => setSelected(o.id)}
              aria-label={`Select order ${o.number}`}
              aria-pressed={current?.id === o.id}
            >
              <div className="order-list-card-top">
                <b>#{o.number}</b>
                <span
                  className={
                    o.status === "DRAFT" ? "queue-draft" : "queue-issued"
                  }
                >
                  {o.status === "DRAFT" ? "Draft" : "Released"}
                </span>
              </div>
              <strong>{o.customer || "Guest"}</strong>
              <p>
                {o.itemCount} items · {o.items.map((i) => i.name).join(", ")}
              </p>
              <div className="order-list-card-bottom">
                <span>
                  <Truck size={13} />
                  {o.driver ? fmt(o.driver.arrivalMs) : fmt(o.promisedMs)}
                </span>
                <span
                  className={
                    o.plan.risk === "at_risk" ? "queue-risk" : "queue-ontime"
                  }
                >
                  <i />
                  {o.plan.risk === "at_risk"
                    ? "At risk"
                    : o.plan.risk === "no_plan"
                      ? "Planning"
                      : "On time"}
                </span>
              </div>
            </button>
          ))}
          {!shown.length && (
            <p className="list-empty">No {filter} orders right now.</p>
          )}
          <div className="queue-note">
            <Clock3 size={14} />
            <span>
              Ordered by pickup target.
              <br />
              Issued plans stay fixed.
            </span>
          </div>
        </aside>
        <div className="receipt-detail">
          {current ? (
            <ReceiptCard key={current.id} order={current} />
          ) : (
            <div className="receipt-placeholder">
              Select an order to view its receipt.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
