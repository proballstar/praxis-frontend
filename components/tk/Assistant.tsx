"use client";
import { FormEvent, useEffect, useRef, useState } from "react";
import { Mic, MicOff } from "lucide-react";
import type { Proposal } from "@/lib/tk/changes";
import { Button, inputClass } from "@/components/ui";
import { useKitchen } from "./kitchen";
import { SimulationResult } from "./RushRecovery";

const SUGGESTIONS = [
  "What should we do next?",
  "Which orders are at risk?",
  "The left grill burner just broke for 20 minutes.",
];
const MAX_HISTORY = 12;

type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  maxAlternatives: number;
  onresult: ((e: { results: { 0: { transcript: string } }[] }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};
type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;
function getSpeechRecognition(): SpeechRecognitionConstructor | null {
  const w = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

type Turn = {
  role: "user" | "assistant";
  content: string;
  ai?: boolean;
  proposal?: Proposal;
  outcome?: "approved" | "declined";
};

function ProposalCard({
  proposal,
  outcome,
  onDecide,
}: {
  proposal: Proposal;
  outcome?: Turn["outcome"];
  onDecide: (approved: boolean) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="mt-2 space-y-2 rounded-xl border border-brand bg-panel p-3">
      <ul className="list-disc space-y-1 pl-4 text-sm font-semibold">
        {proposal.lines.map((l) => (
          <li key={l}>{l}</li>
        ))}
      </ul>
      <SimulationResult sim={proposal} />
      {outcome ? (
        <p className="text-sm font-semibold text-muted">
          {outcome === "approved"
            ? "Applied. Drafts were replanned."
            : "Not applied."}
        </p>
      ) : (
        <div className="flex gap-2">
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

export function Assistant() {
  const { call, toast } = useKitchen();
  const [question, setQuestion] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [speechSupport, setSpeechSupport] = useState<
    "checking" | "yes" | "insecure" | "no"
  >("checking");
  const [listening, setListening] = useState(false);
  const [speechMessage, setSpeechMessage] = useState("");
  const recognition = useRef<SpeechRecognitionLike | null>(null);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!getSpeechRecognition()) setSpeechSupport("no");
    else if (!window.isSecureContext) setSpeechSupport("insecure");
    else setSpeechSupport("yes");
    return () => {
      const r = recognition.current;
      if (r) {
        r.onresult = null;
        r.onerror = null;
        r.onend = null;
        r.abort();
      }
    };
  }, []);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [turns, busy]);

  function toggleSpeech() {
    if (listening) {
      recognition.current?.stop();
      return;
    }
    const Ctor = getSpeechRecognition();
    if (!Ctor) return;
    const r = new Ctor();
    r.lang = "en-US";
    r.interimResults = false;
    r.maxAlternatives = 1;
    r.onresult = (e) => {
      setQuestion((q) =>
        [q.trimEnd(), e.results[0][0].transcript.trim()]
          .filter(Boolean)
          .join(" ")
          .slice(0, 1000),
      );
      setSpeechMessage("Added to your question. Review it before sending.");
    };
    r.onerror = (e) => {
      setListening(false);
      setSpeechMessage(
        e.error === "not-allowed" || e.error === "service-not-allowed"
          ? "Microphone access was denied. Allow it in browser settings, or type your question."
          : e.error === "no-speech"
            ? "No speech detected. Try again, or type your question."
            : "Speech input failed. You can type your question instead.",
      );
    };
    r.onend = () => {
      setListening(false);
      setSpeechMessage((m) =>
        m === "Listening…"
          ? "Microphone stopped. You can try again or type your question."
          : m,
      );
    };
    recognition.current = r;
    setSpeechMessage("Listening…");
    setListening(true);
    try {
      r.start();
    } catch {
      setListening(false);
      setSpeechMessage(
        "Could not start the microphone. Type your question instead.",
      );
    }
  }

  async function ask(q: string) {
    const content = q.trim();
    if (!content || busy) return;
    const history: Turn[] = [...turns, { role: "user", content }];
    setTurns(history);
    setQuestion("");
    setBusy(true);
    setError("");
    const r = await call("/api/assistant", {
      messages: history
        .slice(-MAX_HISTORY)
        .map(({ role, content }) => ({ role, content })),
    });
    setBusy(false);
    if (!r.ok) return setError(r.error ?? "No answer. Try again.");
    const d = r.data as { answer: string; mode: string; proposal?: Proposal };
    setTurns([
      ...history,
      {
        role: "assistant",
        content: d.answer,
        ai: d.mode === "openrouter",
        proposal: d.proposal ?? undefined,
      },
    ]);
  }

  async function decide(index: number, turn: Turn, approved: boolean) {
    if (approved) {
      const r = await call("/api/approve", {
        baseRev: turn.proposal!.baseRev,
        changes: turn.proposal!.changes,
      });
      if (!r.ok) return toast(r.error ?? "Couldn't apply that.");
    }
    setTurns((all) =>
      all.map((t, i) =>
        i === index ? { ...t, outcome: approved ? "approved" : "declined" } : t,
      ),
    );
  }

  return (
    <div className="space-y-3">
      {!turns.length && (
        <div className="flex flex-wrap gap-2">
          {SUGGESTIONS.map((s) => (
            <Button key={s} disabled={busy || listening} onClick={() => ask(s)}>
              {s}
            </Button>
          ))}
        </div>
      )}
      <div className="space-y-2" aria-live="polite">
        {turns.map((t, i) =>
          t.role === "user" ? (
            <p
              key={i}
              className="ml-8 rounded-xl bg-soft p-3 text-sm font-medium"
            >
              {t.content}
            </p>
          ) : (
            <div key={i} className="mr-4 rounded-xl bg-raised p-3 text-sm">
              <p className="leading-relaxed">{t.content}</p>
              {t.proposal && (
                <ProposalCard
                  proposal={t.proposal}
                  outcome={t.outcome}
                  onDecide={(a) => decide(i, t, a)}
                />
              )}
              {!t.ai && (
                <p className="mt-2 text-xs text-muted">
                  Board summary. AI isn&apos;t connected, so questions and
                  changes aren&apos;t understood here.
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
          void ask(question);
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
        <Button
          tone="primary"
          type="submit"
          disabled={busy || listening || !question.trim()}
        >
          Send
        </Button>
      </form>
      {speechSupport === "yes" ? (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="button"
            disabled={busy}
            onClick={toggleSpeech}
            aria-pressed={listening}
            aria-label={listening ? "Stop listening" : "Start voice input"}
            className={listening ? "border-bad text-bad" : ""}
          >
            {listening ? <MicOff size={16} /> : <Mic size={16} />}
            {listening ? "Stop listening" : "Speak question"}
          </Button>
          {speechMessage && (
            <p role="status" className="text-xs text-muted">
              {speechMessage}
            </p>
          )}
        </div>
      ) : speechSupport !== "checking" ? (
        <p className="text-xs text-muted">
          {speechSupport === "insecure"
            ? "For voice on this address, use the microphone on your phone keyboard. The in-app microphone requires HTTPS or localhost."
            : "This browser does not support in-app dictation. You can use your keyboard’s microphone or type a question."}
        </p>
      ) : null}
    </div>
  );
}
