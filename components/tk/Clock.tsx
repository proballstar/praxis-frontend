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
    <div
      className="flex max-w-full flex-wrap items-baseline gap-2 leading-none"
      role="timer"
      aria-label={spoken}
    >
      <span className="text-[25px] font-semibold tracking-[-0.04em]">
        {parts.hhmm}
      </span>
      {parts.suffix && (
        <span className="text-xs font-medium text-muted">{parts.suffix}</span>
      )}
      <span className="hidden" aria-hidden="true">
        {tz.replace("_", " ")}
      </span>
    </div>
  );
}
