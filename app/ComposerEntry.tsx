"use client";

import ThinkingState from "./components/ThinkingState";
import NamePrompt from "./components/NamePrompt";
import { useState } from "react";
import { useRouter } from "next/navigation";
import AccountControl from "./components/AccountControl";
import GameShell from "./components/GameShell";
import BudgetPicker, { pickedBudget } from "./components/BudgetPicker";
import { CreditGateway, useEntitlement } from "./components/Entitlement";
import {
  DEFAULT_EXPERIENCE_MODE,
  EXPERIENCE_MODES,
  EXPERIENCE_MODE_DESCRIPTION_HU,
  EXPERIENCE_MODE_LABEL_HU,
} from "@/lib/experienceMode";
import type { Difficulty, ExperienceMode } from "@/lib/types";

// ---------------------------------------------------------------------------
// V2.8.8.7 — COST-SAFE AI ENGINE SELECTION.
//
// A plain string union duplicated locally rather than imported from
// lib/racerEngineTier.ts — same reasoning HistoryClient.tsx's own doc gives
// for duplicating its HistoryEntry shape: a client component should not
// depend on a server module's exact export surface for two string literals.
// The server (app/api/game/create/route.ts) is the sole authority on what
// these values mean and do; this is presentation only.
//
// LABEL LANGUAGE, PER ENGINE. The standard tier's label is bilingual
// ("Érvelő AI" / "Reasoning AI") per the approved product decision. The
// premium tier's Hungarian label ("Emberi szintű AI") is the one APPROVED
// public name and is used as-is regardless of gameLanguage — the same
// "label stays fixed, narrative copy follows gameLanguage" split
// app/game/[id]/ArchivedGameView.tsx already established for role/
// experience-mode labels vs. narrative sentences. The premium PRICE and
// disclaimer text, being a fact about money, still follows gameLanguage.
// ---------------------------------------------------------------------------
type EngineTier = "standard" | "premium";

interface EnginePriceCopy {
  price: string;
  disclaimer: string;
  ineligible: string;
}

const PREMIUM_PRICE_COPY: Record<"hu" | "en", EnginePriceCopy> = {
  hu: {
    price: "2 gombóc — jelenleg kb. 4,20 USD / játék",
    disclaimer:
      "A hozzávetőleges USD-árfolyam és az ár a vezető csúcskategóriás modellek " +
      "szolgáltatási költségeinek változásával módosulhat.",
    ineligible:
      "Az „Emberi szintű AI” csak megvásárolt VERSENY-egyenlegből indítható — " +
      "az ingyenes próbajáték és a regisztrációs jóváírás nem elég hozzá.",
  },
  en: {
    price: "2 scoops — currently about USD 4.20 per game",
    disclaimer:
      "The approximate USD equivalent and price may change as exchange rates " +
      "and leading frontier-model service costs change.",
    ineligible:
      "“Emberi szintű AI” can only be funded from a purchased VERSENY balance " +
      "— the free trial game and registration credit are not enough.",
  },
};

// V2.8.8 — this screen never had an assistance ("Segítség") selector at
// all (clue_mode was always null here — see the V2.8.8 report's own
// finding that this left the AI Racer's clue-request path structurally
// unreachable). The experience mode is new here, not a replacement.
const EXPERIENCE_MODE_OPTIONS: { value: ExperienceMode; label: string; blurb: string }[] =
  EXPERIENCE_MODES.map((value) => ({
    value,
    label: EXPERIENCE_MODE_LABEL_HU[value],
    blurb: EXPERIENCE_MODE_DESCRIPTION_HU[value],
  }));

type ViewState =
  | { step: "entry" }
  | { step: "submitting" }
  | { step: "clarification_required"; message: string; privateKnowledge: boolean }
  | { step: "invalid"; message: string }
  | {
      step: "valid";
      gameId: string;
      maxQuestions: number;
      difficultyWarning: string | null;
      privateKnowledge: boolean;
    }
  | { step: "error"; message: string };

