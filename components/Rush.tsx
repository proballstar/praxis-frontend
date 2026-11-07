"use client";
import { useMemo, useState } from "react";
import { Simulation, Change, simulate } from "@/lib/changes";
import { Metrics } from "@/lib/engine";
import { Service, ServiceError, openOrders } from "@/lib/service";
import { Dispatch } from "./Board";
import { Button, plural } from "./ui";

type Kind = "courier" | "time" | "resource";

const KINDS: [Kind, string][] = [
  ["courier", "Courier early or late"],
  ["time", "Order needs more time"],
  ["resource", "Equipment down"],
];

const MINUTES: Record<Kind, number[]> = {
  courier: [0, 5, 10, 15, 20, 30],
  time: [2, 5, 8, 10, 15],
  resource: [10, 15, 20, 30, 45],
};

function Choice({
  selected,
  onClick,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={`min-h-11 min-w-12 rounded-lg border px-3 text-sm font-semibold ${selected ? "border-brand bg-brand text-on-brand" : "border-line bg-raised"}`}
    >
      {children}
    </button>
  );
}

function Totals({
  before,
  after,
  afterLabel,
}: {
  before: Metrics;
  after: Metrics;
  afterLabel: string;
}) {
  const rows: [string, number, number][] = [
    ["Courier waiting", before.wait, after.wait],
    ["Food sitting", before.idle, after.idle],
    ["Total lateness", before.lateness, after.lateness],
    ["Past quality window", before.quality, after.quality],
  ];
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-xs text-muted">
        <tr>
          <th className="pb-1 font-semibold">Predicted</th>
          <th className="pb-1 font-semibold">Now</th>
          <th className="pb-1 font-semibold">{afterLabel}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([label, x, y]) => (
          <tr key={label} className="border-t border-line">
            <td className="py-1.5">{label}</td>
            <td className="py-1.5">{x} min</td>
            <td className="py-1.5 font-bold">{y} min</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function RushRecovery({
  service,
  now,
  dispatch,
  onClose,
}: {
  service: Service;
  now: number;
  dispatch: Dispatch;
  onClose: () => void;
}) {
  const orders = openOrders(service);
  const [kind, setKind] = useState<Kind>("courier");
  const [ticket, setTicket] = useState(orders[0]?.ref ?? "");
  const [resource, setResource] = useState(service.resources[0]?.name ?? "");
  const [units, setUnits] = useState(1);
  const [minutes, setMinutes] = useState(10);
  const [busy, setBusy] = useState(false);

  const capacity =
    service.resources.find((r) => r.name === resource)?.capacity ?? 1;

  const change = useMemo((): Change => {
    if (kind === "courier")
      return { kind: "courier_eta", ticket, minutes };
    if (kind === "time") return { kind: "add_time", ticket, minutes };
    return {
      kind: "resource_down",
      resource,
      units: Math.min(units, capacity),
      minutes,
    };
  }, [kind, ticket, minutes, resource, units, capacity]);

  const result = useMemo((): Simulation | string => {
    try {
      return simulate(service, now, [change]);
    } catch (error) {
      if (error instanceof ServiceError) return error.message;
      throw error;
    }
  }, [service, now, change]);

  const needsOrder = kind !== "resource";
  const cookable = orders.filter(
    (o) =>
      kind !== "time" ||
      (o.status !== "ready" && o.items.some((i) => i.status !== "done")),
  );

  async function approve(actions: Simulation["actions"]) {
    if (typeof result === "string") return;
    setBusy(true);
    const saved = await dispatch({
      type: "batch",
      label: "rush recovery",
      baseRev: result.baseRev,
      actions,
    });
    setBusy(false);
    if (saved) onClose();
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        Try a change here first. The live board stays as it is until you
        approve.
      </p>
      <div className="flex flex-wrap gap-2">
        {KINDS.map(([id, label]) => (
          <Choice
            key={id}
            selected={kind === id}
            onClick={() => {
              setKind(id);
              setMinutes(MINUTES[id][2]);
            }}
          >
            {label}
          </Choice>
        ))}
      </div>

      {needsOrder ? (
        <div>
          <p className="mb-1.5 text-sm font-semibold">Which order?</p>
          <div className="flex flex-wrap gap-2">
            {cookable.map((o) => (
              <Choice
                key={o.id}
                selected={ticket === o.ref}
                onClick={() => setTicket(o.ref)}
              >
                #{o.ref}
              </Choice>
            ))}
            {!cookable.length && (
              <p className="text-sm text-muted">No open orders.</p>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div>
            <p className="mb-1.5 text-sm font-semibold">What’s down?</p>
            <div className="flex flex-wrap gap-2">
              {service.resources.map((r) => (
                <Choice
                  key={r.id}
                  selected={resource === r.name}
                  onClick={() => {
                    setResource(r.name);
                    setUnits(1);
                  }}
                >
                  {r.name}
                </Choice>
              ))}
            </div>
          </div>
          {capacity > 1 && (
            <div>
              <p className="mb-1.5 text-sm font-semibold">How many units?</p>
              <div className="flex flex-wrap gap-2">
                {Array.from({ length: capacity }, (_, i) => i + 1).map((n) => (
                  <Choice
                    key={n}
                    selected={units === n}
                    onClick={() => setUnits(n)}
                  >
                    {n} of {capacity}
                  </Choice>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div>
        <p className="mb-1.5 text-sm font-semibold">
          {kind === "courier"
            ? "Courier now arrives in"
            : kind === "time"
              ? "Extra minutes needed"
              : "Out for"}
        </p>
        <div className="flex flex-wrap gap-2">
          {MINUTES[kind].map((m) => (
            <Choice
              key={m}
              selected={minutes === m}
              onClick={() => setMinutes(m)}
            >
              {m === 0 ? "Now" : `${m} min`}
            </Choice>
          ))}
        </div>
      </div>

      {typeof result === "string" ? (
        <p className="rounded-lg bg-warn-soft p-3 text-sm text-warn">{result}</p>
      ) : (
        <div className="space-y-4 border-t border-line pt-4">
          <section aria-label="If you keep the current order">
            <h3 className="text-sm font-bold">Keep the current cooking order</h3>
            <p className="mt-1 mb-2 text-sm">{result.summary}</p>
            <Totals
              before={result.before}
              after={result.after}
              afterLabel="After"
            />
            <Button
              className="mt-2 w-full"
              disabled={busy}
              onClick={() => approve(result.actions)}
            >
              Approve change, keep order
            </Button>
          </section>

          {result.reorder ? (
            <section
              aria-label="If you also reorder"
              className="rounded-lg border border-brand p-3"
            >
              <h3 className="text-sm font-bold">
                Recommended: also cook{" "}
                {result.reorder.sequence.map((r) => `#${r}`).join(" → ")}
              </h3>
              <p className="mt-1 mb-2 text-sm">{result.reorder.summary}</p>
              <Totals
                before={result.after}
                after={result.reorder.after}
                afterLabel="Reordered"
              />
              <p className="mt-2 text-xs text-muted">
                “Now” here means after the change, with your current order.
                Dishes already cooking won’t be touched.
              </p>
              <Button
                tone="primary"
                className="mt-2 w-full"
                disabled={busy}
                onClick={() => approve(result.reorder!.actions)}
              >
                Approve change and reorder
              </Button>
            </section>
          ) : (
            <p className="text-sm text-muted">
              Reordering wouldn’t help enough to be worth changing the line.
            </p>
          )}

          {result.unconfirmed.length > 0 && (
            <p className="rounded-lg bg-warn-soft p-3 text-sm text-warn">
              {plural(result.unconfirmed.length, "courier time")} unconfirmed (
              {result.unconfirmed.map((r) => `#${r}`).join(", ")}). Check before
              relying on these numbers.
            </p>
          )}
          <Button className="w-full" disabled={busy} onClick={onClose}>
            Cancel, keep the current plan
          </Button>
        </div>
      )}
    </div>
  );
}
