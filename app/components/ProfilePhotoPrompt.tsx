"use client";

import { useState } from "react";

/**
 * Profile photo upload/replace. Used both right after registration succeeds
 * and, reachable any time, from the logged-in profile screen
 * (AccountProfile.tsx) — either way POST /api/account/photo requires the
 * caller to already hold a valid account session. Skippable: an account
 * with no photo is a normal, supported state, not an incomplete one.
 */
export default function ProfilePhotoPrompt({
  currentPhotoUrl = null,
}: {
  currentPhotoUrl?: string | null;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [uploadedUrl, setUploadedUrl] = useState<string | null>(currentPhotoUrl);
  const [busy, setBusy] = useState(false);
  const [justUploaded, setJustUploaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload() {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("photo", file);
      const res = await fetch("/api/account/photo", { method: "POST", body: form });

      if (!res.ok) {
        // The error body is not guaranteed to be JSON: a request over
        // Vercel's platform-level 4.5 MB limit never reaches this route's
        // own code at all, and comes back as a 413 with a platform page as
        // its body, not our JSON. That is a real, specific refusal — it
        // must not be reported as the generic network-error catch below,
        // which would tell a player nothing about what actually happened.
        let message: string | undefined;
        try {
          message = (await res.json()).message;
        } catch {
          // Not JSON — fall through to the status-based message below.
        }
        setError(
          message ??
            (res.status === 413
              ? "A kép túl nagy a feltöltéshez. Válassz egy kisebb fájlt."
              : "A feltöltés nem sikerült.")
        );
        return;
      }

      const data = await res.json();
      setUploadedUrl(data.photo_url);
      setJustUploaded(true);
      setFile(null);
    } catch {
      setError("Hálózati hiba — próbáld újra.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-[var(--ink)]">Profilkép (nem kötelező).</p>
      {uploadedUrl && (
        // eslint-disable-next-line @next/next/no-img-element -- a remote Blob
        // URL, not a local asset; next/image's optimizer has nothing to do here.
        <img
          src={uploadedUrl}
          alt=""
          className="h-16 w-16 rounded-full border border-[var(--ink)]/15 object-cover"
        />
      )}
      <input
        type="file"
        accept="image/png,image/jpeg,image/webp"
        onChange={(e) => {
          setFile(e.target.files?.[0] ?? null);
          setJustUploaded(false);
        }}
        disabled={busy}
        className="text-sm text-[var(--ink-soft)]"
      />
      <button
        onClick={() => void upload()}
        disabled={busy || !file}
        className="min-h-11 self-start rounded-md border border-[var(--ink)]/30 px-4 py-2.5 text-sm font-medium text-[var(--ink)] disabled:opacity-40"
      >
        {uploadedUrl ? "Csere" : "Feltöltés"}
      </button>
      {justUploaded && !error && (
        <p className="text-sm text-[var(--green)]">Profilkép feltöltve.</p>
      )}
      {error && <p className="text-sm text-[var(--red)]">{error}</p>}
    </div>
  );
}
