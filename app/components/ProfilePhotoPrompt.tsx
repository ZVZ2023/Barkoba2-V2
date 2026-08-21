"use client";

import { useState } from "react";

/**
 * Optional profile photo upload, shown right after registration succeeds —
 * this browser already holds a valid account session by then, which
 * POST /api/account/photo requires. Skippable: an account with no photo is a
 * normal, supported state, not an incomplete one.
 */
export default function ProfilePhotoPrompt() {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload() {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("photo", file);
      const res = await fetch("/api/account/photo", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message || "A feltöltés nem sikerült.");
        return;
      }
      setDone(true);
    } catch {
      setError("Hálózati hiba — próbáld újra.");
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return <p className="text-sm text-[var(--green)]">Profilkép feltöltve.</p>;
  }

  return (
    <div className="flex flex-col gap-2 border-t border-[var(--ink)]/10 pt-3">
      <p className="text-sm text-[var(--ink)]">Profilkép (nem kötelező).</p>
      <input
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        disabled={busy}
        className="text-sm text-[var(--ink-soft)]"
      />
      <button
        onClick={() => void upload()}
        disabled={busy || !file}
        className="min-h-11 self-start rounded-md border border-[var(--ink)]/30 px-4 py-2.5 text-sm font-medium text-[var(--ink)] disabled:opacity-40"
      >
        Feltöltés
      </button>
      {error && <p className="text-sm text-[var(--red)]">{error}</p>}
    </div>
  );
}
