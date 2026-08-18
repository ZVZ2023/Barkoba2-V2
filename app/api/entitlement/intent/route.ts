import { NextRequest, NextResponse } from "next/server";
import { playerIdFromHeaders } from "@/lib/playerIdentity";
import { getDurablePlayer } from "@/lib/playerStore";
import { createPurchaseRef, PURCHASE_REF_TTL_SECONDS } from "@/lib/purchaseRef";
import { env } from "@/lib/env";

// ---------------------------------------------------------------------------
// V2.4 — purchase intent. Step one of the adapter contract.
//
// Mints an opaque reference the player carries to the commercial adapter, so
// the adapter can name a Barkóba player without ever holding a player_id.
//
// CLAIM BEFORE PURCHASE (design decision, Option C). This route REFUSES to mint
// a reference for a player who has no recovery credential. That is what makes
// the rule structural rather than a matter of UI sequencing: purchased value
// can only ever attach to an identity the player can get back, and Barkóba
// never has to store a raw credential to make that true.
//
// The consequence is deliberate — grantPurchase()'s silent-claim branch should
// never fire on this path. If it ever does, a player reached purchase without
// being claimed, and that is a sequencing bug worth surfacing rather than
// absorbing.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const playerId = playerIdFromHeaders(req.headers);
  if (!playerId) {
    return NextResponse.json(
      { error: "identity_unavailable", message: "Most nem érhető el a játékosazonosító." },
      { status: 409 }
    );
  }

  const durable = await getDurablePlayer(playerId);
  if (!durable) {
    return NextResponse.json(
      {
        error: "claim_required",
        message:
          "Előbb mentsd el a játékosodat, hogy a RACES-egyenleged később is a tiéd maradjon.",
      },
      { status: 409 }
    );
  }

  const purchaseRef = await createPurchaseRef(playerId);
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
