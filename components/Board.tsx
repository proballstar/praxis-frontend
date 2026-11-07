"use client";
import { useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Bike,
  ChevronDown,
  Play,
  Sparkles,
  Check,
  Package,
} from "lucide-react";
import { Plan, Slot } from "@/lib/engine";
import {
  Action,
  Order,
  Service,
  atTime,
  openOrders,
  overdueMinutes,
  recommendation,
} from "@/lib/service";
import { Button, Pill, clock, plural } from "./ui";

export type Dispatch = (action: Action) => Promise<boolean>;

const MINUTE = 60_000;

function risk(slot: Slot | undefined) {
  if (!slot) return null;
  if (slot.late > 0)
    return <Pill tone="bad">Late by {slot.late} min</Pill>;
  if (slot.driverWait > 0)
    return <Pill tone="warn">Courier waits {slot.driverWait} min</Pill>;
  return <Pill tone="good">On time</Pill>;
}

function courierLine(order: Order, now: number) {
  if (order.courierHereAt !== undefined) {
    const m = Math.floor((now - order.courierHereAt) / MINUTE);
    return m < 1 ? "Courier here" : `Courier waiting ${m} min`;
  }
  const m = Math.round((order.arrival - now) / MINUTE);
  if (m > 0) return `Courier in ${m} min · ${clock(order.arrival)}`;
  if (m === 0) return `Courier due now · ${clock(order.arrival)}`;
  return `Courier due ${-m} min ago · ${clock(order.arrival)}`;
}

function Ticket({
  order,
  badge,
  children,
}: {
  order: Order;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-line bg-panel p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <p className="min-w-0 truncate">
          <b className="text-lg">#{order.ref}</b>
          {order.customer && (
            <span className="ml-2 text-sm text-muted">{order.customer}</span>
          )}
          {order.sample && (
            <span className="ml-2 text-xs font-semibold uppercase text-muted">
              Sample
            </span>
          )}
        </p>
        {badge}
      </div>
      <p className="mt-1 text-sm">{order.items}</p>
      {children}
    </div>
  );
}

