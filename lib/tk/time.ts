/** The scheduler works in 30-second ticks. Server time is the only clock that matters. */
export const TICK_MS = 30_000;
export const MINUTE_MS = 60_000;

export const alignDown = (ms: number) => Math.floor(ms / TICK_MS) * TICK_MS;
export const alignUp = (ms: number) => Math.ceil(ms / TICK_MS) * TICK_MS;
export const minutesToTicks = (m: number) => Math.round((m * MINUTE_MS) / TICK_MS);
export const ticksToMinutes = (t: number) => (t * TICK_MS) / MINUTE_MS;

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string, clock24: boolean) {
  const key = `${timeZone}|${clock24}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: clock24 ? "2-digit" : "numeric",
      minute: "2-digit",
      hour12: !clock24,
    });
    formatters.set(key, f);
  }
  return f;
}

/** "6:15 PM" (or "18:15"), in the restaurant's own zone and never the viewer's. */
export function formatTime(ms: number, timeZone: string, clock24 = false) {
  return formatter(timeZone, clock24).format(new Date(ms));
}

/** Pieces for the big dashboard clock: HH:MM and the AM/PM suffix. */
export function clockParts(ms: number, timeZone: string, clock24 = false) {
  const parts = formatter(timeZone, clock24).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const hour = get("hour");
  return {
    hhmm: `${clock24 ? hour.padStart(2, "0") : hour}:${get("minute")}`,
    suffix: clock24 ? "" : get("dayPeriod"),
  };
}

export function isValidTimeZone(zone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export const defaultTimeZone = () =>
  process.env.PRAXIS_TIMEZONE && isValidTimeZone(process.env.PRAXIS_TIMEZONE)
    ? process.env.PRAXIS_TIMEZONE
    : Intl.DateTimeFormat().resolvedOptions().timeZone;
