import { getKV } from "./kv";
import { env } from "./env";

// ---------------------------------------------------------------------------
// V2.3 — invitation codes for Human↔Human games.
//
// The smallest coherent join mechanism: one Redis key mapping a short code to a
// game id, with the same TTL as the game itself. No matchmaking, no lobby, no
// discovery — the Composer sends a link to one person.
//
//   join:<CODE>  ->  { game_id }
//
// The alphabet is Crockford Base32, reused from lib/recoveryCode.ts, so a code
// read aloud or retyped survives the usual confusions (no I, L, O or U). Eight
// characters is 40 bits — far beyond guessing for a key that lives 24h and is
// consumed on first use, and short enough to dictate over a phone.
//
// WHY NOT JUST USE THE GAME ID AS THE INVITATION: the game id is also the URL
// of the game itself, so it is visible to both players for the whole game and
// ends up in history and screenshots. A separate code can be invalidated the
// moment the Racer joins, which is what makes "no third player" enforceable
// rather than merely unlikely.
// ---------------------------------------------------------------------------

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 8;

interface JoinRecord {
  game_id: string;
}

function joinKey(code: string): string {
  return `join:${code}`;
}

/** Uppercase, stripped of spaces and dashes so a retyped code still resolves. */
export function normalizeJoinCode(raw: string): string {
  return raw.toUpperCase().replace(/[^0-9A-Z]/g, "");
}

export function generateJoinCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

export async function createJoinCode(gameId: string): Promise<string> {
  const code = generateJoinCode();
  await getKV().set<JoinRecord>(joinKey(code), { game_id: gameId }, env.gameTtlSeconds());
  return code;
}

/** Null covers wrong, expired and already-consumed codes alike. */
export async function resolveJoinCode(rawCode: string): Promise<string | null> {
  const code = normalizeJoinCode(rawCode);
  if (code.length !== CODE_LENGTH) return null;
  const hit = await getKV().get<JoinRecord>(joinKey(code));
  return hit?.game_id ?? null;
}

/**
 * Burn the code once the Racer seat is taken.
 *
 * Best-effort by design: the authoritative guard against a third player is
 * `racer_player_id` already being set on the game, checked inside the join
 * route. This just stops a stale link from reaching a "game is full" screen.
 */
export async function consumeJoinCode(rawCode: string): Promise<void> {
  await getKV().del(joinKey(normalizeJoinCode(rawCode)));
}
