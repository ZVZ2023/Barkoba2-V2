"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

/**
 * V2.3 — the second player takes the Racer seat.
 *
 * Joins on mount: the player already made the decision by opening the link, so
 * asking them to press a second button adds a step and no information. Failures
 * are shown rather than redirected, because "this game is full" and "this link
 * expired" are different things and the player should be told which.
 */
export default function JoinClient({ code }: { code: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;

    (async () => {
      try {
        const res = await fetch("/api/game/join", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          setError(data?.message || "Ez a meghívó nem működik.");
          return;
        }
        router.replace(`/game/${data.game_id}`);
      } catch {
        setError("Hálózati hiba — frissítsd az oldalt.");
      }
    })();
  }, [code, router]);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Barkóba</h1>
      {error ? (
        <>
          <p className="text-sm text-[#8b2f2f]">{error}</p>
          <a href="/" className="min-h-11 text-sm text-neutral-600 underline underline-offset-2">
            ← Vissza a Barkóba főoldalra
          </a>
        </>
      ) : (
        <p className="text-sm text-neutral-700">Csatlakozás a játékhoz…</p>
      )}
    </div>
  );
}
