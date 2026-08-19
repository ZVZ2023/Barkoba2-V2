import { getSql, type SqlClient } from "./corpus/db";
import type { DurablePlayer } from "./playerStore";

export interface PlayerAccount {
  player_id: string;
  recovery_key: string;
  display_name: string | null;
  created_at: string;
  registered_at: string;
}
function accountFromRow(row: Record<string, unknown> | undefined): PlayerAccount | null {
  if (!row || typeof row.player_id !== "string" || typeof row.recovery_key !== "string") {
    return null;
  }
  return {
    player_id: row.player_id,
    recovery_key: row.recovery_key,
    display_name: typeof row.display_name === "string" ? row.display_name : null,
    created_at: String(row.created_at),
    registered_at: String(row.registered_at),
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
    SELECT player_id, recovery_key, display_name, created_at, registered_at
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
    SELECT player_id, recovery_key, display_name, created_at, registered_at
      FROM accounts.players
     WHERE recovery_key = ${recoveryKey}
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
}): Promise<{ account: PlayerAccount; created: boolean }> {
  const sql = requireSql();
  const createdAt = input.createdAt ?? new Date().toISOString();
  const inserted = await sql`
    INSERT INTO accounts.players
      (player_id, recovery_key, display_name, created_at)
    VALUES
      (${input.playerId}, ${input.recoveryKey}, ${input.displayName}, ${createdAt})
    ON CONFLICT DO NOTHING
    RETURNING player_id, recovery_key, display_name, created_at, registered_at
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
