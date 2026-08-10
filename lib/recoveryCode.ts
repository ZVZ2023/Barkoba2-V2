// ---------------------------------------------------------------------------
// Recovery code — V2.1.3.0.
//
// A domain-independent bearer credential that lets a Player recover their
// existing identity on another browser or device. Chosen over passkeys because
// Barkoba's permanent production domain is not settled, and a passkey is bound
// to the domain it was registered on: every claimed identity would be orphaned
// by a later move. A printed string is bound to nothing.
//
// FORMAT
//   BARKOBA-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX
//
//   15 random bytes = 120 bits.
//   24 Crockford base32 characters x 5 bits = 120 bits.
//
// Those two numbers are equal on purpose: 15 bytes divides evenly into base32,
// so there is no truncation and no padding remainder. The number quoted is the
// number actually generated. 16 bytes would need 26 characters and leave an
// awkward tail.
//
// The BARKOBA prefix carries no entropy. It exists so a player who finds the
// string in a note six months later knows what it is.
//
// WHY A PLAIN SHA-256, UNSALTED
// The usual objection to a fast unsalted hash applies to LOW-entropy secrets,
// where an attacker enumerates the input space offline. That is the password
// problem. A 120-bit random code has no enumerable space, so the speed of the
// hash is irrelevant — there is nothing to guess. Salting would also break the
// design outright: the hash must be derivable from the code alone, because it
// IS the lookup key. And because no server-side secret participates, recovery
// keeps working across any future rotation of PLAYER_ID_SECRET.
// ---------------------------------------------------------------------------

/** Crockford base32: no I, L, O or U, so nothing is ambiguous read aloud. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const PREFIX = "BARKOBA";
const CODE_BYTES = 15;
const CODE_CHARS = 24;
const GROUP = 4;

/** Exactly what it says, and it is checked against the generator in tests. */
export const RECOVERY_CODE_ENTROPY_BITS = CODE_BYTES * 8;

function encodeCrockford(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return out;
}

/** The printable code, shown to the player exactly once. */
export function generateRecoveryCode(): string {
  const bytes = new Uint8Array(CODE_BYTES);
  crypto.getRandomValues(bytes);
  const body = encodeCrockford(bytes);
  const groups: string[] = [];
  for (let i = 0; i < body.length; i += GROUP) groups.push(body.slice(i, i + GROUP));
  return `${PREFIX}-${groups.join("-")}`;
}

/**
 * Reduce anything a player might reasonably type back to the canonical body.
 *
 * People retype these from paper. They lowercase them, drop the dashes, add
 * spaces, and confuse O with 0. Crockford exists precisely to absorb the last
 * of those. Getting this wrong rejects legitimate codes, which is the worst
 * possible failure for a credential that cannot be reissued.
 *
 * Order matters: the prefix is stripped BEFORE the O->0 substitution, or
 * "BARKOBA" would become "BARK0BA" and stop matching.
 */
export function normalizeRecoveryCode(raw: string): string {
  let s = (raw || "").toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (s.startsWith(PREFIX)) s = s.slice(PREFIX.length);
  return s.replace(/O/g, "0").replace(/[IL]/g, "1");
}

/** Is this even the right shape? Cheap pre-check before touching storage. */
export function looksLikeRecoveryCode(raw: string): boolean {
  const body = normalizeRecoveryCode(raw);
  if (body.length !== CODE_CHARS) return false;
  for (const ch of body) if (!ALPHABET.includes(ch)) return false;
  return true;
}

/**
 * SHA-256 of the normalized body, hex. This value is the storage key for the
 * recovery record. The raw code is never stored anywhere.
 *
 * There is no comparison step and therefore no timing side channel to close:
 * the lookup either finds a key or does not.
 */
export async function recoveryKey(raw: string): Promise<string> {
  const body = normalizeRecoveryCode(raw);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
