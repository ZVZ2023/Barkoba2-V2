import { NextRequest, NextResponse } from "next/server";
import { resolveActingPlayer } from "@/lib/actingPlayer";
import { createPurchaseRef, PURCHASE_REF_TTL_SECONDS } from "@/lib/purchaseRef";
import { env } from "@/lib/env";

// ---------------------------------------------------------------------------
// V2.4 — purchase intent. Step one of the adapter contract.
//
// Mints an opaque reference the player carries to the commercial adapter, so
// the adapter can name a Barkóba player without ever holding a player_id.
//
// ACCOUNT BEFORE PURCHASE. This route mints only for a live, revocable account
// session. A signed guest cookie or legacy protected-player cookie is not
// account authority, even though both may still name the same player_id.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const context = await resolveActingPlayer(req.headers);
  if (context.kind === "none") {
    return NextResponse.json(
      { error: "identity_unavailable", message: "Most nem érhető el a játékosazonosító." },
      { status: 409 }
    );
  }

  if (context.kind !== "account") {
    return NextResponse.json(
      {
        error: "account_required",
        message:
          "A vásárláshoz regisztrálj vagy jelentkezz be, hogy a VERSENY a fiókodhoz tartozzon.",
      },
      { status: 409 }
    );
  }

  const purchaseRef = await createPurchaseRef(context.playerId);
  let purchaseUrl: string;
  try {
    const url = new URL(env.dicsStorefrontUrl());
    if (url.protocol !== "https:") throw new Error("DICS storefront must use HTTPS");
    url.searchParams.set("purchase_ref", purchaseRef);
    purchaseUrl = url.toString();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[barkoba] invalid DICS_STOREFRONT_URL:", err);
    return NextResponse.json(
      { error: "purchase_unavailable", message: "A vásárlási oldal most nem érhető el." },
      { status: 503 }
    );
  }

  return NextResponse.json({
    purchase_ref: purchaseRef,
    purchase_url: purchaseUrl,
    // Where the adapter should send the player back to. Relative on purpose:
    // Barkóba does not know or care which host the adapter runs on.
    return_url: "/play?purchase=return",
    expires_in_seconds: PURCHASE_REF_TTL_SECONDS,
  });
}
