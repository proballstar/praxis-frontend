"use client";
import { useRef, useState } from "react";
import {
  Plus,
  ArrowUpRight,
  ClipboardList,
  ArrowLeft,
  ArrowRight,
} from "lucide-react";
import { Button } from "@/components/ui";
import { useKitchen } from "./kitchen";
import { ReceiptCard } from "./Receipt";
type Filter = "active" | "drafts" | "released";
export function OrdersView({ onNew }: { onNew: () => void }) {
  const { snap, call, toast } = useKitchen();
  const [filter, setFilter] = useState<Filter>("active");
  const board = useRef<HTMLElement>(null);
  const scrollReceipts = (direction: number) => {
    const rail = board.current;
    if (!rail) return;
    const width = rail.firstElementChild?.getBoundingClientRect().width ?? 420;
    const gap = Number.parseFloat(getComputedStyle(rail).columnGap) || 18;
    rail.scrollBy({ left: direction * (width + gap), behavior: "smooth" });
  };
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
      <div className="receipt-board-toolbar">
        <span>
          {shown.length} {shown.length === 1 ? "receipt" : "receipts"} ·
          earliest pickup first
        </span>
        <div>
          <button
            aria-label="Previous receipts"
            onClick={() => scrollReceipts(-1)}
          >
            <ArrowLeft size={16} />
          </button>
          <button aria-label="Next receipts" onClick={() => scrollReceipts(1)}>
            <ArrowRight size={16} />
          </button>
        </div>
      </div>
      <section
        ref={board}
        className="receipt-board"
        aria-label="Order receipts"
        tabIndex={0}
      >
        {shown.map((o) => (
          <div className="receipt-column" key={o.id}>
            <ReceiptCard order={o} />
          </div>
        ))}
        {!shown.length && (
          <p className="receipt-board-empty">No {filter} orders right now.</p>
        )}
      </section>
    </div>
  );
}
