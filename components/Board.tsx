"use client";
import { useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Bike,
  Check,
  ChevronDown,
  Package,
  Play,
  Sparkles,
} from "lucide-react";
import { Plan, Slot } from "@/lib/engine";
import { describe, tradeoffBetween } from "@/lib/changes";
import {
  Action,
  Order,
  OrderItem,
  Service,
  atTime,
  capacityNow,
  dueItems,
  etaStatus,
  inUse,
  itemOverdue,
  openOrders,
  recommendation,
} from "@/lib/service";
import { Button, Pill, clock, plural } from "./ui";

export type Dispatch = (action: Action) => Promise<boolean>;

const MINUTE = 60_000;

function risk(slot: Slot | undefined) {
  if (!slot) return null;
  if (slot.late > 0) return <Pill tone="bad">Late by {slot.late} min</Pill>;
  if (slot.driverWait > 0)
    return <Pill tone="warn">Courier waits {slot.driverWait} min</Pill>;
  if (slot.quality > 0)
    return <Pill tone="warn">{slot.quality} min past best</Pill>;
  return <Pill tone="good">On time</Pill>;
}

function courierLine(order: Order, now: number) {
  if (order.courierHereAt !== undefined) {
    const m = Math.floor((now - order.courierHereAt) / MINUTE);
    return m < 1 ? "Courier here" : `Courier waiting ${m} min`;
  }
  if (!order.etaKnown) return "Courier time unknown";
  const m = Math.round((order.arrival - now) / MINUTE);
  if (m > 0) return `Courier in ${m} min · ${clock(order.arrival)}`;
  if (m === 0) return `Courier due now · ${clock(order.arrival)}`;
  return `Courier due ${-m} min ago · ${clock(order.arrival)}`;
}

function EtaWarning({
  service,
  order,
  now,
  dispatch,
}: {
  service: Service;
  order: Order;
  now: number;
  dispatch: Dispatch;
}) {
  const status = etaStatus(service, order, now);
  if (status !== "stale" && status !== "unknown") return null;
  return (
    <div className="mt-2 flex items-center justify-between gap-2 rounded-lg bg-warn-soft px-3 py-2">
      <p className="text-xs font-semibold text-warn">
        {status === "unknown"
          ? "No courier time. Not holding this order."
          : "Courier time may be old. Not holding this order."}
      </p>
      {status === "stale" && (
        <button
          type="button"
          className="min-h-9 shrink-0 text-xs font-bold text-warn underline"
          aria-label={`Confirm courier time for #${order.ref}`}
          onClick={() => dispatch({ type: "confirmEta", id: order.id })}
        >
          Still right
        </button>
      )}
    </div>
  );
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
    <article
      aria-label={`Order ${order.ref}`}
      className="rounded-xl border border-line bg-panel p-3.5"
    >
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
      {children}
    </article>
  );
}

type Group = {
  key: string;
  label: string;
  items: OrderItem[];
  first: OrderItem;
};

function groupItems(order: Order): Group[] {
  const groups = new Map<string, Group>();
  for (const item of order.items) {
    const key = [item.name, item.note, item.status, item.startedAt].join("|");
    const group = groups.get(key);
    if (group) group.items.push(item);
    else
      groups.set(key, {
        key,
        label: item.note ? `${item.name} (${item.note})` : item.name,
        items: [item],
        first: item,
      });
  }
  return [...groups.values()];
}

