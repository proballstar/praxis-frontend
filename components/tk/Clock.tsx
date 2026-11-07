"use client";
import { clockParts, useKitchen } from "./kitchen";

/**
 * The big dashboard clock: HH:MM in the restaurant's own time zone, driven by
 * server time. It never shows the viewer's device time.
 */
export function Clock() {
  const { snap, now } = useKitchen();
  const tz = snap?.timezone ?? "UTC";
  const parts = clockParts(now, tz, snap?.clock24 ?? false);
  const spoken = `Restaurant time ${parts.hhmm} ${parts.suffix}`.trim();
  return (
    <div className="flex max-w-full flex-wrap items-baseline gap-2 leading-none" role="timer" aria-label={spoken}>
      <span className="text-6xl font-black tracking-[-0.06em] sm:text-7xl">{parts.hhmm}</span>
      {parts.suffix && <span className="text-2xl font-bold text-muted sm:text-3xl">{parts.suffix}</span>}
      <span className="ml-1 hidden text-xs font-semibold text-muted xl:inline" aria-hidden="true">
        {tz.replace("_", " ")}
      </span>
    </div>
  );
}
