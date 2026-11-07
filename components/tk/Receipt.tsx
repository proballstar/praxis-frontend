"use client";
import { ReactNode, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  Printer,
  Siren,
  Undo2,
} from "lucide-react";
import type { OrderView, TaskView } from "@/lib/tk/snapshot";
import { Button, Pill } from "@/components/ui";
import { useKitchen } from "./kitchen";

const CHANNEL: Record<OrderView["channel"], string> = {
  delivery: "Delivery",
  walk_in: "Walk-in",
  phone: "Phone",
};

const PHASE: Record<
  OrderView["phase"],
  { label: string; tone: "good" | "warn" | "bad" | "quiet" }
> = {
  draft: { label: "DRAFT", tone: "warn" },
  cooking: { label: "RELEASED", tone: "good" },
  ready_to_pack: { label: "READY TO PACK", tone: "good" },
  sealed: { label: "SEALED", tone: "good" },
  handed_off: { label: "HANDED OFF", tone: "quiet" },
  cancelled: { label: "CANCELLED", tone: "quiet" },
};

export function RiskBadge({ order }: { order: OrderView }) {
  const { plan } = order;
  if (plan.risk === "no_plan") return <Pill tone="quiet">NO PLAN YET</Pill>;
  if (plan.risk === "at_risk")
    return (
      <span className="inline-flex items-center gap-2 rounded-lg border border-bad/30 bg-bad-soft px-3 py-2 text-sm font-black text-bad">
        <AlertTriangle size={16} aria-hidden="true" /> AT RISK
      </span>
    );
  return (
    <span className="inline-flex items-center gap-2 rounded-lg border border-brand/20 bg-soft px-3 py-2 text-sm font-black text-brand">
      <CheckCircle2 size={16} aria-hidden="true" /> ON TIME
    </span>
  );
}

export type PlanRow = {
  key: string;
  task: TaskView;
  qty: number;
  label: string;
  done: boolean;
  cooking: boolean;
};

export type PlanGroup = { station: string; rows: PlanRow[] };

/** Food components grouped by station on one receipt, with the packing step last. */
export function planGroups(order: OrderView): PlanGroup[] {
  const groups = new Map<string, Map<string, PlanRow>>();
  for (const t of order.tasks) {
    if (t.kind === "pack") continue;
    const station = t.stationName.toUpperCase();
    const rows = groups.get(station) ?? new Map<string, PlanRow>();
    const key = t.batchId ?? t.id;
    const existing = rows.get(key);
    if (existing) existing.qty += 1;
    else {
      const mods = t.modifiers.length ? `, ${t.modifiers.join(", ")}` : "";
      rows.set(key, {
        key,
        task: t,
        qty: 1,
        label: `${t.remake ? "REMAKE: " : ""}${t.name}${mods}`,
        done: t.status === "DONE",
        cooking: t.status === "COOKING",
      });
    }
    groups.set(station, rows);
  }
  return [...groups.entries()]
    .map(([station, rows]) => ({
      station,
      rows: [...rows.values()].sort(
        (a, b) => (a.task.plannedStartMs ?? 0) - (b.task.plannedStartMs ?? 0),
      ),
    }))
    .sort(
      (a, b) =>
        (a.rows[0]?.task.plannedStartMs ?? 0) -
        (b.rows[0]?.task.plannedStartMs ?? 0),
    );
}

const dur = (m: number) => `${Number.isInteger(m) ? m : m.toFixed(1)} min`;