function DishRow({
  service,
  order,
  group,
  slot,
  now,
  dispatch,
}: {
  service: Service;
  order: Order;
  group: Group;
  slot?: Slot;
  now: number;
  dispatch: Dispatch;
}) {
  const { first, items, label } = group;
  const resource = service.resources.find((r) => r.id === first.resource);
  const qty = items.length;
  const title = `${qty} × ${label}`;
  const ids = items.map((i) => i.id);

  let detail: React.ReactNode = null;
  let action: React.ReactNode = null;
  if (first.status === "pending") {
    const task = slot?.tasks.find((t) => t.id === first.id);
    detail =
      task && task.start > 0
        ? `start ${clock(atTime(now, task.start))}`
        : "start now";
  } else if (first.status === "cooking") {
    const left = first.startedAt! + (first.minutes + first.extra) * MINUTE - now;
    const seconds = Math.max(0, Math.ceil(left / 1000));
    const over = itemOverdue(first, now);
    detail = (
      <span role="timer" className={left < 0 ? "font-bold text-bad" : "font-bold"}>
        {left < 0
          ? `${over || "<1"} min over`
          : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`}
      </span>
    );
    action = (
      <Button
        className="min-h-9! px-2.5!"
        aria-label={`${label} done on #${order.ref}`}
        onClick={() => dispatch({ type: "itemsDone", id: order.id, itemIds: ids })}
      >
        <Check size={15} /> Done
      </Button>
    );
  } else {
    const age = Math.floor((now - first.doneAt!) / MINUTE);
    const left = first.qualityMinutes - age;
    detail =
      left >= 0 ? (
        <span>done · best for {left} more min</span>
      ) : (
        <span className="font-semibold text-warn">
          done · {-left} min past best
        </span>
      );
  }

  return (
    <li className="flex min-h-10 items-center justify-between gap-2 border-t border-line py-1.5 first:border-t-0">
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{title}</p>
        <p className="text-xs text-muted">
          {resource?.name} · {detail}
        </p>
      </div>
      {action}
    </li>
  );
}

function Dishes(props: {
  service: Service;
  order: Order;
  slot?: Slot;
  now: number;
  dispatch: Dispatch;
}) {
  return (
    <ul className="mt-2">
      {groupItems(props.order).map((group) => (
        <DishRow key={group.key} group={group} {...props} />
      ))}
    </ul>
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
  const unfinished = order.items.some((i) => i.status !== "done");
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
          {order.status !== "ready" && unfinished && (
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

/** Starts what the plan wants now, or says plainly why it is waiting. */
function StartButton({
  service,
  order,
  slot,
  now,
  primary,
  dispatch,
}: {
  service: Service;
  order: Order;
  slot?: Slot;
  now: number;
  primary: boolean;
  dispatch: Dispatch;
}) {
  const pending = order.items.filter((i) => i.status === "pending");
  const free = (i: OrderItem) => {
    const r = service.resources.find((x) => x.id === i.resource)!;
    return inUse(service, i.resource) < capacityNow(r, now);
  };
  const due = dueItems(order, slot);
  const startable = due.filter(free);
  const label = `Start #${order.ref}`;
  if (startable.length)
    return (
      <Button
        tone={primary ? "primary" : "plain"}
        className="mt-2 w-full"
        aria-label={label}
        onClick={() =>
          dispatch({
            type: "startItems",
            id: order.id,
            itemIds: startable.map((i) => i.id),
          })
        }
      >
        <Play size={16} /> Start {startable.length}{" "}
        {startable.length === 1 ? "dish" : "dishes"} now
      </Button>
    );
  if (due.length) {
    const waiting = service.resources.find((r) => r.id === due[0].resource);
    return (
      <Button className="mt-2 w-full" disabled aria-label={label}>
        <Play size={16} /> Waiting for {waiting?.name.toLowerCase()}
      </Button>
    );
  }
  if (!pending.length || !slot) return null;
  const next = Math.min(
    ...slot.tasks
      .filter((t) => pending.some((i) => i.id === t.id))
      .map((t) => t.start),
  );
  // Starting early brings forward only the first dishes, so the rest still
  // finish together with them.
  const first = pending.filter(
    (i) => slot.tasks.find((t) => t.id === i.id)?.start === next,
  );
  const early = first.filter(free);
  if (!early.length) {
    const waiting = service.resources.find((r) => r.id === first[0]?.resource);
    return (
      <Button className="mt-2 w-full" disabled aria-label={label}>
        <Play size={16} /> Waiting for {waiting?.name.toLowerCase()} · about{" "}
        {clock(atTime(now, next))}
      </Button>
    );
  }
  return (
    <Button
      className="mt-2 w-full"
      aria-label={label}
      onClick={() =>
        dispatch({
          type: "startItems",
          id: order.id,
          itemIds: early.map((i) => i.id),
        })
      }
    >
      <Play size={16} />
      {slot.held
        ? `Hold until ${clock(atTime(now, next))}, or start now`
        : `Start about ${clock(atTime(now, next))}, or now`}
    </Button>
  );
}

function CookingCard({
  service,
  order,
  slot,
  now,
  dispatch,
}: {
  service: Service;
  order: Order;
  slot?: Slot;
  now: number;
  dispatch: Dispatch;
}) {
  const pending = order.items.some((i) => i.status === "pending");
  return (
    <Ticket order={order} badge={risk(slot)}>
      <Dishes
        service={service}
        order={order}
        slot={slot}
        now={now}
        dispatch={dispatch}
      />
      <p className="mt-1 text-xs text-muted">
        {courierLine(order, now)}
        {slot && ` · ready ${clock(atTime(now, slot.ready))}`}
      </p>
      <EtaWarning service={service} order={order} now={now} dispatch={dispatch} />
      {pending ? (
        <StartButton
          service={service}
          order={order}
          slot={slot}
          now={now}
          primary
          dispatch={dispatch}
        />
      ) : (
        <Button
          tone="primary"
          className="mt-2 w-full"
          aria-label={`Mark #${order.ref} ready`}
          onClick={() => dispatch({ type: "ready", id: order.id })}
        >
          <Check size={18} /> Packed and ready
        </Button>
      )}
      <More order={order} dispatch={dispatch} />
    </Ticket>
  );
}

function QueueCard({
  service,
  order,
  slot,
  now,
  position,
  count,
  dispatch,
}: {
  service: Service;
  order: Order;
  slot: Slot;
  now: number;
  position: number;
  count: number;
  dispatch: Dispatch;
}) {
  const before = slot.ready - slot.start;
  return (
    <Ticket order={order} badge={risk(slot)}>
      <Dishes
        service={service}
        order={order}
        slot={slot}
        now={now}
        dispatch={dispatch}
      />
      <p className="mt-1 text-xs text-muted">{courierLine(order, now)}</p>
      <p className="mt-0.5 text-xs text-muted">
        Start cooking {clock(atTime(now, slot.start))}, {before} min before
        pickup-ready at {clock(atTime(now, slot.ready))}
      </p>
      <EtaWarning service={service} order={order} now={now} dispatch={dispatch} />
      <StartButton
        service={service}
        order={order}
        slot={slot}
        now={now}
        primary={position === 0}
        dispatch={dispatch}
      />
      <More
        order={order}
        dispatch={dispatch}
        queue={{ first: position === 0, last: position === count - 1 }}
      />
    </Ticket>
  );
}

function ReadyCard({
  service,
  order,
  now,
  dispatch,
}: {
  service: Service;
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
      <Dishes service={service} order={order} now={now} dispatch={dispatch} />
      <p className="mt-1 text-xs text-muted">{courierLine(order, now)}</p>
      <EtaWarning service={service} order={order} now={now} dispatch={dispatch} />
      <Button
        tone="primary"
        className="mt-2 w-full"
        aria-label={`Hand off #${order.ref}`}
        onClick={() => dispatch({ type: "pickedUp", id: order.id })}
      >
        <Package size={16} /> Picked up
      </Button>
      <More order={order} dispatch={dispatch} />
    </Ticket>
  );
}

function ResourceStrip({ service, now }: { service: Service; now: number }) {
  return (
    <div className="mb-3 flex flex-wrap gap-2" aria-label="Kitchen resources">
      {service.resources.map((r) => {
        const capacity = capacityNow(r, now);
        const used = inUse(service, r.id);
        const out = r.down && now < r.down.until;
        return (
          <span
            key={r.id}
            className={`rounded-full px-3 py-1 text-xs font-semibold ${
              out
                ? "bg-bad-soft text-bad"
                : used >= capacity
                  ? "bg-warn-soft text-warn"
                  : "bg-raised text-muted"
            }`}
          >
            {r.name} {used}/{capacity}
            {out &&
              ` · ${r.down!.units} out ${Math.ceil((r.down!.until - now) / MINUTE)} min`}
          </span>
        );
      })}
    </div>
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
    a.quality > b.quality && `${a.quality - b.quality} min past quality windows`,
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

      <ResourceStrip service={service} now={now} />

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
        <Column title={`Cooking (${counts.cooking})`} active={tab === "cooking"}>
          {cooking.map((order) => (
            <CookingCard
              key={order.id}
              service={service}
              order={order}
              slot={slot(order.id)}
              now={now}
              dispatch={dispatch}
            />
          ))}
          {!cooking.length && <Empty>Nothing cooking right now</Empty>}
        </Column>

        <Column title={`Up next (${counts.queue})`} active={tab === "queue"}>
          {service.queue.map((id, i) => {
            const order = orders.get(id);
            const s = slot(id);
            if (!order || !s) return null;
            return (
              <QueueCard
                key={id}
                service={service}
                order={order}
                slot={s}
                now={now}
                position={i}
                count={service.queue.length}
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
              service={service}
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
    ["Food sitting", `${a.idle} min`, `${b.idle} min`],
    ["Late pickups", `${a.late}`, `${b.late}`],
    ["Total lateness", `${a.lateness} min`, `${b.lateness} min`],
    ["Past quality window", `${a.quality} min`, `${b.quality} min`],
  ];
  const summary = describe(a, b, tradeoffBetween(service, plan.current, plan.best));
  const untouched = service.orders.filter((o) => o.status === "cooking").length;
  return (
    <div className="space-y-5">
      <p className="rounded-lg bg-raised p-3 text-sm">{summary}</p>
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted">
          <tr>
            <th className="pb-2 font-semibold">Predicted</th>
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
                  ready {clock(atTime(now, before.ready))} →{" "}
                  <b className="text-ink">{clock(atTime(now, after.ready))}</b>
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
        {untouched > 0 &&
          `${plural(untouched, "order")} already cooking won’t be touched. `}
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
