"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BarChart3,
  MessageCircleQuestion,
  Plus,
  Settings,
  Undo2,
  WifiOff,
} from "lucide-react";
import { Board, ReviewPlan } from "@/components/Board";
import { AskPraxis, ShiftReportView } from "@/components/Extras";
import { KitchenForm } from "@/components/KitchenForm";
import { NewOrderForm } from "@/components/NewOrder";
import { Button, Sheet, clock, plural } from "@/components/ui";
import {
  Action,
  KitchenSettings,
  NewOrder,
  Service,
  openOrders,
  planFor,
} from "@/lib/service";

const POLL_MS = 2500;
const REPLAN_MS = 15_000;

function useService(onError: (message: string) => void) {
  const [service, setService] = useState<Service | null>(null);
  const [offset, setOffset] = useState(0);
  const [online, setOnline] = useState(true);
  const [failure, setFailure] = useState("");
  const rev = useRef(-1);

  const accept = useCallback(
    (body: { service: Service; serverNow: number }) => {
      if (body.service.rev < rev.current) return;
      rev.current = body.service.rev;
      setService(body.service);
      setOffset(body.serverNow - Date.now());
    },
    [],
  );

  const sync = useCallback(async () => {
    try {
      const response = await fetch("/api/service", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) {
        setFailure(body.error);
        return;
      }
      accept(body);
      setFailure("");
      setOnline(true);
    } catch {
      setOnline(false);
    }
  }, [accept]);

  useEffect(() => {
    sync();
    const timer = setInterval(sync, POLL_MS);
    const wake = () => document.visibilityState === "visible" && sync();
    document.addEventListener("visibilitychange", wake);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [sync]);

  const dispatch = useCallback(
    async (action: Action) => {
      try {
        const response = await fetch("/api/service", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        });
        const body = await response.json();
        if (!response.ok) {
          onError(body.error);
          sync();
          return false;
        }
        accept(body);
        return true;
      } catch {
        setOnline(false);
        onError("Not saved. Check the connection and tap again.");
        return false;
      }
    },
    [accept, onError, sync],
  );

  return { service, offset, online, failure, dispatch };
}

function Setup({ onSubmit, initial }: { onSubmit: (s: KitchenSettings) => Promise<unknown>; initial: Service }) {
  return (
    <main className="mx-auto max-w-xl px-4 py-8">
      <p className="text-sm font-bold text-brand">Praxis</p>
      <h1 className="mt-1 text-2xl font-bold">Set up your kitchen</h1>
      <p className="mt-2 mb-6 text-sm text-muted">
        Tell Praxis what you cook and how many orders you can work on at once.
        You can change all of this later.
      </p>
      <KitchenForm
        initial={initial}
        submitLabel="Open the board"
        onSubmit={onSubmit}
      />
    </main>
  );
}

type SheetName = "order" | "review" | "ask" | "report" | "settings" | null;

