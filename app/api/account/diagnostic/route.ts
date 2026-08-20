import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { resolveActingPlayer } from "@/lib/actingPlayer";
import { getPlayerAccount } from "@/lib/playerAccounts";
import { corpusConfigStatus } from "@/lib/corpus/db";
import {
  canStartGame,
  entitlementStatus,
  getStatus,
  inspectUnlimitedPlay,
  resolvePlayState,
} from "@/lib/entitlements";

export const dynamic = "force-dynamic";

const PRIVATE_NO_STORE = { "Cache-Control": "private, no-store" };

function fingerprint(playerId: string): string {
  return createHash("sha256").update(playerId).digest("hex").slice(0, 12);
}

/** Temporary, authenticated, read-only TASK 6G production diagnostic. */
export async function GET(req: Request) {
  const context = await resolveActingPlayer(req.headers);
  if (context.kind !== "account") {
    return NextResponse.json(
      {
        diagnostic: "task6g",
        authenticated: false,
        identity_kind: context.kind,
      },
      { status: 401, headers: PRIVATE_NO_STORE }
    );
  }

  const playerId = context.playerId;
  const runtime = entitlementStatus();
  const [account, unlimited, gamePrecheck] = await Promise.all([
    getPlayerAccount(playerId).catch(() => null),
    inspectUnlimitedPlay(playerId),
    canStartGame(playerId),
  ]);

  let entitlement:
    | { lookup: "ok"; balance: number; play_state: ReturnType<typeof resolvePlayState> }
    | { lookup: "error" };
  try {
    const status = await getStatus(playerId);
    entitlement = {
      lookup: "ok",
      balance: status.balance,
      play_state: resolvePlayState({
        unlimited: unlimited.active,
        balance: status.balance,
        complimentaryGrant: runtime.complimentaryGrant,
        initialComplimentaryGranted: status.initial_complimentary_granted,
      }),
    };
  } catch {
    entitlement = { lookup: "error" };
  }

  const database = corpusConfigStatus();
  return NextResponse.json(
    {
      diagnostic: "task6g",
      authenticated: true,
      identity_kind: context.kind,
      player_fingerprint: fingerprint(playerId),
      account: {
        found: account !== null,
        display_name: account?.display_name ?? null,
        registered_at: account?.registered_at ?? null,
      },
      database: {
        configured: database.configured,
        host: database.host,
        database: database.database,
      },
      unlimited_lookup: unlimited,
      entitlement,
      game_creation_precheck: gamePrecheck,
    },
    { headers: PRIVATE_NO_STORE }
  );
}