/**
 * Shown before play whenever the Validator flags the target as resting on the
 * Composer's private knowledge.
 *
 * It is a warning, never a gate. The point is that the player understands what
 * adjudication can and cannot do here BEFORE they spend a game on it — not
 * that Barkóba talks them out of the target they chose.
 */
function PrivateTargetNote() {
  return (
    <div className="rounded-md border border-[var(--ink)]/15 bg-white/70 p-3">
      <p className="text-sm font-semibold text-[var(--ink)]">Személyes titok</p>
      <p className="mt-1 text-sm text-[var(--ink-soft)]">
        Az AI nem tud önállóan ellenőrizni olyan tényeket, amelyeket csak te ismersz.
        A kérdések megítélése és a végső értékelés ezért az általad megadott
        információk pontosságán múlik.
      </p>
    </div>
  );
}

export default function ComposerEntry({
  versionLabel,
  askForName = false,
  accountAuthenticated = false,
  accountPhotoUrl = null,
}: {
  versionLabel: string;
  askForName?: boolean;
  /** V2.8.4.3 — resolved server-side by app/compose/page.tsx. */
  accountAuthenticated?: boolean;
  accountPhotoUrl?: string | null;
}) {
  const router = useRouter();
  const [target, setTarget] = useState("");
  const [clarification, setClarification] = useState("");
  const [difficulty, setDifficulty] = useState<Difficulty>("easy");
  // V2.8.8 — visibly defaults to Friendly, never Competitive (decision #3).
  const [experienceMode, setExperienceMode] = useState<ExperienceMode>(DEFAULT_EXPERIENCE_MODE);
  const [budgetOverride, setBudgetOverride] = useState<number | null>(null);
  // V2.8.8.7 — preselected to "standard", the only tier that existed before
  // this feature and the one whose credit charge is unchanged.
  const [engineTier, setEngineTier] = useState<EngineTier>("standard");
  // V2.5 — the language of PLAY, not of this screen. "auto" lets Barkóba read
  // it from how the target was written; the explicit options exist because a
  // one-word target (Grok, Apple, Tesla) reveals nothing about which language
  // the player meant. The interface stays Hungarian in every case.
  const [gameLanguage, setGameLanguage] = useState<"auto" | "hu" | "en">("auto");
  // V2.4 - refusal for lack of Play Credits must lead somewhere.
  const [noCredit, setNoCredit] = useState(false);
  // V2.8.8.7 — distinct from noCredit: a player can have an ordinary,
  // perfectly spendable balance and still be refused premium specifically,
  // because that balance is not purchased. Conflating the two would show a
  // "your balance is exhausted" message that is simply false.
  const [premiumIneligible, setPremiumIneligible] = useState(false);
  const entitlement = useEntitlement();
  const [view, setView] = useState<ViewState>({ step: "entry" });
  // Asked once, before setup. Resolved locally after the answer so the form
  // appears immediately rather than after a round trip.
  const [naming, setNaming] = useState(askForName);

  async function submit(force = false) {
    setNoCredit(false);
    setPremiumIneligible(false);
    setView({ step: "submitting" });
    try {
      const res = await fetch("/api/game/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target,
          private_clarification: clarification,
          // V2.3 — the Composer's chosen allowance. The server re-resolves it;
          // this only proposes.
          difficulty,
          // V2.8.8 — a NEW client always submits its visible selection; the
          // server derives clue_mode from it (see resolveExperienceAndClueMode
          // in app/api/game/create/route.ts).
          experience_mode: experienceMode,
          max_questions: pickedBudget(difficulty, budgetOverride),
          // V2.8.0 — the ordinary public client no longer proposes an
          // opponent at all. The server picks it (one "Barkóba AI",
          // server-authoritative) — see the PUBLIC_RACER_PROVIDER constant
          // in app/api/game/create/route.ts. The field this used to send is
          // deliberately absent, not merely defaulted, so there is nothing
          // here for a future build to accidentally start sending again.
          // "auto" is sent as-is; the server treats anything that is not "hu"
          // or "en" as a request to decide, so it never becomes game state.
          game_language: gameLanguage,
          // V2.8.8.7 — a stable internal tier id, never a provider or model
          // name (see lib/racerEngineTier.ts). The server re-validates and
          // re-prices this; this only proposes.
          engine_tier: engineTier,
          // Set once the player has seen the warning and chosen to continue.
          force,
        }),
      });

      const data = await res.json();

      if (res.status === 429) {
        setView({ step: "error", message: data.message });
        return;
      }
      if (!res.ok && data.error && data.error !== "validator_unavailable") {
        if (data.error === "no_play_credit") setNoCredit(true);
        if (data.error === "premium_engine_insufficient_credit") setPremiumIneligible(true);
        setView({ step: "error", message: data.message || "Valami hiba történt." });
        return;
      }

      if (data.status === "INVALID") {
        setView({ step: "invalid", message: data.message });
      } else if (data.status === "CLARIFICATION_REQUIRED") {
        setView({
          step: "clarification_required",
          message: data.message,
          privateKnowledge: data.private_knowledge === true,
        });
      } else if (data.status === "VALID") {
        setView({
          step: "valid",
          gameId: data.game_id,
          maxQuestions: data.max_questions,
          difficultyWarning: data.difficulty_warning,
          privateKnowledge: data.private_knowledge === true,
        });
        // A difficulty warning is worth a beat to read; otherwise go straight in.
        if (!data.difficulty_warning) {
          router.push(`/game/${data.game_id}`);
        }
      } else {
        setView({ step: "error", message: "Váratlan válasz a szervertől." });
      }
    } catch {
      setView({ step: "error", message: "Hálózati hiba — próbáld újra." });
    }
  }

  return (
    <GameShell
      role="Te gondolsz valamire. A Barkóba AI fogja kitalálni."
      version={versionLabel}
      meta={<AccountControl authenticated={accountAuthenticated} photoUrl={accountPhotoUrl} />}
    >
      {view.step === "submitting" && (
        <ThinkingState note="Ellenőrzi, hogy a célpont játszható-e, aztán indul a játék." />
      )}

      {naming && <NamePrompt onDone={() => setNaming(false)} />}

      {!naming && view.step === "entry" && (
        <div className="flex flex-col gap-4">
          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--ink)]">Amire gondolsz</span>
            <input
              spellCheck
              autoCorrect="on"
              autoCapitalize="sentences"
              className="w-full min-w-0 rounded-md border border-[var(--ink)]/15 bg-white/70 px-3 py-2 text-[var(--ink)] outline-none focus:border-[var(--green)]"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              placeholder="pl. fogantyú"
            />
          </label>

          <label className="flex flex-col gap-1 text-sm">
            <span className="text-[var(--ink)]">
              Pontosítás <span className="text-[var(--ink-soft)]">(nem kötelező)</span> — az AI sosem látja
            </span>
            <textarea
              spellCheck
              autoCorrect="on"
              autoCapitalize="sentences"
              className="h-24 w-full min-w-0 resize-none rounded-md border border-[var(--ink)]/15 bg-white/70 px-3 py-2 text-[var(--ink)] outline-none focus:border-[var(--green)]"
              value={clarification}
              onChange={(e) => setClarification(e.target.value)}
              placeholder="Csak ha a szó többfélét is jelenthet — pl. a fűnyíróm indítózsinórjának fogantyúja"
            />
          </label>

          {/* V2.5 — the language of PLAY. Not the language of this screen:
              Barkóba's interface stays Hungarian whichever option is chosen.
              "Automatikus" reads it from how the target was written. */}
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-[var(--ink)]">A játék nyelve</span>
            <div className="flex gap-2">
              {(
                [
                  { value: "auto", label: "Automatikus" },
                  { value: "hu", label: "Magyar" },
                  { value: "en", label: "English" },
                ] as const
              ).map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => setGameLanguage(option.value)}
                  className={`min-h-11 flex-1 rounded-md border px-3 py-2.5 text-sm font-medium ${
                    gameLanguage === option.value
                      ? "border-[var(--green)] bg-[var(--green)] text-[var(--parchment)]"
                      : "border-[var(--ink)]/15 bg-white/70 text-[var(--ink)]"
                  }`}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>

          {/*
            V2.8.8 — new selector: this screen never had an assistance
            picker before, so nothing is replaced here (unlike RacerSetup.tsx).
            Governs GameClient.tsx's own AI-Racer clue-request path, which
            was structurally unreachable before this (clue_mode was always
            null on this creation branch).
          */}
          <div className="flex flex-col gap-2">
            <span className="text-sm text-[var(--ink)]">Élmény</span>
            <div className="flex flex-wrap gap-2">
              {EXPERIENCE_MODE_OPTIONS.map((m) => (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => setExperienceMode(m.value)}
                  className={`min-h-11 flex-1 rounded-md border px-3 py-2.5 text-sm font-medium ${
                    experienceMode === m.value
                      ? "border-[var(--green)] bg-[var(--green)] text-[var(--parchment)]"
                      : "border-[var(--ink)]/15 bg-white/70 text-[var(--ink)]"
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
            <p className="text-xs text-[var(--ink-soft)]">
              {EXPERIENCE_MODE_OPTIONS.find((m) => m.value === experienceMode)?.blurb}
            </p>
          </div>

          {/*
            V2.8.8.7 — the engine picker. Mobile-first: two full-width
            stacked buttons, "Alapértelmezett" preselected. The provider and
            model behind each are never named here — see PREMIUM_PRICE_COPY's
            own doc on why the labels stay Hungarian while the price/legal
            copy follows the game's language.
          */}
          {(() => {
            const priceCopy = gameLanguage === "en" ? PREMIUM_PRICE_COPY.en : PREMIUM_PRICE_COPY.hu;
            const premium = entitlement.view?.premium_engine;
            const premiumEligible = premium?.eligible === true;
            return (
              <div className="flex flex-col gap-2">
                <span className="text-sm font-medium text-[var(--ink)]">Ellenfél</span>
                <div className="flex flex-col gap-2">
                  <button
                    type="button"
                    onClick={() => setEngineTier("standard")}
                    className={`min-h-11 rounded-md border px-3 py-2.5 text-left text-sm font-medium ${
                      engineTier === "standard"
                        ? "border-[var(--green)] bg-[var(--green)] text-[var(--parchment)]"
                        : "border-[var(--ink)]/15 bg-white/70 text-[var(--ink)]"
                    }`}
                  >
                    {gameLanguage === "en" ? "Reasoning AI" : "Érvelő AI"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setEngineTier("premium")}
                    className={`min-h-11 rounded-md border px-3 py-2.5 text-left text-sm font-medium ${
                      engineTier === "premium"
                        ? "border-[var(--green)] bg-[var(--green)] text-[var(--parchment)]"
                        : "border-[var(--ink)]/15 bg-white/70 text-[var(--ink)]"
                    }`}
                  >
                    Emberi szintű AI
                  </button>
                </div>
                <p className="text-xs text-[var(--ink-soft)]">{priceCopy.price}</p>
                <p className="text-xs text-[var(--ink-soft)]">{priceCopy.disclaimer}</p>
                {engineTier === "premium" && !premiumEligible && (
                  <div className="flex flex-col gap-2 rounded-md border border-[var(--red)]/30 bg-[var(--red)]/6 p-3">
                    <p className="text-xs text-[var(--red)]">{priceCopy.ineligible}</p>
                    <CreditGateway />
                  </div>
                )}
              </div>
            );
          })()}

          {/* V2.3 — shared with the two-player setup screen: one rule for
              difficulty, recommendation and override. See BudgetPicker. */}
          <BudgetPicker
            difficulty={difficulty}
            onDifficultyChange={setDifficulty}
            budgetOverride={budgetOverride}
            onBudgetChange={setBudgetOverride}
            racer="ai"
            costs={entitlement.view?.costs ?? null}
            balance={entitlement.view?.balance ?? null}
            playState={entitlement.view?.play_state ?? null}
          />

          <button
            onClick={() => void submit()}
            // V2.8.8.7 — a courtesy only: the server enforces premium
            // eligibility authoritatively regardless of this. Disabling here
            // just avoids sending a request that would visibly refuse.
            disabled={
              !target || (engineTier === "premium" && entitlement.view?.premium_engine?.eligible !== true)
            }
            className="min-h-11 rounded-md bg-[var(--green)] px-4 py-2.5 text-sm font-medium text-[var(--parchment)] disabled:opacity-40"
          >
            Célpont rögzítése
          </button>
        </div>
      )}

      {view.step === "clarification_required" && (
        <div className="flex flex-col gap-3 rounded-md border border-[var(--red)]/30 bg-[var(--red)]/6 p-4">
          <p className="text-sm font-semibold text-[var(--ink)]">Javaslat, nem akadály</p>
          <p className="text-sm text-[var(--ink)]">{view.message}</p>

          {view.privateKnowledge && <PrivateTargetNote />}

          <p className="text-xs text-[var(--ink-soft)]">
            A titok a tiéd. Ha így akarsz játszani, indulhat — az AI-nak nehéz dolga
            lesz, de ez a te döntésed.
          </p>

          <div className="flex flex-col gap-2 sm:flex-row">
            <button
              onClick={() => void submit(true)}
              className="min-h-12 rounded-md bg-[var(--green)] px-5 py-3 text-base font-semibold text-[var(--parchment)]"
            >
              Mégis ezzel játszom
            </button>
            <button
              onClick={() => setView({ step: "entry" })}
              className="min-h-12 rounded-md border border-[var(--ink)]/25 px-5 py-3 text-base text-[var(--ink)]"
            >
              Másik titkot adok meg
            </button>
          </div>
        </div>
      )}

      {view.step === "invalid" && (
        <div className="flex flex-col gap-4 rounded-md border border-[var(--red)]/35 bg-[var(--red)]/8 p-4">
          <p className="text-sm text-[var(--red)]">{view.message}</p>
          <button
            onClick={() => {
              setTarget("");
              setClarification("");
              setView({ step: "entry" });
            }}
            className="min-h-11 self-start rounded-md border border-[var(--ink)]/25 px-4 py-2.5 text-sm"
          >
            Másik titkot adok meg
          </button>
        </div>
      )}

      {view.step === "error" && (
        <div className="flex flex-col gap-4 rounded-md border border-[var(--red)]/35 bg-[var(--red)]/8 p-4">
          <p className="text-sm text-[var(--red)]">{view.message}</p>
          {noCredit && entitlement.view?.play_state === "exhausted" && (
            <CreditGateway />
          )}
          {premiumIneligible && <CreditGateway />}
          <button
            onClick={() => setView({ step: "entry" })}
            className="min-h-11 self-start rounded-md border border-[var(--ink)]/25 px-4 py-2.5 text-sm"
          >
            Vissza
          </button>
        </div>
      )}

      {view.step === "valid" && (
        <div className="flex flex-col gap-3 rounded-md border border-[var(--green)]/30 bg-[var(--green)]/5 p-4">
          <p className="text-sm text-[var(--green)]">
            A titok rögzítve. Játékazonosító: <code className="break-all text-xs">{view.gameId}</code>
          </p>
          {view.privateKnowledge && <PrivateTargetNote />}
          {view.difficultyWarning && (
            <p className="text-xs text-[var(--red)]">⚠ {view.difficultyWarning}</p>
          )}
          <button
            onClick={() => router.push(`/game/${view.gameId}`)}
            className="min-h-11 self-start rounded-md bg-[var(--green)] px-4 py-2.5 text-sm font-medium text-[var(--parchment)]"
          >
            Kezdődhet
          </button>
        </div>
      )}
    </GameShell>
  );
}