function PlanTable({ order }: { order: OrderView }) {
  const { fmt } = useKitchen();
  const pack = order.tasks.find((t) => t.kind === "pack");
  return (
    <div className="ticket-plan" aria-label="Preparation plan">
      <div className="ticket-plan-columns">
        <span>START</span>
        <span>COMPONENT / DURATION</span>
        <span>FINISH</span>
      </div>
      {planGroups(order).map((g) => (
        <div className="ticket-station" key={g.station}>
          <div className="ticket-station-name">
            {g.station}
            <span>
              {g.rows.length} {g.rows.length === 1 ? "run" : "runs"}
            </span>
          </div>
          {g.rows.map((r) => (
            <div
              key={r.key}
              className={`ticket-plan-row ${r.done ? "is-done" : ""}`}
            >
              <b>{fmt(r.task.plannedStartMs)}</b>
              <div>
                <strong>
                  {r.qty} × {r.label}
                </strong>
                <small>
                  {dur(r.task.durationMin + r.task.extraMin)}
                  {r.task.batchId
                    ? ` · shared batch of ${r.qty} · one equipment run`
                    : ""}
                  {r.cooking ? " · COOKING" : ""}
                  {r.done ? " · DONE" : ""}
                  {r.task.slid && !r.done && !r.cooking
                    ? " · LATE TO START"
                    : ""}
                </small>
              </div>
              <b>{fmt(r.task.plannedEndMs)}</b>
            </div>
          ))}
        </div>
      ))}
      {pack && (
        <div className="ticket-station">
          <div className="ticket-station-name">PACK & CHECK</div>
          <div className="ticket-plan-row">
            <b>{fmt(pack.plannedStartMs)}</b>
            <div>
              <strong>Check and bag</strong>
              <small>{dur(pack.durationMin)}</small>
            </div>
            <b>{fmt(pack.plannedEndMs)}</b>
          </div>
        </div>
      )}
      <div className="ticket-plan-note">
        {order.status === "DRAFT"
          ? "Draft instructions · may change until released"
          : "Issued instructions · times, stations and batches are fixed"}
      </div>
    </div>
  );
}

function Explain({ order }: { order: OrderView }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="inline-flex min-h-14 items-center gap-1 text-sm font-semibold text-brand"
      >
        How this time was set
        <ChevronDown
          size={16}
          className={open ? "rotate-180" : ""}
          aria-hidden="true"
        />
      </button>
      {open && (
        <div className="mt-1 space-y-2 pickup-timing rounded-lg border border-line bg-raised p-3 text-sm leading-relaxed">
          {order.explanation.steps.map((s) => (
            <p key={s.title}>
              <b>{s.title}.</b> {s.detail}
            </p>
          ))}
          <p className="text-xs text-muted">{order.explanation.caveat}</p>
        </div>
      )}
    </div>
  );
}

function EtaControls({ order }: { order: OrderView }) {
  const { call, toast, now } = useKitchen();
  const [busy, setBusy] = useState(false);
  if (
    !order.driver ||
    (order.status !== "DRAFT" && order.status !== "RELEASED")
  )
    return null;
  const current = Math.max(
    0,
    Math.round((order.driver.arrivalMs - now) / 60_000),
  );
  const set = async (minutes: number) => {
    setBusy(true);
    const r = await call(`/api/orders/${order.id}/eta`, {
      minutes: Math.max(0, minutes),
    });
    if (!r.ok) toast(r.error ?? "Couldn't update the driver time.");
    setBusy(false);
  };
  return (
    <div
      className="flex flex-wrap items-center gap-2"
      role="group"
      aria-label={`Update driver time for order ${order.number}`}
    >
      <span className="text-sm font-semibold">Driver in {current} min</span>
      {[-5, -2, 2, 5].map((d) => (
        <Button
          key={d}
          className="min-w-12 px-2.5"
          disabled={busy || current + d < 0}
          aria-label={`Driver ${d < 0 ? "earlier" : "later"} by ${Math.abs(d)} minutes`}
          onClick={() => set(current + d)}
        >
          {d > 0 ? `+${d}` : d}
        </Button>
      ))}
      <Button disabled={busy} onClick={() => set(0)}>
        Driver is here
      </Button>
    </div>
  );
}

