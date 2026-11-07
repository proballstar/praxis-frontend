"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { BarChart3, LifeBuoy, MessageCircleQuestion, Plus, Settings, WifiOff } from "lucide-react";
import { Button, Sheet } from "@/components/ui";
import { KitchenProvider, useKitchen } from "@/components/tk/kitchen";
import { Clock } from "@/components/tk/Clock";
import { OrdersView } from "@/components/tk/OrdersView";
import { StationsView } from "@/components/tk/StationsView";
import { PackingView } from "@/components/tk/PackingView";
import { PickupView } from "@/components/tk/PickupView";
import { NewOrderSheet } from "@/components/tk/NewOrderSheet";
import { RushRecovery } from "@/components/tk/RushRecovery";
import { Assistant } from "@/components/tk/Assistant";
import { ShiftReport } from "@/components/tk/Report";
import { SettingsForm } from "@/components/tk/SettingsForm";
import type { Config } from "@/lib/tk/types";

type View = "orders" | "stations" | "packing" | "pickup";
type SheetName = "order" | "rush" | "ask" | "report" | "settings" | null;
const VIEWS: View[] = ["orders", "stations", "packing", "pickup"];

function IconButton({ label, children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button type="button" aria-label={label} title={label} {...props} className="grid size-14 shrink-0 place-items-center rounded-xl border border-line bg-panel text-ink hover:bg-raised disabled:opacity-40">
      {children}
    </button>
  );
}

function Notice() {
  const { notice } = useKitchen();
  if (!notice) return null;
  return (
    <p role="alert" className="fixed inset-x-3 bottom-4 z-50 mx-auto max-w-md rounded-lg bg-ink px-4 py-3 text-center text-sm font-semibold text-bg shadow-lg">
      {notice}
    </p>
  );
}

function Setup() {
  const { snap, call } = useKitchen();
  if (!snap) return null;
  return (
    <main className="mx-auto max-w-xl px-4 py-8">
      <p className="text-sm font-bold text-brand">Praxis</p>
      <h1 className="mt-1 text-2xl font-bold">Set up your kitchen</h1>
      <p className="mt-2 mb-6 text-sm text-muted">
        Tell Praxis your stations, how much equipment and staff you have, and your menu. Starter values are filled in so you can try it right away. They&apos;re demo
        assumptions, not verified settings for a real kitchen.
      </p>
      <SettingsForm
        initial={snap.config}
        submitLabel="Open the board"
        onSubmit={async (config: Config) => {
          const r = await call("/api/settings", { config });
          return r.ok ? null : (r.error ?? "Couldn't save the settings.");
        }}
      />
    </main>
  );
}

