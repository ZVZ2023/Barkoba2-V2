import { __setSqlClientForTests, type SqlClient } from "../../lib/corpus/db";

// ---------------------------------------------------------------------------
// V2.8.6 R1 — every mutating gameplay route (/ask, /turn, /clue, /correct)
// now resolves its caller through lib/actingPlayer.ts's
// resolveActingPlayerId, which — even for an ordinary guest header — always
// checks accounts.players to see whether that guest id has since
// registered. That lookup requires a working SQL client; with none
// configured (the ordinary state for this test run: no DATABASE_URL), it
// throws, and resolveActingPlayer's own fail-closed catch then reports "no
// identity" for EVERY caller, guest or not. That is the correct production
// behavior (an auth-storage outage must never silently grant authority) but
// it means any test exercising a real caller identity through these routes
// needs a working, if trivial, SQL client — the same seam
// test/entitlements.test.ts already established via __setSqlClientForTests.
// This module reuses that seam rather than reinventing it: every query gets
// an empty result set, since no fixture in these gameplay tests is ever a
// registered account — "not found" is the honest answer they all need.
// ---------------------------------------------------------------------------

const NOOP_SQL: SqlClient = Object.assign(
  async (_strings: TemplateStringsArray, ..._values: unknown[]) => [] as Record<string, unknown>[],
  {
    transaction: async (queries: Promise<Record<string, unknown>[]>[]) => Promise.all(queries),
  }
);

/**
 * Call once, at module scope, in any test file whose fixtures need
 * resolveActingPlayerId to actually resolve a header-supplied guest id
 * instead of failing closed. Each test file is its own process under this
 * repo's `node --test` run, so there is no cross-file leakage to guard
 * against with per-test setup/teardown.
 */
export function enableTestIdentityLookups(): void {
  process.env.DATABASE_URL = "postgresql://u:p@fake.tld/db";
  process.env.CORPUS_ENABLED = "true";
  __setSqlClientForTests(NOOP_SQL);
}

/** A syntactically valid 32-hex-char player id — playerIdentity.ts's ID_SHAPE. */
export function testPlayerId(fillHexChar: string): string {
  return fillHexChar.repeat(32);
}

/** The header lib/playerIdentity.ts's PLAYER_HEADER names, ready to spread into a NextRequest's headers. */
export function playerHeader(playerId: string): Record<string, string> {
  return { "x-bk-player": playerId };
}
