"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  BarChart3,
  LifeBuoy,
  MessageCircleQuestion,
  Plus,
  Settings,
  WifiOff,
  ChefHat,
  ClipboardList,
  PackageCheck,
  ShoppingBag,
  ArrowUpRight,
  CheckCircle2,
} from "lucide-react";
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
      className="grid size-14 shrink-0 place-items-center rounded-xl border border-line bg-panel text-ink hover:bg-raised disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function Notice() {
  const { notice } = useKitchen();
  if (!notice) return null;
  return (
    <p
      role="alert"
      className="fixed inset-x-3 bottom-4 z-50 mx-auto max-w-md rounded-lg bg-ink px-4 py-3 text-center text-sm font-semibold text-bg shadow-lg"
    >
      {notice}
    </p>
  );
}

function Setup() {
  const { snap, call } = useKitchen();
  const [customize, setCustomize] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!snap) return null;
  return (
    <main className="setup-page">
      <div className="setup-brand">
        <span className="brand-symbol">
          <ChefHat size={22} />
        </span>
        praxis<span className="setup-tag">KITCHEN WORKSPACE</span>
      </div>
      <div className="setup-layout">
        <section className="setup-intro">
          <span className="eyebrow">A CLEARER NEXT MOVE</span>
          <h1>
            Your kitchen.
            <br />
            All in sync.
          </h1>
          <p>
            Bring preparation, packing, and pickups into one workspace. Keep the
            team moving through every rush.
          </p>
          <div className="setup-steps">
            {[
              "Plan each order around pickup time",
              "Send clear instructions to every station",
              "Check every bag before handoff",
            ].map((t) => (
              <div key={t}>
                <CheckCircle2 size={18} />
                {t}
              </div>
            ))}
          </div>
          <div className="setup-footnote">
            Start with the sample menu. Adjust it to your kitchen any time.
          </div>
        </section>
        <section className="setup-card">
          <span className="eyebrow">LET’S GET YOU SET UP</span>
          <h2>Welcome to Praxis</h2>
          <p>A name for your kitchen. We’ll handle the starting point.</p>
          {customize ? (
            <SettingsForm
              initial={{ ...snap.config, name: name || snap.config.name }}
              submitLabel="Open the board"
              onSubmit={async (config: Config) => {
                const r = await call("/api/settings", { config });
                return r.ok ? null : (r.error ?? "Couldn't save settings.");
              }}
            />
          ) : (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                const r = await call("/api/settings", {
                  config: { ...snap.config, name: name.trim() },
                });
                setBusy(false);
                if (!r.ok) setError(r.error ?? "Couldn’t open the kitchen.");
              }}
            >
              <label className="setup-label">
                Restaurant name
                <input
                  autoFocus
                  required
                  maxLength={60}
                  placeholder="e.g. The Willow Kitchen"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <div className="setup-defaults">
                <ChefHat size={20} />
                <div>
                  <b>A kitchen, ready to try</b>
                  <span>
                    {snap.config.stations.length} stations ·{" "}
                    {snap.config.recipes.length} menu items · starter
                    preparation times
                  </span>
                </div>
              </div>
              {error && (
                <p role="alert" className="text-bad">
                  {error}
                </p>
              )}
              <Button
                type="submit"
                tone="primary"
                className="w-full"
                disabled={busy}
              >
                {busy ? "Opening…" : "Open the board"}
                <ArrowUpRight size={17} />
              </Button>
            </form>
          )}
          <button
            className="setup-customize"
            onClick={() => setCustomize(!customize)}
          >
            {customize
              ? "Back to quick setup"
              : "Customize equipment, staff & menu"}
            <Settings size={15} />
          </button>
          <p className="setup-disclosure">
            Starter values are sample assumptions. Review them before running a
            real service.
          </p>
        </section>
      </div>
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
    window.scrollTo({ top: 0 });
  };

  const counts = useMemo(() => {
    const o = snap?.orders ?? [];
    return {
      orders: o.filter((x) => x.status === "DRAFT" || x.status === "RELEASED")
        .length,
      stations: (snap?.stations ?? []).reduce((n, s) => n + s.groups.length, 0),
      packing: o.filter((x) => x.phase === "ready_to_pack").length,
      pickup: o.filter((x) => x.status === "SEALED").length,
    };
  }, [snap]);

  if (failure)
    return (
      <main className="mx-auto mt-24 max-w-md px-6 text-center">
        <h1 className="text-xl font-bold">
          Praxis can&apos;t open this kitchen
        </h1>
        <p className="mt-2 text-sm text-muted">
          {failure} Nothing has been overwritten. Check the data file on the
          computer running Praxis, then reload.
        </p>
      </main>
    );
  if (!snap)
    return (
      <p className="mt-24 text-center text-sm text-muted" role="status">
        {online
          ? "Opening the board…"
          : "Can’t reach Praxis. Check that this device is on the same network."}
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
  const failed =
    last && !["optimal", "feasible", "skipped"].includes(last.status);
  const tabs: [View, string, number][] = [
    ["orders", "Orders", counts.orders],
    ["stations", "Stations", counts.stations],
    ["packing", "Packing", counts.packing],
    ["pickup", "Pickup", counts.pickup],
  ];

  const title = {
    orders: "Orders",
    stations: "Station board",
    packing: "Packing",
    pickup: "Pickup",
  }[view];
  const description = {
    orders: "Every order, from the first instruction to the final handoff.",
    stations: "Clear instructions for the team behind every order.",
    packing: "The final check before a great meal leaves your kitchen.",
    pickup: "Match the code. Find the bag. Make the handoff.",
  }[view];
  const icons = {
    orders: ClipboardList,
    stations: ChefHat,
    packing: PackageCheck,
    pickup: ShoppingBag,
  };
  return (
    <main className="kitchen-app">
      <aside className="app-sidebar no-print">
        <div className="app-wordmark">
          <span className="brand-symbol">
            <ChefHat size={22} />
          </span>
          praxis
          <span className="wordmark-dot" />
        </div>
        <div className="merchant-switch">
          <span className="merchant-initial">
            {snap.config.name.slice(0, 1).toUpperCase()}
          </span>
          <div>
            <b>{snap.config.name}</b>
            <small>Kitchen workspace</small>
          </div>
        </div>
        <span className="sidebar-label">SERVICE</span>
        <nav aria-label="Views" className="app-nav">
          {tabs.map(([id, label, n]) => {
            const Icon = icons[id];
            return (
              <button
                key={id}
                type="button"
                aria-current={view === id ? "page" : undefined}
                onClick={() => go(id)}
              >
                <Icon size={19} />
                <span>{label}</span>
                <b>{n}</b>
              </button>
            );
          })}
        </nav>
        <span className="sidebar-label tools-label">MANAGE</span>
        <div className="sidebar-tools">
          <button onClick={() => setSheet("rush")}>
            <LifeBuoy size={18} />
            Rush Recovery
            <ArrowUpRight size={13} />
          </button>
          <button onClick={() => setSheet("report")}>
            <BarChart3 size={18} />
            Shift report
          </button>
          <button onClick={() => setSheet("settings")}>
            <Settings size={18} />
            Settings
          </button>
        </div>
        <div className="sidebar-bottom">
          <span className="connection-dot" />{" "}
          {online ? "Kitchen connected" : "Connection lost"}
          <small>Changes sync across your devices</small>
        </div>
      </aside>
      <div className="app-main">
        <header className="no-print app-topbar">
          <div className="topbar-crumb">
            Workspace <span>/</span>
            <b>{title}</b>
          </div>
          <div className="topbar-right">
            <Clock />
            <span className="service-live">
              <i />
              Live service
            </span>
            <button
              className="assistant-trigger"
              onClick={() => setSheet("ask")}
              aria-label="Ask Praxis"
            >
              <MessageCircleQuestion size={17} />
              <span>Ask Praxis</span>
            </button>
            <div className="mobile-tools">
              <IconButton
                label="Rush Recovery"
                onClick={() => setSheet("rush")}
              >
                <LifeBuoy size={18} />
              </IconButton>
              <IconButton
                label="Shift report"
                onClick={() => setSheet("report")}
              >
                <BarChart3 size={18} />
              </IconButton>
              <IconButton label="Settings" onClick={() => setSheet("settings")}>
                <Settings size={18} />
              </IconButton>
            </div>
          </div>
        </header>
        <div className="board-heading">
          <div>
            <div className="eyebrow">{snap.config.name} / LIVE KITCHEN</div>
            <h1>
              {title}
              <span className="heading-count">{counts[view]}</span>
            </h1>
            <p>{description}</p>
          </div>
          <Button tone="primary" onClick={() => setSheet("order")}>
            <Plus size={17} />
            New order
          </Button>
        </div>
        {!online && (
          <p role="alert" className="board-alert text-warn">
            <WifiOff size={15} /> Connection lost. This screen may be out of
            date.
          </p>
        )}
        {!snap.solver.available && (
          <p role="alert" className="board-alert text-bad">
            Scheduling is unavailable. Please check the solver installation on
            the computer running Praxis.
          </p>
        )}
        {snap.solver.available && failed && (
          <p role="alert" className="board-alert text-bad">
            Planning needs attention ({last!.status}). Earlier plans are still
            showing. Review before releasing.
          </p>
        )}
        {snap.warnings.length > 0 && (
          <details className="board-alert">
            <summary className="text-warn">
              Needs review ({snap.warnings.length})
            </summary>
            <ul>
              {snap.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </details>
        )}
        {view === "orders" && <OrdersView onNew={() => setSheet("order")} />}
        {view === "stations" && <StationsView />}
        {view === "packing" && <PackingView />}
        {view === "pickup" && <PickupView />}

        {sheet === "order" && (
          <Sheet title="New order" onClose={closeSheet}>
            <NewOrderSheet
              onDone={() => {
                closeSheet();
                go("orders");
              }}
            />
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
      </div>
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
