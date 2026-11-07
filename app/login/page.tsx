"use client";
import { FormEvent, useState } from "react";
import { Button, Field, inputClass } from "@/components/ui";

export default function Login() {
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passcode }),
      });
      if (response.ok) {
        window.location.href = "/";
        return;
      }
      setError("Wrong passcode. Try again.");
    } catch {
      setError("Can’t reach Praxis. Check the connection.");
    }
    setBusy(false);
  }

  return (
    <main className="mx-auto mt-24 max-w-sm px-4">
      <p className="text-sm font-bold text-brand">Praxis</p>
      <h1 className="mt-1 mb-6 text-2xl font-bold">Enter the kitchen passcode</h1>
      <form onSubmit={submit} className="space-y-4">
        <Field label="Passcode">
          <input
            className={inputClass}
            type="password"
            autoComplete="current-password"
            autoFocus
            value={passcode}
            onChange={(e) => setPasscode(e.target.value)}
          />
        </Field>
        {error && <p className="text-sm text-bad">{error}</p>}
        <Button tone="primary" type="submit" disabled={busy} className="w-full">
          Open the board
        </Button>
      </form>
    </main>
  );
}
