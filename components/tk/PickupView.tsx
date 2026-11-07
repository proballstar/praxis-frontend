"use client";
import { useEffect, useRef, useState } from "react";
import { CheckCircle2, CircleAlert, Clock3 } from "lucide-react";
import { Button, inputClass } from "@/components/ui";
import { useKitchen } from "./kitchen";

type Lookup =
  | { match: false; message: string }
  | { match: true; orderId: string; number: number; customer: string; state: "sealed" | "not_sealed" | "handed_off"; slot?: string; message: string };

export function PickupView() {
  const { snap, call, toast } = useKitchen();
  const [code, setCode] = useState("");
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const latest = useRef(0);

  useEffect(() => {
    if (!code.trim()) {
      setLookup(null);
      return;
    }
    const id = ++latest.current;
    const timer = setTimeout(async () => {
      const r = await call("/api/pickup", { code });
      if (id === latest.current && r.ok) setLookup(r.data?.lookup as Lookup);
    }, 250);
    return () => clearTimeout(timer);
  }, [code, call, snap?.rev]);

  if (!snap) return null;
  const found = lookup && lookup.match && lookup.state === "sealed" ? lookup : null;

  async function confirm() {
    if (!found) return;
    setBusy(true);
    setError("");
    const r = await call(`/api/orders/${found.orderId}/handoff`, { code });
    setBusy(false);
    if (!r.ok) return setError(r.error ?? "Couldn't hand that off.");
    toast(`Order #${found.number} handed off. Shelf ${found.slot} is free.`);
    setCode("");
    setLookup(null);
  }

  const tone = !lookup ? "" : !lookup.match ? "bad" : lookup.state === "sealed" ? "good" : "warn";
  return (
    <div className="mx-auto max-w-4xl space-y-6 px-4 pb-12 sm:px-6">
      <section aria-label="Pickup code" className="space-y-5 rounded-2xl border-2 border-line bg-panel p-5 shadow-sm sm:p-7">
        <label className="block">
          <span className="text-2xl font-black tracking-tight">Enter the pickup code</span>
          <input
            className={`${inputClass} mt-3 min-h-24 text-center text-4xl font-black uppercase tracking-[0.16em] sm:text-5xl`}
            value={code}
            autoCapitalize="characters"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            maxLength={12}
            onChange={(e) => {
              setCode(e.target.value.toUpperCase());
              setError("");
            }}
            aria-describedby="pickup-result"
          />
        </label>
        <div id="pickup-result" aria-live="polite" className="min-h-14">
          {lookup && (
            <p className={`flex items-start gap-3 rounded-xl p-4 text-xl font-bold ${tone === "good" ? "bg-soft text-brand" : tone === "warn" ? "bg-warn-soft text-warn" : "bg-bad-soft text-bad"}`}>
              {tone === "good" ? <CheckCircle2 aria-hidden="true" className="mt-1 shrink-0" /> : tone === "warn" ? <Clock3 aria-hidden="true" className="mt-1 shrink-0" /> : <CircleAlert aria-hidden="true" className="mt-1 shrink-0" />}
              <span>
                {lookup.message}
                {lookup.match && <span className="mt-1 block text-base font-semibold">For {lookup.customer}</span>}
              </span>
            </p>
          )}
        </div>
        {error && (
          <p role="alert" className="rounded-xl bg-bad-soft p-3 font-bold text-bad">
            {error}
          </p>
        )}
        <Button tone="primary" className="min-h-18 w-full text-xl font-black" disabled={!found || busy} onClick={confirm}>
          Confirm handoff
        </Button>
      </section>

      <section aria-label="Shelf">
        <h2 className="mb-3 text-2xl font-black tracking-tight">Shelf</h2>
        <ul className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6">
          {snap.shelf.map((s) => {
            const hit = found?.slot === s.slot;
            return (
              <li
                key={s.slot}
                aria-label={s.orderId ? `${s.slot}: order ${s.number}, ${s.customer}` : `${s.slot}: free`}
                className={`flex min-h-36 min-w-0 flex-col justify-center rounded-2xl border-2 p-3 text-center ${hit ? "slot-found border-brand bg-soft" : s.orderId ? "border-line bg-panel" : "border-dashed border-line text-muted"}`}
              >
                <p className="text-3xl font-black">{s.slot}</p>
                {s.orderId ? (
                  <>
                    <p className="text-xl font-black">#{s.number}</p>
                    <p className="truncate text-sm">{s.customer}</p>
                  </>
                ) : (
                  <p className="text-sm">free</p>
                )}
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
