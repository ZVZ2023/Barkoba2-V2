"use client";

import { useState } from "react";

/**
 * "I have played before" — restores an existing Player onto this browser.
 *
 * Collapsed by default. A returning player on a new device is the rare case;
 * putting an input box in front of everyone else would be its own kind of wall.
 */
export default function RecoverPrompt() {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function recover() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/player/recover", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (!res.ok) setError(data.message || "Ez a kód nem érvényes.");
      else setDone(data.display_name || "");
    } catch {
      setError("Hálózati hiba — próbáld újra.");
    } finally {
      setBusy(false);
    }
  }

  if (done !== null) {
    return (
      <p className="rounded-md border border-[var(--green)]/30 bg-[var(--green)]/6 px-3 py-2 text-sm text-[var(--green)]">
        {done ? `Szia, ${done}! Megvagy.` : "Megvagy — visszakaptad a játékosodat."}
      </p>
    );
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="min-h-11 self-start text-sm text-[var(--ink-soft)] underline underline-offset-2"
      >
        Már játszottam korábban
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-[var(--ink)]/15 bg-white/50 p-4">
      <p className="text-sm text-[var(--ink)]">Írd be a helyreállító kódodat.</p>
      <input
        spellCheck={false}
        autoCapitalize="characters"
        autoCorrect="off"
        className="w-full min-w-0 rounded-md border border-[var(--ink)]/15 bg-white/70 px-3 py-2 font-mono text-sm text-[var(--ink)] outline-none focus:border-[var(--green)]"
        value={code}
        onChange={(e) => setCode(e.target.value)}
        placeholder="BARKOBA-..."
        disabled={busy}
      />
      <button
        onClick={() => void recover()}
        disabled={busy || !code.trim()}
        className="min-h-11 self-start rounded-md bg-[var(--green)] px-4 py-2.5 text-sm font-medium text-[var(--parchment)] disabled:opacity-40"
      >
        Folytatom
      </button>
      {error && <p className="text-sm text-[var(--red)]">{error}</p>}
    </div>
  );
}