export default function Home() {
  const [notice, setNotice] = useState("");
  const showError = useCallback((message: string) => setNotice(message), []);
  const { service, offset, online, failure, dispatch } = useService(showError);
  const [sheet, setSheet] = useState<SheetName>(null);
  const [tick, setTick] = useState(() => Date.now());
  const closeSheet = useCallback(() => setSheet(null), []);

  useEffect(() => {
    const timer = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  const now = tick + offset;
  const planningMoment = Math.floor(now / REPLAN_MS) * REPLAN_MS;
  const plan = useMemo(
    () => (service?.configured ? planFor(service, planningMoment) : null),
    [service, planningMoment],
  );

  if (failure)
    return (
      <main className="mx-auto mt-24 max-w-md px-6 text-center">
        <h1 className="text-xl font-bold">Praxis can’t open this kitchen</h1>
        <p className="mt-2 text-sm text-muted">
          {failure} Nothing has been overwritten. Check the saved file on the
          computer running Praxis, then reload.
        </p>
      </main>
    );
  if (!service)
    return (
      <p className="mt-24 text-center text-sm text-muted" role="status">
        {online
          ? "Opening the board…"
          : "Can’t reach Praxis. Check that this device is on the same network."}
      </p>
    );
  if (!service.configured || !plan)
    return (
      <>
        <Setup
          initial={service}
          onSubmit={(settings) => dispatch({ type: "configure", settings })}
        />
        {notice && <Notice message={notice} />}
      </>
    );

  const open = openOrders(service);
  const lateSoon = plan.current.slots.filter((s) => s.late > 0).length;
  const settings: KitchenSettings = {
    name: service.name,
    stations: service.stations,
    graceMinutes: service.graceMinutes,
    packMinutes: service.packMinutes,
    menu: service.menu,
  };

  async function addOrder(order: NewOrder) {
    const saved = await dispatch({ type: "addOrder", order });
    if (saved) setSheet(null);
    return saved;
  }

  return (
    <main className="min-h-dvh">
      <header className="sticky top-0 z-30 mb-4 border-b border-line bg-bg/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 sm:px-5">
          <div className="w-full min-w-0 sm:w-auto sm:flex-1">
            <h1 className="truncate font-bold">{service.name}</h1>
            <p className="truncate text-xs text-muted">
              <time>{clock(now)}</time> · {plural(open.length, "open order")}
              {lateSoon > 0 && (
                <b className="text-bad"> · {lateSoon} running late</b>
              )}
            </p>
          </div>
          <div className="flex w-full items-center gap-1 sm:w-auto">
            <IconButton
              label={service.undo[0] ? `Undo: ${service.undo[0].label}` : "Nothing to undo"}
              disabled={!service.undo.length}
              onClick={() => dispatch({ type: "undo" })}
            >
              <Undo2 size={19} />
            </IconButton>
            <IconButton label="Ask Praxis" onClick={() => setSheet("ask")}>
              <MessageCircleQuestion size={19} />
            </IconButton>
            <IconButton label="Shift report" onClick={() => setSheet("report")}>
              <BarChart3 size={19} />
            </IconButton>
            <IconButton label="Settings" onClick={() => setSheet("settings")}>
              <Settings size={19} />
            </IconButton>
            <Button
              tone="primary"
              className="ml-auto sm:ml-1"
              onClick={() => setSheet("order")}
            >
              <Plus size={17} /> New order
            </Button>
          </div>
        </div>
        {!online && (
          <p className="flex items-center justify-center gap-2 bg-warn-soft px-3 py-1.5 text-sm font-semibold text-warn">
            <WifiOff size={15} /> Connection lost. This board may be out of date.
          </p>
        )}
      </header>

      <Board
        service={service}
        plan={plan}
        now={now}
        dispatch={dispatch}
        onReview={() => setSheet("review")}
        onNewOrder={() => setSheet("order")}
      />

      {sheet === "order" && (
        <Sheet title="New order" onClose={closeSheet}>
          <NewOrderForm menu={service.menu} onSubmit={addOrder} />
        </Sheet>
      )}
      {sheet === "review" && (
        <Sheet title="Review new cooking order" onClose={closeSheet}>
          <ReviewPlan
            service={service}
            plan={plan}
            now={planningMoment}
            onApply={async () => {
              await dispatch({
                type: "applyPlan",
                sequence: plan.best.sequence,
                baseRev: service.rev,
              });
              setSheet(null);
            }}
          />
        </Sheet>
      )}
      {sheet === "ask" && (
        <Sheet title="Ask Praxis" onClose={closeSheet}>
          <AskPraxis dispatch={dispatch} />
        </Sheet>
      )}
      {sheet === "report" && (
        <Sheet title="This shift" onClose={closeSheet}>
          <ShiftReportView
            service={service}
            dispatch={dispatch}
            onClose={closeSheet}
          />
        </Sheet>
      )}
      {sheet === "settings" && (
        <Sheet title="Settings" onClose={closeSheet}>
          <KitchenForm
            initial={settings}
            submitLabel="Save"
            onSubmit={async (next) => {
              if (await dispatch({ type: "configure", settings: next }))
                setSheet(null);
            }}
          />
        </Sheet>
      )}
      {notice && <Notice message={notice} />}
    </main>
  );
}

function IconButton({
  label,
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...props}
      className="grid size-11 place-items-center rounded-lg text-muted hover:bg-raised disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function Notice({ message }: { message: string }) {
  return (
    <p
      role="alert"
      className="fixed inset-x-3 bottom-4 z-50 mx-auto max-w-md rounded-lg bg-ink px-4 py-3 text-center text-sm font-semibold text-bg shadow-lg"
    >
      {message}
    </p>
  );
}
