import { NextRequest, NextResponse } from "next/server";
import { resolveActingPlayer } from "@/lib/actingPlayer";
import { getPlayerAccount } from "@/lib/playerAccounts";
import { createPurchaseRef, PURCHASE_REF_TTL_SECONDS } from "@/lib/purchaseRef";
import { knownPackageIds, type PlayCreditPackageId } from "@/lib/playCreditPackages";
import { resolveDicsPaymentLink, withPurchaseRef } from "@/lib/dicsCatalog";

// ---------------------------------------------------------------------------
// V2.4 — purchase intent. Step one of the adapter contract.
//
// Mints an opaque reference the player carries to the commercial adapter, so
// the adapter can name a Barkóba player without ever holding a player_id.
//
// ACCOUNT BEFORE PURCHASE. This route mints only for a live, revocable account
// session. A signed guest cookie or legacy protected-player cookie is not
// account authority, even though both may still name the same player_id.
//
// V2.7 — VERIFIED BEFORE PURCHASE, the same way. An account with an
// unconfirmed email is exactly as unreliable a place to attach purchased
// value as no account at all: the recovery code was shown once, at
// registration, and an unverified address is the only channel that could
// ever resend it. Same posture as the account check above — the server is
// the authority; app/components/Entitlement.tsx's gateway is the courteous
// path to it, not the guarantee.
//
// V2.7.x — SUPERSEDES ONLY WHERE THE PLAYER'S BROWSER GOES NEXT, NOT WHAT THIS
// ROUTE GUARANTEES. Until now purchase_url pointed at DICS's own storefront
// page (docs/DESIGN-NOTES.md §41); the player picked flavour and quantity
// there. Now the caller names the package (and, for dics_scoop, a cosmetic
// flavour) up front, and purchase_url is DICS's own published Stripe Payment
// Link for that offer, carrying the identical client_reference_id/UTM
// attribution DICS's own storefront page would have attached. See
// lib/dicsCatalog.ts for why this is reading DICS's own published interface,
// not scraping around it, and docs/DESIGN-NOTES.md §51.8 for the product
// decision this implements.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

interface IntentBody {
  package_id?: unknown;
  flavor_key?: unknown;
}

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

  const account = await getPlayerAccount(context.playerId);
  if (!account || account.email_verified_at === null) {
    return NextResponse.json(
      {
        error: "email_verification_required",
        message:
          "A vásárláshoz erősítsd meg az e-mail címed. Küldtünk egy megerősítő linket.",
      },
      { status: 409 }
    );
  }

  let body: IntentBody;
  try {
    body = (await req.json()) as IntentBody;
  } catch {
    body = {};
  }

  const packageId = typeof body.package_id === "string" ? body.package_id : "";
  if (!knownPackageIds().includes(packageId)) {
    return NextResponse.json(
      { error: "invalid_package", message: "Ismeretlen csomag." },
      { status: 400 }
    );
  }
  const flavorKey = typeof body.flavor_key === "string" ? body.flavor_key : undefined;

  const purchaseRef = await createPurchaseRef(context.playerId);

  const paymentLink = await resolveDicsPaymentLink(packageId as PlayCreditPackageId, flavorKey);
  if (!paymentLink) {
    return NextResponse.json(
      { error: "purchase_unavailable", message: "A vásárlási oldal most nem érhető el." },
      { status: 503 }
    );
  }
  const purchaseUrl = withPurchaseRef(paymentLink, purchaseRef);

  return NextResponse.json({
    purchase_ref: purchaseRef,
    purchase_url: purchaseUrl,
    // Where the adapter should send the player back to. Relative on purpose:
    // Barkóba does not know or care which host the adapter runs on.
    return_url: "/play?purchase=return",
    expires_in_seconds: PURCHASE_REF_TTL_SECONDS,
  });
}