export function ReceiptCard({
  order,
  children,
}: {
  order: OrderView;
  children?: ReactNode;
}) {
  const { call, toast, fmt } = useKitchen();
  const [busy, setBusy] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [reason, setReason] = useState("");
  const phase = PHASE[order.phase];
  const open = order.status === "DRAFT" || order.status === "RELEASED";

  const act = async (action: string, body: object = {}, ok = "") => {
    setBusy(true);
    const r = await call(`/api/orders/${order.id}/${action}`, body);
    setBusy(false);
    if (!r.ok) toast(r.error ?? "That didn't work.");
    else if (ok) toast(ok);
    return r.ok;
  };

  const { plan, driver } = order;
  return (
    <article
      aria-label={`Order ${order.number}`}
      className={`tk-receipt min-w-0 space-y-4 rounded-xl border bg-panel p-5 sm:p-6 ${plan.risk === "at_risk" && open ? "border-line" : "border-line"}`}
    >
      <header className="receipt-ticket-header flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <span className="ticket-kicker">ORDER RECEIPT</span>
          <p className="flex flex-wrap items-baseline gap-x-3">
            <span className="text-2xl font-semibold tracking-tight">
              #{order.number}
            </span>
            <span className="text-base font-semibold">{order.customer}</span>
            {order.sample && (
              <span className="text-xs font-bold uppercase text-muted">
                Sample
              </span>
            )}
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm">
            <Pill tone="quiet">{CHANNEL[order.channel]}</Pill>
            <span className="text-muted">{order.source}</span>
            <span className="rounded-md border border-line px-2 py-0.5 font-mono font-bold">
              Pickup code {order.pickupCode}
            </span>
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Pill tone={phase.tone}>
            {phase.label}
            {order.status === "RELEASED" ? ` · v${plan.version}` : ""}
            {order.slot ? ` · ${order.slot}` : ""}
          </Pill>
          {open && <RiskBadge order={order} />}
        </div>
      </header>

      <section
        aria-label="Pickup timing"
        className="pickup-timing rounded-lg border border-line bg-raised p-3 text-sm leading-relaxed"
      >
        {driver ? (
          <>
            <p>
              <b>Driver{driver.name ? ` ${driver.name}` : ""}</b> arrives about{" "}
              <b className="text-xl">{fmt(driver.arrivalMs)}</b>{" "}
              <span className="text-muted">(estimate · {driver.source})</span>
            </p>
            <p className={driver.stale ? "font-bold text-warn" : "text-muted"}>
              Updated {fmt(driver.updatedMs)} · {driver.ageMinutes} min ago
              {driver.stale ? " · STALE: ask for a fresh estimate" : ""}
              {" · "}could be {Math.round(driver.earlyS)} s early to{" "}
              {Math.round(driver.lateS)} s late
            </p>
          </>
        ) : (
          <p>
            <b>Promised pickup</b>{" "}
            <b className="text-xl">{fmt(order.promisedMs)}</b>{" "}
            <span className="text-muted">
              ({CHANNEL[order.channel].toLowerCase()} order, a promise rather
              than an estimate)
            </span>
          </p>
        )}
        <p>
          Aim to have the checked bag ready at{" "}
          <b className="text-xl">{fmt(order.targetMs)}</b>
        </p>
      </section>

      <section
        aria-label="Bag-ready estimate"
        className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3"
      >
        <div>
          <p className="text-sm text-muted">ESTIMATED BAG-READY</p>
          <p className="text-2xl font-semibold tracking-tight tabular-nums">
            {fmt(plan.bagReadyMs)}
          </p>
        </div>
        <div className="text-right text-sm">
          {plan.minutesAfterTarget !== null && (
            <p className="font-bold text-bad">
              {plan.minutesAfterTarget} min after target
              {plan.minutesAfterEta
                ? ` · ${plan.minutesAfterEta} min after ${order.driver ? "driver ETA" : "promise"}`
                : ""}
            </p>
          )}
          {plan.slippedMin > 0 && (
            <p className="text-warn">
              Printed plan said {fmt(plan.plannedBagReadyMs)}; now about{" "}
              {plan.slippedMin} min later.
            </p>
          )}
        </div>
      </section>

      {order.allergen.flag && (
        <p
          role="alert"
          className="rounded-xl border-l-4 border-bad bg-bad-soft p-4 text-lg font-black text-bad"
        >
          ALLERGY: {order.allergen.note || "see items"}
        </p>
      )}

      <section aria-label="Items">
        <p className="text-xs font-black tracking-wider text-muted">
          {order.itemCount} ITEM{order.itemCount === 1 ? "" : "S"}
        </p>
        <ul>
          {order.items.map((i) => (
            <li
              key={i.id}
              className="border-b border-line py-2.5 text-base last:border-0"
            >
              <b>
                {i.qty} × {i.name}
              </b>
              {i.modifiers.length > 0 && (
                <b className="ml-2 rounded bg-warn-soft px-2 text-warn">
                  {i.modifiers.join(", ")}
                </b>
              )}
              {i.allergen && <b className="ml-2 text-bad">{i.allergen}</b>}
            </li>
          ))}
        </ul>
      </section>

      <section>
        <p className="mb-1 text-xs font-black tracking-wider text-muted">
          {order.status === "DRAFT"
            ? "DRAFT PLAN (may change)"
            : "ISSUED PREPARATION PLAN · FIXED"}
        </p>
        {order.tasks.some((t) => t.plannedStartMs === null) ? (
          <p className="text-sm text-warn">
            No plan yet. Planning is running, or the scheduler needs attention.
          </p>
        ) : (
          <PlanTable order={order} />
        )}
      </section>

      {plan.lockedAtRisk && (
        <p
          role="status"
          className="flex items-start gap-2 rounded-xl bg-warn-soft p-3 text-sm font-semibold text-warn"
        >
          <Siren size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
          This receipt is issued, so it won&apos;t change by itself. A manager
          can withdraw the unstarted items and issue a replacement.
        </p>
      )}
      {plan.missedStarts.length > 0 && (
        <p
          role="status"
          className="rounded-xl bg-bad-soft p-3 text-sm font-bold text-bad"
        >
          Should have started already: {plan.missedStarts.join(", ")}.
        </p>
      )}
      {plan.withdrawnNote && order.status === "DRAFT" && (
        <p className="rounded-xl bg-warn-soft p-3 text-sm text-warn">
          {plan.withdrawnNote}
        </p>
      )}

      <EtaControls order={order} />
      <Explain order={order} />
      {children}

      {open && (
        <footer className="flex flex-wrap gap-3 border-t border-line pt-5">
          {order.status === "DRAFT" && (
            <Button
              tone="primary"
              className="min-h-11 flex-1 text-sm"
              disabled={busy || plan.risk === "no_plan"}
              onClick={() =>
                act(
                  "issue",
                  {},
                  `Order #${order.number} released to the kitchen.`,
                )
              }
            >
              Release to kitchen
            </Button>
          )}
          <a
            href={`/print/${order.id}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-14 items-center justify-center gap-2 rounded-xl border border-line bg-panel px-3.5 text-sm font-semibold hover:bg-raised"
          >
            <Printer size={16} aria-hidden="true" /> Print
            {order.printed.count ? ` (printed ${order.printed.count}×)` : ""}
          </a>
          {order.status === "RELEASED" && order.phase === "cooking" && (
            <Button disabled={busy} onClick={() => setWithdrawing(true)}>
              <Undo2 size={16} aria-hidden="true" /> Withdraw
            </Button>
          )}
          <Button
            tone="danger"
            disabled={busy}
            onClick={() =>
              act("cancel", { force: false }).then((ok) => ok || undefined)
            }
          >
            Cancel order
          </Button>
        </footer>
      )}

      {withdrawing && (
        <div
          role="group"
          aria-label="Withdraw receipt"
          className="space-y-2 rounded-xl border border-warn bg-warn-soft p-3"
        >
          <p className="text-sm font-semibold text-warn">
            This takes back the items that haven&apos;t started. Tell staff,
            then release the replacement. Work already cooking or done stays as
            recorded.
          </p>
          <input
            className="min-h-14 w-full rounded-xl border border-line bg-panel px-3"
            aria-label="Why is this receipt being withdrawn?"
            placeholder="Why? (shown on the replacement)"
            value={reason}
            maxLength={200}
            onChange={(e) => setReason(e.target.value)}
          />
          <div className="flex gap-2">
            <Button className="flex-1" onClick={() => setWithdrawing(false)}>
              Keep the receipt
            </Button>
            <Button
              tone="danger"
              className="flex-1"
              disabled={!reason.trim() || busy}
              onClick={async () => {
                if (
                  await act(
                    "withdraw",
                    { reason },
                    `Receipt #${order.number} withdrawn. Release the replacement when ready.`,
                  )
                ) {
                  setWithdrawing(false);
                  setReason("");
                }
              }}
            >
              Withdraw
            </Button>
          </div>
        </div>
      )}
    </article>
  );
}
