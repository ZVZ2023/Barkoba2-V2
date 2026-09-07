import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { PREMIUM_RACER_PROVIDER } from "../lib/racerEngineTier";

// ---------------------------------------------------------------------------
// V2.9.1.1 CORRECTION — a production smoke test found /privacy claiming that
// "the secret, its definition, the questions and the answers" are all sent
// to Anthropic's API. That was only ever true for the AI-Composer direction
// (AI invents the secret, answers your questions) and for the validation/
// adjudication/integrity steps every game goes through regardless of mode.
// It was never true for the OTHER direction (you set the secret, the AI
// asks the questions): that Racer opponent is xAI or OpenAI depending on
// engine tier, and it receives YOUR OWN answers — Anthropic never sees them.
//
// These tests cross-check the corrected copy against the actual provider
// wiring, in the same source-contract idiom as test/publicRacerAuthority
// .test.ts, so the two cannot silently drift apart again if a tier's
// provider is ever reassigned.
// ---------------------------------------------------------------------------

const PRIVACY = readFileSync("app/privacy/page.tsx", "utf8");
const CREATE_ROUTE = readFileSync("app/api/game/create/route.ts", "utf8");

function publicRacerProvider(): string {
  const m = CREATE_ROUTE.match(/const PUBLIC_RACER_PROVIDER: ModelProviderId = "([^"]+)";/);
  assert.ok(m, "PUBLIC_RACER_PROVIDER must be declared exactly this way (see test/publicRacerAuthority.test.ts)");
  return m![1]!;
}

const VENDOR_NAME: Record<string, string> = { xai: "xAI", openai: "OpenAI", anthropic: "Anthropic" };

/**
 * Scoped to the visible JSX section only — the file's own header comment
 * (read_me-style provenance notes) legitimately mentions "Érvelő AI" too,
 * which would otherwise false-positive an indexOf() run against the whole
 * file. Same fix pattern used elsewhere in this suite for comment
 * false-positives (e.g. test/betaCommunity.test.ts).
 */
const PROVIDER_SECTION = PRIVACY.slice(
  PRIVACY.indexOf('heading="Amit az AI-szolgáltatóknak elküldünk"'),
  PRIVACY.indexOf("</Section>", PRIVACY.indexOf('heading="Amit az AI-szolgáltatóknak elküldünk"'))
);

test("the privacy page names all three vendors actually reachable in production, not just Anthropic", () => {
  assert.match(PRIVACY, /Anthropic/);
  assert.match(PRIVACY, /xAI/);
  assert.match(PRIVACY, /OpenAI/);
});

test("the old single-vendor claim is gone", () => {
  assert.doesNotMatch(
    PRIVACY,
    /a titok, a meghatározása, a kérdések és a\s*\n?\s*válaszok — feldolgozásra elküldésre kerülnek az Anthropic API-jának/
  );
});

test("the standard ('Érvelő AI') tier's disclosed vendor matches PUBLIC_RACER_PROVIDER", () => {
  const provider = publicRacerProvider();
  const bulletAt = PROVIDER_SECTION.indexOf("Érvelő AI");
  assert.ok(bulletAt > 0, "the standard-tier label must appear in the AI-provider section");
  const bullet = PROVIDER_SECTION.slice(Math.max(0, bulletAt - 200), bulletAt + 50);
  assert.match(
    bullet,
    new RegExp(VENDOR_NAME[provider]!),
    `the 'Érvelő AI' bullet must name ${VENDOR_NAME[provider]} to match PUBLIC_RACER_PROVIDER ("${provider}")`
  );
});

