"use client";
import { useEffect, useState } from "react";
import type { Report } from "@/lib/tk/report";
import { useKitchen } from "./kitchen";

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-xl bg-raised p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-2xl font-black">{value}</p>
      {note && <p className="text-xs text-muted">{note}</p>}
    </div>
  );
}

export function ShiftReport() {
  const { call } = useKitchen();
  const [r, setR] = useState<Report | null>(null);
  useEffect(() => {
    void call("/api/report", {}, "GET").then((x) => x.ok && setR(x.data?.report as Report));
  }, [call]);
  if (!r) return <p className="text-sm text-muted">Loading…</p>;
  const sealed = r.sealedOnTime + r.sealedLate;
  return (
    <div className="space-y-4">
      {sealed === 0 ? (
        <p className="text-sm text-muted">No bags have been sealed yet. Results appear as orders are packed.</p>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <Stat label="Bags sealed" value={String(sealed)} />
          <Stat label="Sealed by target" value={`${Math.round((r.sealedOnTime / sealed) * 100)}%`} />
          <Stat label="Average vs target" value={`${r.avgMinutesAfterTarget! > 0 ? "+" : ""}${r.avgMinutesAfterTarget!.toFixed(1)} min`} note="Negative is early" />
          <Stat label="Handed off" value={String(r.handedOff)} />
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Stat label="Remakes" value={String(r.remakes)} />
        <Stat label="Receipts withdrawn" value={String(r.withdrawn)} />
        <Stat label="Starts inferred" value={String(r.inferredStarts)} note="DONE tapped without START" />
        <Stat label="Early overrides" value={String(r.earlyOverrides)} />
        <Stat label="Wrong pickup codes" value={String(r.rejectedCodes)} />
      </div>
      <p className="text-xs text-muted">Observed results only, from what staff recorded. Sample orders are excluded. These numbers don&apos;t show savings or validate the food-quality settings.</p>
    </div>
  );
}
