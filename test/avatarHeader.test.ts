import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// V2.8.4.3 — the avatar-display gap: the upload/save path (lib/photoUpload.ts,
// app/api/account/photo/route.ts, lib/playerAccounts.ts's photo_url column)
// worked; nothing downstream ever read photo_url. There were also THREE
// independent header implementations (SiteHeader/AccountControl on the home
// page and /play, GameShell on the new-game setup screens, and GameClient's
// own ad-hoc header during active play), none of which had ever been wired
// to it, and two of which (GameShell, GameClient) had no account control at
// all before this release.
//
// No rendering harness exists in this codebase (see
// test/resultScreenProfileLeak.test.ts's own note) — this proves the wiring
// from source, the established convention for exactly this situation.
// ---------------------------------------------------------------------------

const ACTING_PLAYER = readFileSync("lib/actingPlayer.ts", "utf8");
const AVATAR = readFileSync("app/components/Avatar.tsx", "utf8");
const ACCOUNT_CONTROL = readFileSync("app/components/AccountControl.tsx", "utf8");
const SITE_HEADER = readFileSync("app/components/SiteHeader.tsx", "utf8");
const PLAYER_AWARE_SITE_HEADER = readFileSync("app/components/PlayerAwareSiteHeader.tsx", "utf8");
const COMPOSER_ENTRY = readFileSync("app/ComposerEntry.tsx", "utf8");
const RACER_SETUP = readFileSync("app/RacerSetup.tsx", "utf8");
const COMPOSE_PAGE = readFileSync("app/compose/page.tsx", "utf8");
const PLAY_AI_PAGE = readFileSync("app/play/ai/page.tsx", "utf8");
const GAME_CLIENT = readFileSync("app/game/[id]/GameClient.tsx", "utf8");
const GAME_PAGE = readFileSync("app/game/[id]/page.tsx", "utf8");
const PROFILE_PHOTO_PROMPT = readFileSync("app/components/ProfilePhotoPrompt.tsx", "utf8");

// --- one shared implementation, not three -----------------------------------

test("there is exactly one Avatar component, imported by AccountControl (which every header surface renders)", () => {
  assert.match(ACCOUNT_CONTROL, /import Avatar from "\.\/Avatar"/);
  assert.match(ACCOUNT_CONTROL, /<Avatar photoUrl=\{authenticated \? photoUrl : null\} \/>/);
  // GameShell (new-game setup) and GameClient (active play) both reuse
  // AccountControl itself, not a second avatar widget.
  assert.match(COMPOSER_ENTRY, /import AccountControl from "\.\/components\/AccountControl"/);
  assert.match(RACER_SETUP, /import AccountControl from "\.\/components\/AccountControl"/);
  assert.match(GAME_CLIENT, /import AccountControl from "@\/app\/components\/AccountControl"/);
});

// --- 15: the authenticated player's photo reaches every header surface ----

test("15. resolveAccountHeaderState resolves identity the SAME way as every other acting-player lookup — never a caller-supplied id", () => {
  const fn = ACTING_PLAYER.slice(ACTING_PLAYER.indexOf("export async function resolveAccountHeaderState"));
  assert.match(fn, /headers: Headers/, "the only input is the request's own headers, exactly like resolveActingPlayer");
  assert.match(fn, /const context = await resolveActingPlayer\(headers\)/);
  assert.doesNotMatch(fn, /playerId:\s*string(?!\s*=)/, "must not accept a caller-supplied player id parameter");
});

test("15b. only 'account' and 'registered' kinds get a photo lookup — a guest or unidentified visitor gets null, never a lookup", () => {
  const fn = ACTING_PLAYER.slice(
    ACTING_PLAYER.indexOf("export async function resolveAccountHeaderState"),
    ACTING_PLAYER.length
  );
  assert.match(fn, /context\.kind !== "account" && context\.kind !== "registered"/);
  assert.match(fn, /return \{ authenticated, photoUrl: null \};/);
  assert.match(fn, /getPlayerAccount\(context\.playerId\)/);
});

test("15c. PlayerAwareSiteHeader -> SiteHeader -> AccountControl all thread photoUrl (home page, /play)", () => {
  assert.match(PLAYER_AWARE_SITE_HEADER, /resolveAccountHeaderState/);
  assert.match(PLAYER_AWARE_SITE_HEADER, /<SiteHeader[\s\S]*photoUrl=\{photoUrl\}/);
  assert.match(SITE_HEADER, /photoUrl\?: string \| null/);
  assert.match(SITE_HEADER, /<AccountControl authenticated=\{accountAuthenticated\} photoUrl=\{photoUrl\} \/>/);
});

