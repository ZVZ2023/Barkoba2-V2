// ---------------------------------------------------------------------------
// V2.1.1 — anonymous persistent Player identity.
//
// The Player is a signed opaque identifier held by the client. There is no
// players table, no player record, and no durable identity store: the cookie
// IS the identity, and the signature is what makes it trustworthy.
//
// WHY SIGNED RATHER THAN A BARE RANDOM ID
// A bare id in a cookie is client-asserted — anyone can set it to any value.
// Today nothing is attached to a Player, so forging one buys nothing. But
// V2.4 attaches credits and entitlements to this identifier, and an id that
// was ever forgeable is a poor foundation for that. Signing now costs a few
// lines; retrofitting it later invalidates every player already in the wild.
//
// WHY WEB CRYPTO RATHER THAN node:crypto
// This module is imported by middleware.ts, which Next runs on the Edge
// runtime. node:crypto does not exist there. crypto.subtle and
// crypto.getRandomValues do, and are also present in Node 22, so the same code
// serves middleware, route handlers and tests.
//
// This module must never import game state, secrets, or storage. It is pure.
// ---------------------------------------------------------------------------

export const PLAYER_COOKIE = "bk_player";

/** ~13 months. Matches the cookie lifetime; there is nothing else to expire. */
export const PLAYER_COOKIE_MAX_AGE = 400 * 24 * 60 * 60;

const SECRET_ENV = "PLAYER_ID_SECRET";

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * The signing secret. Absent means identity is DISABLED, not that identity is
 * unsigned: minting an unsigned id would create exactly the forgeable
 * identifier this design exists to avoid. A misconfigured deployment loses
 * player identity and keeps a fully playable game, which is the safe failure.
 */
export function identityConfigured(): boolean {
  return typeof process !== "undefined" && !!process.env[SECRET_ENV];
}

function secret(): string {
  const v = process.env[SECRET_ENV];
  if (!v) throw new Error(`Missing ${SECRET_ENV}`);
  return v;
}

async function sign(playerId: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(playerId));
  return base64url(new Uint8Array(sig));
}

/** Length-independent comparison. Never short-circuit on the first bad byte. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 128 bits of randomness, hex. Opaque: it encodes nothing about the player. */
export function mintPlayerId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

const ID_SHAPE = /^[0-9a-f]{32}$/;

/** Cookie value: `<id>.<signature>`. */
export async function issuePlayerCookie(playerId?: string): Promise<{
  playerId: string;
  value: string;
}> {
  const id = playerId ?? mintPlayerId();
  return { playerId: id, value: `${id}.${await sign(id)}` };
}

/**
 * Returns the player id only when the value carries a signature this server
 * produced. A tampered, truncated, or foreign-signed cookie returns null and is
 * treated exactly like no cookie at all — the visitor gets a fresh identity
 * rather than an error.
 */
export async function verifyPlayerCookie(value: string | undefined): Promise<string | null> {
  if (!value || !identityConfigured()) return null;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return null;

  const id = value.slice(0, dot);
  const provided = value.slice(dot + 1);
  if (!ID_SHAPE.test(id) || provided.length === 0) return null;

  return constantTimeEqual(provided, await sign(id)) ? id : null;
}

/** Cookie attributes. httpOnly because nothing client-side needs to read it. */
export function playerCookieOptions(isSecure: boolean) {
  return {
    httpOnly: true,
    secure: isSecure,
    sameSite: "lax" as const,
    path: "/",
    maxAge: PLAYER_COOKIE_MAX_AGE,
  };
}


/**
 * Header middleware uses to hand the acting Player to a route handler.
 *
 * Needed because middleware sets the cookie on the RESPONSE: on the very first
 * request the browser has not received it yet, so the handler would see no
 * player. Middleware therefore also forwards the id inward on this header.
 *
 * It is trusted ONLY because middleware unconditionally strips any inbound
 * copy before setting its own. A client that sends this header has it deleted.
 */
export const PLAYER_HEADER = "x-bk-player";

/** The acting player for this request, or null when identity is unavailable. */
export function playerIdFromHeaders(headers: Headers): string | null {
  const v = headers.get(PLAYER_HEADER);
  return v && ID_SHAPE.test(v) ? v : null;
}
