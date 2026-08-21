import { NextResponse } from "next/server";
import { resolveActingPlayer } from "@/lib/actingPlayer";
import { rotateRecoveryKey } from "@/lib/playerAccounts";
import { generateRecoveryCode, recoveryKey } from "@/lib/recoveryCode";

export const dynamic = "force-dynamic";

const PRIVATE_NO_STORE = { "Cache-Control": "private, no-store" };

/**
 * TASK — recovery code rotation. A lost-but-not-yet-locked-out code, or a
 * player who simply wants a fresh one, gets a new credential without
 * abandoning the account (that path is reset-identity, and is for when the
 * old code is already gone).
 *
 * Same safety pattern as reset-identity: requires the strongest identity
 * this app has — an ACTIVE SESSION, not merely a registered player_id — and
 * touches nothing but the one credential column. player_id, the ledger, and
 * unlimited_play are never referenced by this route or by
 * rotateRecoveryKey's query.
 */
export async function POST(req: Request) {
  const context = await resolveActingPlayer(req.headers);
  if (context.kind !== "account") {
    return NextResponse.json(
      {
        error: "account_required",
        message: "A kód cseréjéhez be kell jelentkezned.",
      },
      { status: 401, headers: PRIVATE_NO_STORE }
    );
  }

  const newCode = generateRecoveryCode();
  let rotated: boolean;
  try {
    const hash = await recoveryKey(newCode);
    rotated = await rotateRecoveryKey(context.playerId, hash);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[barkoba] recovery code rotation failed:", err);
    return NextResponse.json(
      { error: "rotation_failed", message: "A kód cseréje most nem sikerült." },
      { status: 503, headers: PRIVATE_NO_STORE }
    );
  }

  if (!rotated) {
    return NextResponse.json(
      { error: "rotation_failed", message: "A kód cseréje most nem sikerült." },
      { status: 503, headers: PRIVATE_NO_STORE }
    );
  }

  return NextResponse.json(
    {
      rotated: true,
      recovery_code: newCode,
      message: "Mentsd el ezt az új kódot — a régi mostantól nem működik.",
    },
    { headers: PRIVATE_NO_STORE }
  );
}