function Shell() {
  const { snap, online, failure, call, toast } = useKitchen();
  const [view, setView] = useState<View>("orders");
  const [sheet, setSheet] = useState<SheetName>(null);
  const closeSheet = useCallback(() => setSheet(null), []);

  // Each view has its own address, so a tablet can be bookmarked to its station or the pass.
  useEffect(() => {
    const read = () => {
      const h = location.hash.slice(1) as View;
      if (VIEWS.includes(h)) setView(h);
    };
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  const go = (v: View) => {
    setView(v);
    history.replaceState(null, "", `#${v}`);
  };

  const counts = useMemo(() => {
    const o = snap?.orders ?? [];
    return {
      orders: o.filter((x) => x.status === "DRAFT" || x.status === "RELEASED").length,
      stations: (snap?.stations ?? []).reduce((n, s) => n + s.groups.length, 0),
      packing: o.filter((x) => x.phase === "ready_to_pack").length,
      pickup: o.filter((x) => x.status === "SEALED").length,
    };
  }, [snap]);

  if (failure)
    return (
      <main className="mx-auto mt-24 max-w-md px-6 text-center">
        <h1 className="text-xl font-bold">Praxis can&apos;t open this kitchen</h1>
        <p className="mt-2 text-sm text-muted">{failure} Nothing has been overwritten. Check the data file on the computer running Praxis, then reload.</p>
      </main>
    );
  if (!snap)
    return (
      <p className="mt-24 text-center text-sm text-muted" role="status">
        {online ? "Opening the board…" : "Can’t reach Praxis. Check that this device is on the same network."}
      </p>
    );
  if (!snap.configured)
    return (
      <>
        <Setup />
        <Notice />
      </>
    );

  const last = snap.solver.last;
  const failed = last && !["optimal", "feasible", "skipped"].includes(last.status);
  const tabs: [View, string, number][] = [
    ["orders", "Orders", counts.orders],
    ["stations", "Stations", counts.stations],
    ["packing", "Packing", counts.packing],
    ["pickup", "Pickup", counts.pickup],
  ];

  return (
    <main className="min-h-dvh">
      <header className="no-print tk-header sticky top-0 z-30 mb-6 border-b border-line bg-panel/95 shadow-sm backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-4 px-4 py-4 sm:px-6 sm:py-5">
          <Clock />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-xl font-black tracking-tight">{snap.config.name}</h1>
            <p className="truncate text-sm font-medium text-muted">
              {counts.orders} open order{counts.orders === 1 ? "" : "s"}
              {snap.solver.pending ? " · planning…" : ""}
            </p>
          </div>
          <div className="flex w-full items-center justify-between gap-2 lg:w-auto">
            <IconButton label="Rush Recovery" onClick={() => setSheet("rush")}><LifeBuoy size={22} aria-hidden="true" /></IconButton>
            <IconButton label="Ask Praxis" onClick={() => setSheet("ask")}><MessageCircleQuestion size={22} aria-hidden="true" /></IconButton>
            <IconButton label="Shift report" onClick={() => setSheet("report")}><BarChart3 size={22} aria-hidden="true" /></IconButton>
            <IconButton label="Settings" onClick={() => setSheet("settings")}><Settings size={22} aria-hidden="true" /></IconButton>
            <Button tone="primary" className="ml-auto min-h-14 text-base" onClick={() => setSheet("order")}>
              <Plus size={18} aria-hidden="true" /> New order
            </Button>
          </div>
        </div>
        <nav aria-label="Views" className="mx-auto grid max-w-7xl grid-cols-4 gap-1 px-3 pb-3 sm:gap-2 sm:px-6">
          {tabs.map(([id, label, n]) => (
            <button
              key={id}
              type="button"
              aria-current={view === id ? "page" : undefined}
              onClick={() => go(id)}
              className={`flex min-h-16 min-w-0 flex-wrap items-center justify-center gap-1 rounded-xl border-2 px-1 py-2 text-sm font-black transition-colors sm:gap-2 sm:px-5 sm:text-lg ${view === id ? "border-brand bg-brand text-on-brand shadow-sm" : "border-line bg-panel"}`}
            >
              {label}
              {n > 0 && <span className={`rounded-md px-1.5 py-0.5 text-xs sm:px-2 sm:text-sm ${view === id ? "bg-on-brand text-brand" : "bg-raised"}`}>{n}</span>}
            </button>
          ))}
        </nav>
        {!online && (
          <p role="alert" className="flex items-center justify-center gap-2 bg-warn-soft px-3 py-1.5 text-sm font-semibold text-warn">
            <WifiOff size={15} aria-hidden="true" /> Connection lost. This screen may be out of date.
          </p>
        )}
        {!snap.solver.available && (
          <p role="alert" className="bg-bad-soft px-3 py-2 text-center text-sm font-bold text-bad">
            The scheduling engine isn&apos;t installed, so new orders can&apos;t be planned. Run <code>npm run setup:solver</code> on the computer running Praxis, then reload.
          </p>
        )}
        {snap.solver.available && failed && (
          <p role="alert" className="bg-bad-soft px-3 py-2 text-center text-sm font-bold text-bad">
            The last planning attempt didn&apos;t find a plan ({last!.status}). Earlier plans are still showing. Please review before releasing.
          </p>
        )}
        {snap.warnings.length > 0 && (
          <details className="mx-auto max-w-7xl px-3 pb-2 sm:px-5">
            <summary className="min-h-14 cursor-pointer py-4 text-sm font-bold text-warn">Needs review ({snap.warnings.length})</summary>
            <ul className="list-disc space-y-1 pl-5 text-sm text-warn">
              {snap.warnings.map((w) => <li key={w}>{w}</li>)}
            </ul>
          </details>
        )}
      </header>

      {view === "orders" && <OrdersView onNew={() => setSheet("order")} />}
      {view === "stations" && <StationsView />}
      {view === "packing" && <PackingView />}
      {view === "pickup" && <PickupView />}

      {sheet === "order" && (
        <Sheet title="New order" onClose={closeSheet}>
          <NewOrderSheet onDone={() => { closeSheet(); go("orders"); }} />
        </Sheet>
      )}
      {sheet === "rush" && (
        <Sheet title="Rush Recovery" onClose={closeSheet}>
          <RushRecovery onClose={closeSheet} />
        </Sheet>
      )}
      {sheet === "ask" && (
        <Sheet title="Ask Praxis" onClose={closeSheet}>
          <Assistant />
        </Sheet>
      )}
      {sheet === "report" && (
        <Sheet title="This shift" onClose={closeSheet}>
          <ShiftReport />
        </Sheet>
      )}
      {sheet === "settings" && (
        <Sheet title="Settings" onClose={closeSheet}>
          <SettingsForm
            initial={snap.config}
            submitLabel="Save and replan"
            onSubmit={async (config) => {
              const r = await call("/api/settings", { config });
              if (!r.ok) return r.error ?? "Couldn't save the settings.";
              toast("Settings saved. Drafts were replanned.");
              closeSheet();
              return null;
            }}
          />
        </Sheet>
      )}
      <Notice />
    </main>
  );
}

export default function Home() {
  return (
    <KitchenProvider>
      <Shell />
    </KitchenProvider>
  );
}
