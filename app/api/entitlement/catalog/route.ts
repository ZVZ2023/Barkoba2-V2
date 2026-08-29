import { NextResponse } from "next/server";
import { creditsForPackage } from "@/lib/playCreditPackages";
import { fetchDicsCatalog } from "@/lib/dicsCatalog";

// ---------------------------------------------------------------------------
// V2.7.x — read-only, unauthenticated: what a player can buy and what it's
// worth in Play Credits, so Barkóba's own purchase page can render package
// cards before any purchase_ref is minted.
//
// NOT gated like /api/admin/capacity. That route protects aggregate
// operational/business data; this is a price list — the exact thing a
// purchase page has to show every visitor, logged in or not, by definition.
//
// NO PRICING DECISION LIVES HERE. credits_by_scoops and credits_first_step
// are read straight from lib/playCreditPackages.ts's creditsForPackage(),
// never recomputed — this route is a view onto that file, not a second copy
// of it.
//
// FLAVOUR LIST DEGRADES, NOT FAILS. If DICS's manifest cannot be read right
// now, scoop_flavors comes back empty and the purchase page falls back to a
// single flavourless "1 scoop" card — flavour is cosmetic (see
// lib/dicsCatalog.ts), so losing it here must not make the catalogue itself
// unavailable. Only /api/entitlement/intent, which actually needs a working
// Stripe Payment Link to hand the player, fails closed.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

export async function GET() {
  const catalog = await fetchDicsCatalog();

  return NextResponse.json({
    scoop: {
      flavors: (catalog?.scoopFlavors ?? []).map((f) => ({ key: f.key, name: f.name })),
      credits_by_scoops: {
        1: creditsForPackage("dics_scoop", 1),
        2: creditsForPackage("dics_scoop", 2),
        3: creditsForPackage("dics_scoop", 3),
      },
    },
    custom: {
      available: catalog?.customPaymentLink != null,
      // The €25 base tier's credit value. Further quantity is chosen at
      // Stripe's own hosted checkout, exactly like scoop quantity.
      credits_first_step: creditsForPackage("dics_custom", 1),
    },
  });
}
