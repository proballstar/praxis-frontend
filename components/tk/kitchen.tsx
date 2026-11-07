"use client";
import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { requestId as createRequestId } from "@/lib/request-id";
import type { Snapshot } from "@/lib/tk/snapshot";
import { clockParts, formatTime } from "@/lib/tk/time";

const POLL_MS = 2000;
/** Ignore small clock differences so cards don't jitter between polls. */
const OFFSET_TOLERANCE_MS = 1500;

export type CallResult = {
  ok: boolean;
  /** Parsed JSON from the server, when there was a response. */
  data?: Record<string, unknown>;
  error?: string;
  code?: string;
};

type Kitchen = {
  snap: Snapshot | null;
  /** Server time, extended smoothly between polls. The device clock is never shown. */
  now: number;
  online: boolean;
  failure: string;
  fmt: (ms: number | null | undefined) => string;
  minutesFrom: (ms: number) => number;
  call: (path: string, body?: object, method?: "POST" | "GET") => Promise<CallResult>;
  refresh: () => Promise<void>;
  toast: (message: string) => void;
  notice: string;
};

const Ctx = createContext<Kitchen | null>(null);

export function useKitchen() {
  const k = useContext(Ctx);
  if (!k) throw new Error("useKitchen outside provider");
  return k;
}

export function KitchenProvider({ children }: { children: ReactNode }) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [offset, setOffset] = useState(0);
  const [tick, setTick] = useState(() => Date.now());
  const [online, setOnline] = useState(true);
  const [failure, setFailure] = useState("");
  const [notice, setNotice] = useState("");
  const rev = useRef(-1);
  const offsetRef = useRef<number | null>(null);

  const accept = useCallback((next: Snapshot) => {
    if (next.rev < rev.current) return;
    rev.current = next.rev;
    setSnap(next);
    const measured = next.serverNow - Date.now();
    if (offsetRef.current === null || Math.abs(measured - offsetRef.current) > OFFSET_TOLERANCE_MS) {
      offsetRef.current = measured;
      setOffset(measured);
    }
  }, []);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/state", { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) {
        setFailure(body.error ?? "Praxis can't open this kitchen.");
        return;
      }
      accept(body.snapshot);
      setFailure("");
      setOnline(true);
    } catch {
      setOnline(false);
    }
  }, [accept]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, POLL_MS);
    const wake = () => document.visibilityState === "visible" && void refresh();
    document.addEventListener("visibilitychange", wake);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [refresh]);

  useEffect(() => {
    const timer = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 7000);
    return () => clearTimeout(timer);
  }, [notice]);

  /**
   * Sends a change. The request id makes a retry safe: if the connection drops
   * after the server acted, asking again returns the same answer instead of acting twice.
   */
  const call = useCallback(
    async (path: string, body: object = {}, method: "POST" | "GET" = "POST"): Promise<CallResult> => {
      const requestId = createRequestId();
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await fetch(path, {
            method,
            headers: { "Content-Type": "application/json", "Idempotency-Key": requestId },
            ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
          });
          const data = (await response.json()) as Record<string, unknown>;
          if (data.snapshot) accept(data.snapshot as Snapshot);
          if (!response.ok) {
            void refresh();
            return { ok: false, data, error: String(data.error ?? "That didn't work."), code: String(data.code ?? "") };
          }
          setOnline(true);
          return { ok: true, data };
        } catch {
          setOnline(false);
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        }
      }
      return { ok: false, error: "Not saved. Check the connection and tap again." };
    },
    [accept, refresh],
  );

  const now = tick + offset;
  const value = useMemo<Kitchen>(() => {
    const tz = snap?.timezone ?? "UTC";
    const h24 = snap?.clock24 ?? false;
    return {
      snap,
      now,
      online,
      failure,
      fmt: (ms) => (ms === null || ms === undefined ? "—" : formatTime(ms, tz, h24)),
      minutesFrom: (ms) => Math.round((ms - now) / 60_000),
      call,
      refresh,
      toast: setNotice,
      notice,
    };
  }, [snap, now, online, failure, call, refresh, notice]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** "2:10" style countdown. Negative values read as overdue. */
export function mmss(ms: number) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export { clockParts };
