/**
 * Protects the AI budget on a shared board: a few questions at a time and a
 * ceiling per minute across all devices. In memory, so a restart resets it.
 */
const MAX_PER_MINUTE = 20;
const MAX_IN_FLIGHT = 2;
const WINDOW_MS = 60_000;

let stamps: number[] = [];
let inFlight = 0;

export function resetLimits() {
  stamps = [];
  inFlight = 0;
}

/** Returns a release function, or null when the request should be refused. */
export function acquire(now = Date.now()): (() => void) | null {
  stamps = stamps.filter((t) => now - t < WINDOW_MS);
  if (stamps.length >= MAX_PER_MINUTE || inFlight >= MAX_IN_FLIGHT) return null;
  stamps.push(now);
  inFlight++;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      inFlight--;
    }
  };
}
