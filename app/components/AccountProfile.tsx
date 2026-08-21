"use client";

import { useEffect, useState } from "react";
import ProfilePhotoPrompt from "./ProfilePhotoPrompt";

interface Profile {
  display_name: string | null;
  email: string | null;
  email_verified: boolean;
  photo_url: string | null;
}

/**
 * The logged-in player's own profile: current email (with its verified
 * status) plus a change form, and photo upload/replace. Reachable any time
 * from the account modal while authenticated — unlike the registration-time
 * email field and the old one-shot ProfilePhotoPrompt placement, this is not
 * a one-time step.
 */
export default function AccountProfile() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const res = await fetch("/api/account/profile", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as Profile;
        if (live) {
          setProfile(data);
          setEmail(data.email ?? "");
        }
      } catch {
        // Nothing to preload; the form below still works against a blank field.
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  async function saveEmail() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await fetch("/api/account/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim() }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message || "Nem sikerült menteni.");
        return;
      }
      setProfile((p) => (p ? { ...p, email: data.email, email_verified: false } : p));
      setSaved(true);
    } catch {
      setError("Hálózati hiba — próbáld újra.");
    } finally {
      setBusy(false);
    }
  }

  const unchanged = profile !== null && email.trim() === (profile.email ?? "");

  return (
    <div className="flex flex-col gap-3 border-t border-[var(--ink)]/10 pt-3">
      <p className="text-sm font-medium text-[var(--ink)]">Profil</p>

      <div className="flex flex-col gap-2">
        <label className="text-xs text-[var(--ink-soft)]">
          E-mail cím
          {profile?.email && (
            <span
              className={
                profile.email_verified ? "ml-2 text-[var(--green)]" : "ml-2 text-[var(--red)]"
              }
            >
              {profile.email_verified ? "megerősítve" : "megerősítésre vár"}
            </span>
          )}
        </label>
        <input
          type="email"
          inputMode="email"
          autoComplete="email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            setSaved(false);
          }}
          placeholder="te@pelda.hu"
          disabled={busy}
          className="w-full min-w-0 rounded-md border border-[var(--ink)]/15 bg-white/70 px-3 py-2 text-sm text-[var(--ink)] outline-none focus:border-[var(--green)]"
        />
        <button
          onClick={() => void saveEmail()}
          disabled={busy || !email.trim() || unchanged}
          className="min-h-11 self-start rounded-md bg-[var(--green)] px-4 py-2.5 text-sm font-medium text-[var(--parchment)] disabled:opacity-40"
        >
          {profile?.email ? "E-mail cím módosítása" : "E-mail cím mentése"}
        </button>
        {error && <p className="text-sm text-[var(--red)]">{error}</p>}
        {saved && !error && (
          <p className="text-sm text-[var(--green)]">
            Mentve. Küldtünk egy megerősítő linket az új címre.
          </p>
        )}
      </div>

      <div className="border-t border-[var(--ink)]/10 pt-3">
        <ProfilePhotoPrompt currentPhotoUrl={profile?.photo_url ?? null} />
      </div>
    </div>
  );
}