function More({
  order,
  dispatch,
  queue,
}: {
  order: Order;
  dispatch: Dispatch;
  queue?: { first: boolean; last: boolean };
}) {
  const [open, setOpen] = useState(false);
  const act = (action: Action) => dispatch(action);
  return (
    <div className="mt-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="-ml-1 inline-flex min-h-9 items-center gap-1 rounded px-1 text-xs font-semibold text-muted"
      >
        Problem or change
        <ChevronDown size={14} className={open ? "rotate-180" : ""} />
      </button>
      {open && (
        <div className="mt-1 space-y-2">
          {order.status !== "ready" && (
            <Row label="Taking longer">
              {[2, 5, 10].map((m) => (
                <Button
                  key={m}
                  className="flex-1"
                  aria-label={`Add ${m} minutes to #${order.ref}`}
                  onClick={() =>
                    act({ type: "addTime", id: order.id, minutes: m })
                  }
                >
                  +{m}
                </Button>
              ))}
            </Row>
          )}
          <Row label="Courier arrives in">
            {[5, 10, 20].map((m) => (
              <Button
                key={m}
                className="flex-1"
                aria-label={`Courier for #${order.ref} arrives in ${m} minutes`}
                onClick={() =>
                  act({ type: "courierEta", id: order.id, minutes: m })
                }
              >
                {m}
              </Button>
            ))}
          </Row>
          <div className="flex flex-wrap gap-2">
            {order.courierHereAt === undefined && (
              <Button
                className="flex-1"
                onClick={() => act({ type: "courierHere", id: order.id })}
              >
                <Bike size={16} /> Courier here
              </Button>
            )}
            {queue && (
              <>
                <Button
                  aria-label={`Move #${order.ref} earlier`}
                  disabled={queue.first}
                  onClick={() =>
                    act({ type: "move", id: order.id, direction: -1 })
                  }
                >
                  <ArrowUp size={16} />
                </Button>
                <Button
                  aria-label={`Move #${order.ref} later`}
                  disabled={queue.last}
                  onClick={() =>
                    act({ type: "move", id: order.id, direction: 1 })
                  }
                >
                  <ArrowDown size={16} />
                </Button>
              </>
            )}
            <Button
              tone="danger"
              onClick={() => act({ type: "cancel", id: order.id })}
            >
              Cancel order
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-20 shrink-0 text-xs text-muted">{label}</span>
      {children}
    </div>
  );
}

function CookingCard({
  order,
  slot,
  now,
  dispatch,
}: {
  order: Order;
  slot?: Slot;
  now: number;
  dispatch: Dispatch;
}) {
  const total = (order.prep + order.extra) * MINUTE;
  const elapsed = now - order.startedAt!;
  const left = total - elapsed;
  const over = overdueMinutes(order, now);
  const seconds = Math.max(0, Math.ceil(left / 1000));
  return (
    <Ticket order={order} badge={risk(slot)}>
      <div className="mt-3 flex items-baseline justify-between">
        <span
          className={`text-2xl font-bold ${left < 0 ? "text-bad" : ""}`}
          role="timer"
        >
          {left < 0
            ? `${over || "<1"} min over`
            : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`}
        </span>
        <span className="text-xs text-muted">
          {order.extra > 0
            ? `includes ${order.extra} min added`
            : `${order.prep} min estimate`}
        </span>
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-raised">
        <div
          className={`h-full rounded-full ${left < 0 ? "bg-bad" : "bg-brand"}`}
          style={{ width: `${Math.min(100, (elapsed / total) * 100)}%` }}
        />
      </div>
      <p className="mt-2 text-xs text-muted">{courierLine(order, now)}</p>
      <Button
        tone="primary"
        className="mt-3 w-full"
        aria-label={`Mark #${order.ref} ready`}
        onClick={() => dispatch({ type: "ready", id: order.id })}
      >
        <Check size={18} /> Ready
      </Button>
      <More order={order} dispatch={dispatch} />
    </Ticket>
  );
}

function QueueCard({
  order,
  slot,
  now,
  position,
  count,
  stationFree,
  dispatch,
}: {
  order: Order;
  slot: Slot;
  now: number;
  position: number;
  count: number;
  stationFree: boolean;
  dispatch: Dispatch;
}) {
  const startsAt = atTime(now, slot.start);
  const next = position === 0 && stationFree && !slot.held;
  return (
    <Ticket order={order} badge={risk(slot)}>
      <p className="mt-2 text-xs text-muted">{courierLine(order, now)}</p>
      <p className="mt-0.5 text-xs text-muted">
        {order.prep + order.extra} min prep · ready {clock(atTime(now, slot.end))}
      </p>
      <Button
        tone={next ? "primary" : "plain"}
        className="mt-3 w-full"
        disabled={!stationFree}
        aria-label={`Start #${order.ref}`}
        onClick={() => dispatch({ type: "start", id: order.id })}
      >
        <Play size={16} />
        {!stationFree
          ? `Stations full · about ${clock(startsAt)}`
          : slot.held
            ? `Hold until ${clock(startsAt)}, or start now`
            : slot.start > 0
              ? `Start about ${clock(startsAt)}`
              : "Start now"}
      </Button>
      <More
        order={order}
        dispatch={dispatch}
        queue={{ first: position === 0, last: position === count - 1 }}
      />
    </Ticket>
  );
}

function ReadyCard({
  order,
  now,
  dispatch,
}: {
  order: Order;
  now: number;
  dispatch: Dispatch;
}) {
  const sitting = Math.floor((now - order.readyAt!) / MINUTE);
  return (
    <Ticket
      order={order}
      badge={
        <Pill tone={sitting >= 10 ? "warn" : "quiet"}>
          {sitting < 1 ? "Just ready" : `Waiting ${sitting} min`}
        </Pill>
      }
    >
      <p className="mt-2 text-xs text-muted">{courierLine(order, now)}</p>
      <Button
        tone="primary"
        className="mt-3 w-full"
        aria-label={`Hand off #${order.ref}`}
        onClick={() => dispatch({ type: "pickedUp", id: order.id })}
      >
        <Package size={16} /> Picked up
      </Button>
      <More order={order} dispatch={dispatch} />
    </Ticket>
  );
}

function Column({
  title,
  active,
  children,
}: {
  title: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className={`min-w-0 space-y-3 ${active ? "" : "hidden lg:block"}`}
    >
      <h2 className="hidden text-sm font-bold text-muted lg:block">{title}</h2>
      {children}
    </section>
  );
}

const Empty = ({ children }: { children: React.ReactNode }) => (
  <p className="rounded-xl border border-dashed border-line p-5 text-center text-sm text-muted">
    {children}
  </p>
);

/** The change the kitchen actually has to make: what jumps ahead of what. */
export function firstMove(p: Plan, ref: (id: string) => string) {
  const at = p.best.sequence.findIndex((id, i) => id !== p.current.sequence[i]);
  return `Cook ${ref(p.best.sequence[at])} before ${ref(p.current.sequence[at])}`;
}

export function savings(p: Plan) {
  const a = p.current.metrics;
  const b = p.best.metrics;
  const parts = [
    a.wait > b.wait && `${a.wait - b.wait} min of courier waiting`,
    a.lateness > b.lateness && `${a.lateness - b.lateness} min of lateness`,
  ].filter(Boolean);
  return parts.join(" and ");
}

export function Board({
  service,
  plan,
  now,
  dispatch,
  onReview,
  onNewOrder,
}: {
  service: Service;
  plan: Plan;
  now: number;
  dispatch: Dispatch;
  onReview: () => void;
  onNewOrder: () => void;
}) {
  const [tab, setTab] = useState<"cooking" | "queue" | "ready">("queue");
  const orders = useMemo(
    () => new Map(service.orders.map((o) => [o.id, o])),
    [service.orders],
  );
  const ref = (id: string) => `#${orders.get(id)?.ref}`;
  const slot = (id: string) => plan.current.slots.find((s) => s.id === id);

  const open = openOrders(service);
  const cooking = open.filter((o) => o.status === "cooking");
  const ready = open.filter((o) => o.status === "ready");
  const stations = Array.from({ length: service.stations }, (_, i) => i + 1);
  const stationFree = cooking.length < service.stations;
  const samples = open.some((o) => o.sample);
  const counts = {
    cooking: cooking.length,
    queue: service.queue.length,
    ready: ready.length,
  };

  if (!open.length)
    return (
      <div className="mx-auto mt-16 max-w-sm px-4 text-center">
        <h2 className="text-xl font-bold">The board is clear</h2>
        <p className="mt-2 text-sm text-muted">
          Add orders as they come in. Praxis will work out what to cook next.
        </p>
        <Button tone="primary" className="mt-5 w-full" onClick={onNewOrder}>
          Add the first order
        </Button>
        <Button
          className="mt-2 w-full"
          onClick={() => dispatch({ type: "loadSample" })}
        >
          Try it with sample orders
        </Button>
      </div>
    );

  return (
    <div className="mx-auto max-w-7xl px-3 pb-10 sm:px-5">
      {samples && (
        <div className="mb-3 flex items-center justify-between gap-3 text-sm text-muted">
          <span>Sample orders are on the board and won’t count in reports.</span>
          <button
            type="button"
            className="min-h-9 shrink-0 font-semibold underline"
            onClick={() => dispatch({ type: "clearSample" })}
          >
            Clear samples
          </button>
        </div>
      )}

      {recommendation(service, plan, now) && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-brand bg-soft p-3.5">
          <Sparkles size={20} className="shrink-0 text-brand" />
          <div className="min-w-48 flex-1">
            <p className="font-bold">{firstMove(plan, ref)}</p>
            <p className="text-sm text-muted">Saves {savings(plan)}.</p>
          </div>
          <div className="flex w-full gap-2 sm:w-auto">
            <Button
              className="flex-1"
              onClick={() =>
                dispatch({ type: "dismissPlan", sequence: plan.best.sequence })
              }
            >
              Keep my order
            </Button>
            <Button tone="primary" className="flex-1" onClick={onReview}>
              Review change
            </Button>
          </div>
        </div>
      )}

      <div
        role="tablist"
        className="mb-3 grid grid-cols-3 gap-1 rounded-xl bg-raised p-1 lg:hidden"
      >
        {(
          [
            ["cooking", "Cooking"],
            ["queue", "Up next"],
            ["ready", "Ready"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={`min-h-11 rounded-lg text-sm font-semibold ${tab === id ? "bg-panel text-ink shadow-sm" : "text-muted"}`}
          >
            {label} ({counts[id]})
          </button>
        ))}
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Column title={`Cooking (${counts.cooking}/${service.stations})`} active={tab === "cooking"}>
          {stations.map((n) => {
            const order = cooking.find((o) => o.station === n);
            return order ? (
              <div key={n}>
                <p className="mb-1 text-xs font-semibold text-muted">
                  Station {n}
                </p>
                <CookingCard
                  order={order}
                  slot={slot(order.id)}
                  now={now}
                  dispatch={dispatch}
                />
              </div>
            ) : (
              <Empty key={n}>Station {n} is free</Empty>
            );
          })}
        </Column>

        <Column title={`Up next (${counts.queue})`} active={tab === "queue"}>
          {service.queue.map((id, i) => {
            const order = orders.get(id);
            const s = slot(id);
            if (!order || !s) return null;
            return (
              <QueueCard
                key={id}
                order={order}
                slot={s}
                now={now}
                position={i}
                count={service.queue.length}
                stationFree={stationFree}
                dispatch={dispatch}
              />
            );
          })}
          {!service.queue.length && <Empty>Nothing waiting to start</Empty>}
        </Column>

        <Column title={`Ready for pickup (${counts.ready})`} active={tab === "ready"}>
          {ready.map((order) => (
            <ReadyCard
              key={order.id}
              order={order}
              now={now}
              dispatch={dispatch}
            />
          ))}
          {!ready.length && <Empty>Nothing waiting for a courier</Empty>}
        </Column>
      </div>
    </div>
  );
}

export function ReviewPlan({
  service,
  plan,
  now,
  changed,
  onAcknowledge,
  onApply,
}: {
  service: Service;
  plan: Plan;
  now: number;
  /** The board changed after this sheet was opened. */
  changed: boolean;
  onAcknowledge: () => void;
  onApply: () => void;
}) {
  const orders = new Map(service.orders.map((o) => [o.id, o]));
  const a = plan.current.metrics;
  const b = plan.best.metrics;
  const rows = [
    ["Courier waiting", `${a.wait} min`, `${b.wait} min`],
    ["Late pickups", `${a.late}`, `${b.late}`],
    ["Total lateness", `${a.lateness} min`, `${b.lateness} min`],
  ];
  const unchanged = plan.best.slots.filter((s) =>
    service.orders.some((o) => o.id === s.id && o.status === "cooking"),
  ).length;
  return (
    <div className="space-y-5">
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted">
          <tr>
            <th className="pb-2 font-semibold">Projected</th>
            <th className="pb-2 font-semibold">Your order</th>
            <th className="pb-2 font-semibold">Recommended</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, before, after]) => (
            <tr key={label} className="border-t border-line">
              <td className="py-2">{label}</td>
              <td className="py-2">{before}</td>
              <td className="py-2 font-bold">{after}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div>
        <h3 className="mb-2 text-sm font-bold">New cooking order</h3>
        <ol className="space-y-1.5">
          {plan.best.sequence.map((id, i) => {
            const order = orders.get(id)!;
            const after = plan.best.slots.find((s) => s.id === id)!;
            const before = plan.current.slots.find((s) => s.id === id)!;
            return (
              <li
                key={id}
                className="flex items-center justify-between gap-3 rounded-lg bg-raised px-3 py-2 text-sm"
              >
                <span>
                  {i + 1}. <b>#{order.ref}</b>
                </span>
                <span className="text-muted">
                  ready {clock(atTime(now, before.end))} →{" "}
                  <b className="text-ink">{clock(atTime(now, after.end))}</b>
                </span>
              </li>
            );
          })}
        </ol>
      </div>
      {b.late > 0 && (
        <p className="rounded-lg bg-warn-soft p-3 text-sm text-warn">
          {plural(b.late, "order")} will still miss the pickup window. This is
          the best order found, but it can’t win back time already lost.
        </p>
      )}
      <p className="text-xs text-muted">
        {unchanged > 0 &&
          `${plural(unchanged, "order")} already cooking won’t be touched. `}
        Compared {plan.examined.toLocaleString()} possible orders
        {plan.method === "exact"
          ? ", which is every option."
          : "; with a queue this long, it’s the best found, not every option."}
      </p>
      {changed ? (
        <div className="space-y-2 rounded-lg bg-warn-soft p-3">
          <p className="text-sm text-warn">
            The board changed while you were reviewing. The numbers above are
            updated. Check them before applying.
          </p>
          <Button className="w-full" onClick={onAcknowledge}>
            I’ve checked the new numbers
          </Button>
        </div>
      ) : (
        <Button tone="primary" className="w-full" onClick={onApply}>
          Apply new order
        </Button>
      )}
    </div>
  );
}