test("the premium ('Emberi szintű AI') tier's disclosed vendor matches PREMIUM_RACER_PROVIDER", () => {
  const bulletAt = PROVIDER_SECTION.indexOf("Emberi szintű AI");
  assert.ok(bulletAt > 0, "the premium-tier label must appear in the AI-provider section");
  const bullet = PROVIDER_SECTION.slice(Math.max(0, bulletAt - 200), bulletAt + 50);
  assert.match(
    bullet,
    new RegExp(VENDOR_NAME[PREMIUM_RACER_PROVIDER]!),
    `the 'Emberi szintű AI' bullet must name ${VENDOR_NAME[PREMIUM_RACER_PROVIDER]} to match PREMIUM_RACER_PROVIDER ("${PREMIUM_RACER_PROVIDER}")`
  );
});

test("Anthropic's always-on role (validation/adjudication/integrity review, every game) is stated independent of mode", () => {
  assert.match(PROVIDER_SECTION, /minden játékban/, "Anthropic's validation/adjudication role must be stated as unconditional");
  assert.match(PROVIDER_SECTION, /függetlenül attól, ki gondolt rá/);
});

test("the AI-Composer direction (AI invents the secret, answers your questions) is still attributed to Anthropic", () => {
  assert.match(PROVIDER_SECTION, /Amikor az AI gondol valamire és te kérdezel/);
  assert.match(PROVIDER_SECTION, /Amikor az AI gondol valamire és te kérdezel[\s\S]*?Anthropic/);
});

test("no other existing privacy disclosure was disturbed by this correction", () => {
  assert.match(PRIVACY, /helyreállító kód/);
  assert.match(PRIVACY, /Regisztrált fiók törlését[^<]*nem kínálja fel/);
  assert.match(PRIVACY, /három funkcionális sütit/);
  assert.match(PRIVACY, /Digital Ice Cream-vásárlásnál/);
});

// ---------------------------------------------------------------------------
// SECOND CORRECTION — reviewer-specified exact wording, applied verbatim
// after independent verification against the audited payloads:
//   - lib/prompts/integrityReview.ts:158-198 sends the full qa_log
//     (questions AND answers) to Anthropic, conditionally (only when the
//     guess didn't land or the Composer conceded) — matching "kerülhetnek"
//     (may be forwarded), not an unconditional claim.
//   - lib/prompts/adjudicator.ts:149-188 receives only target/clarification/
//     guess, never the transcript — confirming the transcript-to-Anthropic
//     claim belongs to the integrity-review step, not adjudication.
//   - no player_id/display_name/balance field appears anywhere in
//     lib/prompts/*.ts or lib/racerState.ts (grepped directly), confirming
//     nothing account-related is separately attached to any AI request.
// ---------------------------------------------------------------------------

test("the third bullet also discloses that Integrity Review can forward questions and answers to Anthropic", () => {
  assert.match(
    PROVIDER_SECTION,
    /Ebben a kérdezési lépésben a válaszaid és magyarázataid az xAI-hoz vagy az OpenAI-hoz kerülnek\. A játék végi ellenőrzés során a kérdések és válaszok az Anthropicnak is továbbításra kerülhetnek\./
  );
  // The old, narrower ending sentence must be gone.
  assert.doesNotMatch(PROVIDER_SECTION, /ehhez a szolgáltatóhoz kerül, nem az Anthropichoz/);
});

test("the closing paragraph states no account data/name/balance is separately attached, with the personal-data-you-type caveat", () => {
  assert.match(
    PROVIDER_SECTION,
    /Az AI-szolgáltatóknak az adott játékbeli feladathoz szükséges szöveget\s*\n?\s*továbbítjuk\. A fiókadataidat, a regisztrált nevedet és a\s*\n?\s*VERSENY-egyenlegedet nem csatoljuk külön a kérésekhez\. Ha azonban\s*\n?\s*személyes adatot írsz a játék szövegébe, az a szöveggel együtt\s*\n?\s*továbbításra kerülhet\./
  );
  // The old, less specific paragraph must be gone.
  assert.doesNotMatch(PROVIDER_SECTION, /Minden esetben csak az adott lépéshez szükséges szöveg kerül/);
});
