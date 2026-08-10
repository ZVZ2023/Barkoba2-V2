"use client";

import { useState } from "react";
import { MAX_PLAYER_NAME_LENGTH } from "@/lib/playerIdentity";

/**
 * "What should we call you?" - asked once, after the player has chosen a role
 * and before game setup.
 *
 * NOT registration: no email, no password, no account, nothing recoverable on
 * another device. It gives the existing anonymous Player a human-friendly label
 * and nothing more.
 *
 * Skip is a first-class answer, styled at the same weight as continuing. A
 * quiet grey "skip" beside a bright primary button is a dark pattern, and this
 * is the first thing a new player meets - before they have seen the game or
 * have any reason to give us anything.
 *
 * Either answer resolves the question permanently for this player: the skip
 * writes the cookie too, which is what stops us asking on every visit.
 */
export default function NamePrompt({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function answer(value: string) {
    setBusy(true);
    try {
      await fetch("/api/player/name", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: value }),
      });
    } catch {
      // A name is a nicety. If it cannot be saved, the game still starts - and
      // we do not trap the player behind an error they did not ask for.
    } finally {
      setBusy(false);
      onDone();
    }
  }

  return (
    <div className="flex flex-col gap-4 rounded-md border border-[var(--ink)]/15 bg-white/60 p-4">
      <div className="flex flex-col gap-1">
        <p className="text-base font-semibold text-[var(--ink)]">Hogy szólítsunk?</p>
        <p className="text-sm text-[var(--ink-soft)]">
          Nem kell regisztrálni, és nem kell a valódi neved. Ha inkább nem adsz meg
          semmit, az is teljesen rendben van.
        </p>
      </div>

      <input
        spellCheck
        autoCorrect="on"
        autoCapitalize="words"
        maxLength={MAX_PLAYER_NAME_LENGTH}
        className="w-full min-w-0 rounded-md border border-[var(--ink)]/15 bg-white/70 px-3 py-2 text-[var(--ink)] outline-none focus:border-[var(--green)]"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="pl. Zsolt"
        disabled={busy}
        onKeyDown={(e) => {
          if (e.key === "Enter" && name.trim() && !busy) void answer(name);
        }}
      />

      <div className="flex gap-2">
        <button
          onClick={() => void answer(name)}
          disabled={busy || !name.trim()}
          className="min-h-11 flex-1 rounded-md bg-[var(--green)] px-4 py-2.5 text-sm font-medium text-[var(--parchment)] disabled:opacity-40"
        >
          Rendben
        </button>
        <button
          onClick={() => void answer("")}
          disabled={busy}
          className="min-h-11 flex-1 rounded-md border border-[var(--ink)]/30 px-4 py-2.5 text-sm font-medium text-[var(--ink)] disabled:opacity-40"
        >
          Kihagyom
        </button>
      </div>
    </div>
  );
}
