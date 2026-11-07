/**
 * Optional shared passcode for the board. Off unless PRAXIS_PASSCODE is set.
 * Uses Web Crypto so the same code runs in middleware and route handlers.
 */
export const COOKIE = "praxis_session";
export const SESSION_SECONDS = 12 * 60 * 60;

const bytes = (s: string) => new TextEncoder().encode(s);

async function hmac(secret: string, message: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    bytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, bytes(message));
  return [...new Uint8Array(signature)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export const sessionToken = (passcode: string) =>
  hmac(passcode, "praxis-session-v1");

/** Compares without leaking where the first difference is. */
export function sameText(a: string, b: string) {
  if (a.length !== b.length) return false;
  let different = 0;
  for (let i = 0; i < a.length; i++)
    different |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return different === 0;
}

/** A page on another site must not be able to drive this board from a staff browser. */
export function isCrossSite(origin: string | null, host: string | null) {
  if (!origin) return false;
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}
