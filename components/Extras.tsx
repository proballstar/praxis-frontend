"use client";
import { FormEvent, useEffect, useRef, useState } from "react";
import { Simulation } from "@/lib/changes";
import { Service, openOrders, report } from "@/lib/service";
import { Dispatch } from "./Board";
import { Button, clock, inputClass } from "./ui";

const MAX_HISTORY = 12;

const minutes = (n: number | null) =>
  n === null ? "—" : `${n.toFixed(1)} min`;

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-raised p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-xl font-bold">{value}</p>
    </div>
  );
}

export function ShiftReportView({
  service,
  dispatch,
  onClose,
}: {
  service: Service;
  dispatch: Dispatch;
  onClose: () => void;
}) {
  const r = report(service.orders);
  const open = openOrders(service).filter((o) => !o.sample).length;
  return (
    <div className="space-y-5">
      {r.orders === 0 ? (
        <p className="text-sm text-muted">
          No finished orders yet this shift. Results appear as orders are marked
          ready.
        </p>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          <Stat label="Orders finished" value={String(r.orders)} />
          <Stat
            label="Ready on time"
            value={`${Math.round((r.onTime / r.orders) * 100)}%`}
          />
          <Stat label="Avg courier wait" value={minutes(r.avgCourierWait)} />
          <Stat label="Avg over estimate" value={minutes(r.avgOverrun)} />
          <Stat label="Avg food sitting" value={minutes(r.avgFoodSitting)} />
          <Stat label="Dishes past their window" value={String(r.pastWindow)} />
        </div>
      )}
      {r.orders > 0 && (
        <p className="text-xs text-muted">
          Observed results, based on what staff tapped: Done, Ready, Courier
          here and Picked up. If dishes keep running over estimate, raise those
          prep minutes in Settings.
        </p>
      )}
      <div>
        <Button
          className="w-full"
          disabled={open > 0}
          onClick={async () => {
            if (await dispatch({ type: "endShift" })) onClose();
          }}
        >
          End shift and clear the board
        </Button>
        {open > 0 && (
          <p className="mt-1 text-xs text-muted">
            Hand off or cancel the {open} open first.
          </p>
        )}
      </div>
      {service.shifts.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-bold">Past shifts</h3>
          <ul className="space-y-1.5">
            {service.shifts.map((s) => (
              <li
                key={s.endedAt}
                className="flex justify-between gap-3 rounded-lg bg-raised px-3 py-2 text-sm"
              >
                <span>
                  {new Date(s.endedAt).toLocaleDateString([], {
                    month: "short",
                    day: "numeric",
                  })}{" "}
                  · ended {clock(s.endedAt)}
                </span>
                <span className="text-muted">
                  {s.orders} orders · {s.late} late
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

const SUGGESTIONS = [
  "What should we do next?",
  "Why this order?",
  "Can we take 4 burgers with a courier in 15 minutes?",
];

type Turn = {
  role: "user" | "assistant";
  content: string;
  ai?: boolean;
  proposal?: Simulation;
  outcome?: "approved" | "declined";
};

function ProposalCard({
  proposal,
  outcome,
  onDecide,
}: {
  proposal: Simulation;
  outcome?: Turn["outcome"];
  onDecide: (approved: boolean) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const { before, after } = proposal;
  return (
    <div className="mt-2 rounded-lg border border-brand bg-panel p-3">
      <ul className="list-disc space-y-1 pl-4 text-sm font-semibold">
        {proposal.lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <p className="mt-2 text-xs text-muted">{proposal.summary}</p>
      <p className="mt-1 text-xs text-muted">
        Courier waiting {before.wait} → {after.wait} min · Food sitting{" "}
        {before.idle} → {after.idle} min · Lateness {before.lateness} →{" "}
        {after.lateness} min
      </p>
      {outcome ? (
        <p className="mt-2 text-sm font-semibold text-muted">
          {outcome === "approved"
            ? "Applied. Undo is in the top bar."
            : "Not applied."}
        </p>
      ) : (
        <div className="mt-3 flex gap-2">
          <Button
            className="flex-1"
            disabled={busy}
            onClick={() => onDecide(false)}
          >
            Not now
          </Button>
          <Button
            tone="primary"
            className="flex-1"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await onDecide(true);
              setBusy(false);
            }}
          >
            Approve
          </Button>
        </div>
      )}
    </div>
  );
}

export function AskPraxis({ dispatch }: { dispatch: Dispatch }) {
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [turns, busy]);

  async function ask(q: string) {
    const content = q.trim();
    if (!content || busy) return;
    const history: Turn[] = [...turns, { role: "user", content }];
    setTurns(history);
    setQuestion("");
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: history
            .slice(-MAX_HISTORY)
            .map(({ role, content }) => ({ role, content })),
        }),
      });
      const body = await response.json();
      if (!response.ok) throw Error(body.error);
      setTurns([
        ...history,
        {
          role: "assistant",
          content: body.answer,
          ai: body.mode === "openrouter",
          proposal: body.proposal ?? undefined,
        },
      ]);
    } catch (e) {
      setError(
        e instanceof Error && e.message ? e.message : "No answer. Try again.",
      );
    }
    setBusy(false);
  }

  async function decide(index: number, turn: Turn, approved: boolean) {
    if (
      approved &&
      !(await dispatch({
        type: "batch",
        baseRev: turn.proposal!.baseRev,
        label: "approved changes",
        actions: turn.proposal!.actions,
      }))
    )
      return;
    setTurns((all) =>
      all.map((t, i) =>
        i === index
          ? { ...t, outcome: approved ? "approved" : "declined" }
          : t,
      ),
    );
  }

  return (
    <div className="space-y-3">
      {turns.length === 0 && (
        <div className="flex flex-wrap gap-2">
          {SUGGESTIONS.map((s) => (
            <Button key={s} disabled={busy} onClick={() => ask(s)}>
              {s}
            </Button>
          ))}
        </div>
      )}
      <div className="space-y-2" aria-live="polite">
        {turns.map((turn, i) =>
          turn.role === "user" ? (
            <p
              key={i}
              className="ml-8 rounded-lg bg-soft p-3 text-sm font-medium"
            >
              {turn.content}
            </p>
          ) : (
            <div key={i} className="mr-4 rounded-lg bg-raised p-3 text-sm">
              <p className="leading-relaxed">{turn.content}</p>
              {turn.proposal && (
                <ProposalCard
                  proposal={turn.proposal}
                  outcome={turn.outcome}
                  onDecide={(approved) => decide(i, turn, approved)}
                />
              )}
              {!turn.ai && (
                <p className="mt-2 text-xs text-muted">
                  Board summary. AI isn’t connected, so questions and changes
                  aren’t understood here.
                </p>
              )}
            </div>
          ),
        )}
        {busy && <p className="text-sm text-muted">Checking the board…</p>}
        {error && <p className="text-sm text-bad">{error}</p>}
        <div ref={end} />
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          ask(question);
        }}
      >
        <input
          className={inputClass}
          aria-label="Your question"
          placeholder="Ask or tell Praxis something"
          value={question}
          maxLength={1000}
          onChange={(e) => setQuestion(e.target.value)}
        />
        <Button tone="primary" type="submit" disabled={busy || !question.trim()}>
          Send
        </Button>
      </form>
    </div>
  );
}