test("15d. the new-game setup screens (ComposerEntry, RacerSetup / GameShell) receive and render the same account state", () => {
  assert.match(COMPOSE_PAGE, /resolveAccountHeaderState/);
  assert.match(PLAY_AI_PAGE, /resolveAccountHeaderState/);
  assert.match(COMPOSER_ENTRY, /accountAuthenticated\?: boolean/);
  assert.match(COMPOSER_ENTRY, /accountPhotoUrl\?: string \| null/);
  assert.match(COMPOSER_ENTRY, /meta=\{<AccountControl authenticated=\{accountAuthenticated\} photoUrl=\{accountPhotoUrl\} \/>\}/);
  assert.match(RACER_SETUP, /meta=\{<AccountControl authenticated=\{accountAuthenticated\} photoUrl=\{accountPhotoUrl\} \/>\}/);
});

test("15e. the active-game screen (GameClient) receives and renders the same account state, resolved server-side by its page", () => {
  assert.match(GAME_PAGE, /resolveAccountHeaderState/);
  assert.match(GAME_CLIENT, /accountAuthenticated\?: boolean/);
  assert.match(GAME_CLIENT, /accountPhotoUrl\?: string \| null/);
  assert.match(GAME_CLIENT, /<AccountControl authenticated=\{accountAuthenticated\} photoUrl=\{accountPhotoUrl\} \/>/);
});

test("15f. a lookup failure fails closed to no photo rather than breaking the header", () => {
  const fn = ACTING_PLAYER.slice(ACTING_PLAYER.indexOf("export async function resolveAccountHeaderState"));
  assert.match(fn, /catch \(err\)/);
  assert.match(fn, /return \{ authenticated, photoUrl: null \};/);
});

// --- 16: missing/broken photo falls back safely -----------------------------

test("16. Avatar falls back to the generic glyph when there is no photo", () => {
  assert.match(AVATAR, /if \(!photoUrl \|\| failed\)/);
  assert.match(AVATAR, /👤/);
});

test("16b. Avatar falls back the moment the image fails to load, and un-sticks on a new URL", () => {
  assert.match(AVATAR, /onError=\{\(\) => setFailed\(true\)\}/);
  assert.match(AVATAR, /useEffect\(\(\) => \{\s*setFailed\(false\);\s*\}, \[photoUrl\]\);/);
});

test("16c. circular, cropped presentation", () => {
  assert.match(AVATAR, /rounded-full/);
  assert.match(AVATAR, /object-cover/);
});

test("16d. an unauthenticated control never shows a photo even if one is passed in", () => {
  assert.match(ACCOUNT_CONTROL, /<Avatar photoUrl=\{authenticated \? photoUrl : null\} \/>/);
});

// --- 17: refresh after upload updates the header ----------------------------

test("17. a successful photo upload triggers a router refresh, so the server-rendered header re-fetches", () => {
  assert.match(PROFILE_PHOTO_PROMPT, /import \{ useRouter \} from "next\/navigation"/);
  assert.match(PROFILE_PHOTO_PROMPT, /const router = useRouter\(\)/);
  const uploadFn = PROFILE_PHOTO_PROMPT.slice(
    PROFILE_PHOTO_PROMPT.indexOf("async function upload()"),
    PROFILE_PHOTO_PROMPT.indexOf("return (")
  );
  assert.match(uploadFn, /setUploadedUrl\(data\.photo_url\)/);
  assert.match(uploadFn, /router\.refresh\(\);/);
  // The refresh must follow a CONFIRMED success (after setUploadedUrl), not
  // fire unconditionally before the request even completes.
  assert.ok(
    uploadFn.indexOf("setUploadedUrl(data.photo_url)") < uploadFn.indexOf("router.refresh();"),
    "refresh must happen after the upload is confirmed successful"
  );
});

// --- never another player's photo, no public unauthenticated lookup --------

test("no route exposes a photo lookup by an arbitrary/caller-supplied player id", () => {
  const photoRoute = readFileSync("app/api/account/photo/route.ts", "utf8");
  assert.match(photoRoute, /resolveActingPlayer\(req\.headers\)/, "identity comes from the request's own session");
  assert.doesNotMatch(photoRoute, /req\.(query|nextUrl)\.[a-zA-Z]*\(?["'`]?player_?[Ii]d/, "no player id read from the request itself");
});
