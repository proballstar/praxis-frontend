"use client";
import { ButtonHTMLAttributes, ReactNode, useEffect, useRef } from "react";
import { X } from "lucide-react";

export function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: "primary" | "plain" | "danger";
};

export function Button({ tone = "plain", className = "", ...props }: ButtonProps) {
  const tones = {
    primary: "bg-brand text-on-brand border-brand hover:opacity-90",
    plain: "bg-panel text-ink border-line hover:bg-raised",
    danger: "bg-panel text-bad border-bad/30 hover:bg-bad-soft",
  };
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex min-h-14 min-w-14 items-center justify-center gap-2 rounded-xl border px-5 py-3 text-base font-bold shadow-sm transition active:translate-y-px disabled:opacity-50 ${tones[tone]} ${className}`}
    />
  );
}

export function Pill({
  tone,
  children,
}: {
  tone: "good" | "warn" | "bad" | "quiet";
  children: ReactNode;
}) {
  const tones = {
    good: "bg-soft text-brand",
    warn: "bg-warn-soft text-warn",
    bad: "bg-bad-soft text-bad",
    quiet: "bg-raised text-muted",
  };
  return (
    <span
      className={`inline-flex max-w-full shrink-0 items-center rounded-lg px-3 py-1.5 text-xs font-extrabold tracking-wide ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function Sheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-40 flex items-end justify-center bg-black/60 backdrop-blur-sm sm:items-center sm:p-6"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className="flex max-h-[92dvh] w-full min-w-0 max-w-xl flex-col rounded-t-2xl border border-line bg-panel shadow-2xl outline-none sm:rounded-2xl"
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="text-2xl font-black tracking-tight">{title}</h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="-mr-2 grid size-14 shrink-0 place-items-center rounded-xl text-muted hover:bg-raised"
          >
            <X size={20} />
          </button>
        </div>
        <div className="overflow-y-auto p-5 sm:p-6">{children}</div>
      </div>
    </div>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-semibold">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </label>
  );
}

export const inputClass =
  "min-h-14 w-full min-w-0 rounded-xl border-2 border-line bg-raised px-4 text-ink placeholder:text-muted focus:border-brand focus:bg-panel";
