import { getSql, type SqlClient } from "./corpus/db";
import type { DurablePlayer } from "./playerStore";

export interface PlayerAccount {
  player_id: string;
  recovery_key: string;
  display_name: string | null;
  created_at: string;
  registered_at: string;
  /** V2.6.x. Null for every account registered before email existed, and grandfathered as such. */
  email: string | null;
  email_verified_at: string | null;
  /** The verification token's HASH, exactly like recovery_key holds a hash despite its name. */
  email_verification_token: string | null;
  email_verification_expires_at: string | null;
  photo_url: string | null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function accountFromRow(row: Record<string, unknown> | undefined): PlayerAccount | null {
  if (!row || typeof row.player_id !== "string" || typeof row.recovery_key !== "string") {
    return null;
  }
  return {
    player_id: row.player_id,
    recovery_key: row.recovery_key,
    display_name: nullableString(row.display_name),
    created_at: String(row.created_at),
    registered_at: String(row.registered_at),
    email: nullableString(row.email),
    email_verified_at: nullableString(row.email_verified_at),
    email_verification_token: nullableString(row.email_verification_token),
    email_verification_expires_at: nullableString(row.email_verification_expires_at),
    photo_url: nullableString(row.photo_url),
  };
}

function requireSql(): SqlClient {
  const sql = getSql();
  if (!sql) throw new Error("accounts: no database client");
  return sql;
}

export async function getPlayerAccount(playerId: string): Promise<PlayerAccount | null> {
  const sql = requireSql();
  const rows = await sql`
    SELECT player_id, recovery_key, display_name, created_at, registered_at,
           email, email_verified_at, email_verification_token, email_verification_expires_at, photo_url
      FROM accounts.players
     WHERE player_id = ${playerId}
       AND disabled_at IS NULL
     LIMIT 1
  `;
  return accountFromRow(rows[0]);
}

export async function getPlayerAccountByRecoveryKey(
  recoveryKey: string
): Promise<PlayerAccount | null> {
  const sql = requireSql();
  const rows = await sql`
    SELECT player_id, recovery_key, display_name, created_at, registered_at,
           email, email_verified_at, email_verification_token, email_verification_expires_at, photo_url
      FROM accounts.players
     WHERE recovery_key = ${recoveryKey}
       AND disabled_at IS NULL
     LIMIT 1
  `;
  return accountFromRow(rows[0]);
}

/**
 * Looks up an account by its PENDING verification token's hash. Returns null
 * once the row's token has been cleared or was never set — this function
 * makes no expiry judgement of its own; the caller (the verify-email route)
 * reads email_verification_expires_at and decides.
 */
export async function getPlayerAccountByVerificationTokenHash(
  tokenHash: string
): Promise<PlayerAccount | null> {
  const sql = requireSql();
  const rows = await sql`
    SELECT player_id, recovery_key, display_name, created_at, registered_at,
           email, email_verified_at, email_verification_token, email_verification_expires_at, photo_url
      FROM accounts.players
     WHERE email_verification_token = ${tokenHash}
       AND disabled_at IS NULL
     LIMIT 1
  `;
  return accountFromRow(rows[0]);
}

export async function registerPlayerAccount(input: {
  playerId: string;
  recoveryKey: string;
  displayName: string | null;
  createdAt?: string;
  /** V2.6.x. Omitted (not merely null) by the legacy-migration path, which has no email to offer. */
  email?: string | null;
  emailVerificationTokenHash?: string | null;
  emailVerificationExpiresAt?: string | null;
}): Promise<{ account: PlayerAccount; created: boolean }> {
  const sql = requireSql();
  const createdAt = input.createdAt ?? new Date().toISOString();
  const email = input.email ?? null;
  const emailVerificationTokenHash = input.emailVerificationTokenHash ?? null;
  const emailVerificationExpiresAt = input.emailVerificationExpiresAt ?? null;
  const inserted = await sql`
    INSERT INTO accounts.players
      (player_id, recovery_key, display_name, created_at,
       email, email_verification_token, email_verification_expires_at)
    VALUES
      (${input.playerId}, ${input.recoveryKey}, ${input.displayName}, ${createdAt},
       ${email}, ${emailVerificationTokenHash}, ${emailVerificationExpiresAt})
    ON CONFLICT DO NOTHING
    RETURNING player_id, recovery_key, display_name, created_at, registered_at,
              email, email_verified_at, email_verification_token, email_verification_expires_at, photo_url
  `;
  const created = accountFromRow(inserted[0]);
  if (created) return { account: created, created: true };

  const existing = await getPlayerAccount(input.playerId);
  if (!existing || existing.recovery_key !== input.recoveryKey) {
    throw new Error("accounts: player or recovery credential already registered");
  }
  return { account: existing, created: false };
}

export async function migrateLegacyPlayer(record: DurablePlayer): Promise<PlayerAccount> {
  const result = await registerPlayerAccount({
    playerId: record.player_id,
    recoveryKey: record.recovery_key,
    displayName: record.display_name,
    createdAt: record.created_at,
  });
  return result.account;
}

export async function setAccountDisplayName(
  playerId: string,
  displayName: string | null
): Promise<void> {
  const sql = requireSql();
  await sql`
    UPDATE accounts.players
       SET display_name = ${displayName}
     WHERE player_id = ${playerId}
       AND disabled_at IS NULL
  `;
}

/**
 * Replace the account's recovery credential in place. Touches exactly this
 * one column: player_id, display_name, created_at and registered_at are
 * untouched, and the ledger and unlimited_play tables are not referenced by
 * this query at all. The old code stops working the instant this commits —
 * recovery_key IS the lookup key, so overwriting it is the invalidation.
 *
 * Returns false (rather than throwing) for a disabled or already-vanished
 * account, so the route can answer honestly without a second lookup.
 */
export async function rotateRecoveryKey(
  playerId: string,
  newRecoveryKey: string
): Promise<boolean> {
  const sql = requireSql();
  const rows = await sql`
    UPDATE accounts.players
       SET recovery_key = ${newRecoveryKey}
     WHERE player_id = ${playerId}
       AND disabled_at IS NULL
     RETURNING player_id
  `;
  return rows.length === 1;
}

/**
 * Marks the account's email verified. Idempotent by construction —
 * COALESCE preserves the FIRST verification timestamp, so a still-valid link
 * clicked twice (a double click, an email client prefetching it) is a
 * harmless no-op rather than an error, and repeat hits never bump the
 * recorded moment of verification.
 *
 * Deliberately does NOT clear email_verification_token or its expiry: see
 * migration 0010's header comment for why leaving them in place is the
 * point, not an oversight.
 */
export async function markEmailVerified(playerId: string): Promise<boolean> {
  const sql = requireSql();
  const rows = await sql`
    UPDATE accounts.players
       SET email_verified_at = COALESCE(email_verified_at, now())
     WHERE player_id = ${playerId}
       AND disabled_at IS NULL
     RETURNING player_id
  `;
  return rows.length === 1;
}

/** Sets or clears the account's profile photo URL. Touches only this column. */
export async function setAccountPhotoUrl(
  playerId: string,
  photoUrl: string | null
): Promise<boolean> {
  const sql = requireSql();
  const rows = await sql`
    UPDATE accounts.players
       SET photo_url = ${photoUrl}
     WHERE player_id = ${playerId}
       AND disabled_at IS NULL
     RETURNING player_id
  `;
  return rows.length === 1;
}
