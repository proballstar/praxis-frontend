"use client";
import { useEffect, useRef, useState } from "react";
import { Mic, MicOff } from "lucide-react";
import { SpokenDish, parseSpokenDish } from "@/lib/dish-speech";
import { Button } from "./ui";

type Recognizer = {
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
type RecognizerConstructor = new () => Recognizer;

function getRecognizer(): RecognizerConstructor | null {
  const w = window as unknown as {
    SpeechRecognition?: RecognizerConstructor;
    webkitSpeechRecognition?: RecognizerConstructor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

const EXAMPLE = 'Say a dish and its minutes, like "burger, eight minutes".';

/** Speak a dish to add it to the menu. The result is only added to the form; Save still applies it. */
export function DictateDish({ onHeard }: { onHeard: (dish: SpokenDish) => void }) {
  // Checked after mount so server and first client render match.
  const [support, setSupport] = useState<"checking" | "yes" | "insecure" | "no">(
    "checking",
  );
  const [listening, setListening] = useState(false);
  const [message, setMessage] = useState("");
  const recognizer = useRef<Recognizer | null>(null);

  useEffect(() => {
    if (!getRecognizer()) setSupport("no");
    else if (!window.isSecureContext) setSupport("insecure");
    else setSupport("yes");
    return () => recognizer.current?.abort();
  }, []);

  function listen() {
    const Ctor = getRecognizer();
    if (!Ctor) return;
    const r = new Ctor();
    r.lang = "en-US";
    r.interimResults = false;
    r.maxAlternatives = 1;
    r.onresult = (e) => {
      const heard = e.results[0][0].transcript;
      const dish = parseSpokenDish(heard);
      setMessage(
        dish
          ? `Added "${dish.name}, ${dish.minutes} min". Check it, then save.`
          : `Heard "${heard}". ${EXAMPLE}`,
      );
      if (dish) onHeard(dish);
    };
    r.onerror = (e) => {
      setListening(false);
      setMessage(
        e.error === "not-allowed" || e.error === "service-not-allowed"
          ? "Microphone access is blocked. Allow it in your browser settings."
          : e.error === "no-speech"
            ? "Didn't catch that. Tap the microphone and try again."
            : "Voice entry failed. Type the dish instead.",
      );
    };
    r.onend = () => setListening(false);
    recognizer.current = r;
    setMessage("Listening…");
    setListening(true);
    r.start();
  }

  if (support === "checking") return null;
  if (support === "no")
    return (
      <p className="text-xs text-muted">
        Voice entry isn’t available in this browser. Type the dish instead.
      </p>
    );
  if (support === "insecure")
    return (
      <p className="text-xs text-muted">
        Voice entry needs a secure (HTTPS) address. Type the dish instead.
      </p>
    );

  return (
    <div className="mt-2 flex flex-wrap items-center gap-3">
      <Button
        onClick={() => (listening ? recognizer.current?.stop() : listen())}
        aria-pressed={listening}
        aria-label={listening ? "Stop listening" : "Speak a dish"}
        className={listening ? "border-bad text-bad" : ""}
      >
        {listening ? <MicOff size={16} /> : <Mic size={16} />}
        {listening ? "Stop" : "Speak a dish"}
      </Button>
      {message && (
        <p role="status" className="text-xs text-muted">
          {message}
        </p>
      )}
    </div>
  );
}
