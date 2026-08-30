import { getSql } from "./corpus/db";

export const ACCOUNT_SESSION_COOKIE = "bk_account_session";
export const ACCOUNT_SESSION_MAX_AGE = 30 * 24 * 60 * 60;

const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

function base64url(bytes: Uint8Array): string {
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function generateAccountSessionToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

export async function accountSessionHash(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function accountSessionCookieOptions(isSecure: boolean) {
  return {
    httpOnly: true,
    secure: isSecure,
    sameSite: "lax" as const,
    path: "/",
    maxAge: ACCOUNT_SESSION_MAX_AGE,
  };
}

export function accountSessionTokenFromHeaders(headers: Headers): string | null {
  const cookie = headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName !== ACCOUNT_SESSION_COOKIE) continue;
    const value = rawValue.join("=");
    if (!TOKEN_SHAPE.test(value)) return null;
    return value;
  }
  return null;
}

export async function createAccountSession(playerId: string): Promise<string> {
  const sql = getSql();
  if (!sql) throw new Error("accounts: no database client");
  const token = generateAccountSessionToken();
  const hash = await accountSessionHash(token);
  const expiresAt = new Date(Date.now() + ACCOUNT_SESSION_MAX_AGE * 1000).toISOString();
  const rows = await sql`
    INSERT INTO accounts.player_sessions (session_hash, player_id, expires_at)
    SELECT ${hash}, player_id, ${expiresAt}
      FROM accounts.players
     WHERE player_id = ${playerId}
       AND disabled_at IS NULL
    RETURNING player_id
  `;
  if (rows.length !== 1) throw new Error("accounts: cannot create session for player");
  return token;
}

export async function resolveAccountSession(token: string | null): Promise<string | null> {
  if (!token || !TOKEN_SHAPE.test(token)) return null;
  const sql = getSql();
  if (!sql) throw new Error("accounts: no database client");
  const hash = await accountSessionHash(token);
  const rows = await sql`
    SELECT s.player_id
      FROM accounts.player_sessions s
      JOIN accounts.players p ON p.player_id = s.player_id
     WHERE s.session_hash = ${hash}
       AND s.revoked_at IS NULL
       AND s.expires_at > now()
       AND p.disabled_at IS NULL
     LIMIT 1
  `;
  const playerId = rows[0]?.player_id;
  return typeof playerId === "string" ? playerId : null;
}

export async function revokeAccountSession(token: string | null): Promise<void> {
  if (!token || !TOKEN_SHAPE.test(token)) return;
  const sql = getSql();
  if (!sql) throw new Error("accounts: no database client");
  const hash = await accountSessionHash(token);
  await sql`
    UPDATE accounts.player_sessions
       SET revoked_at = COALESCE(revoked_at, now())
     WHERE session_hash = ${hash}
  `;
}
