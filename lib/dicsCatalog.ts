import { env } from "./env";

// ---------------------------------------------------------------------------
// V2.7 — resolving a hosted Stripe Payment Link directly from DICS's own
// published catalogue, without ever sending the player's browser to DICS's
// storefront page.
//
// WHY THIS IS SAFE TO DO, NOT A WORKAROUND. DICS publishes a versioned,
// machine-readable manifest (agent-capability-manifest.json) specifically so
// a caller that is not a browser rendering its HTML can still act on its
// catalogue. Its own `recommend_flavor` capability is described as:
// "Present the match and the Payment Link URL; do not complete checkout." —
// i.e. handing a Payment Link to someone else to present is the intended use,
// not an incidental one this file discovered by scraping.
//
// WHAT STAYS UNTOUCHED. Nothing about Stripe, the webhook/grant adapter, or
// the entitlement ledger changes here. This file answers exactly one
// question — "which buy.stripe.com URL corresponds to the package the player
// picked, right now" — and nothing else. /api/entitlement/grant still learns
// what was actually purchased from its own server-to-server contract, never
// from anything this file returns.
//
// FLAVOUR IS COSMETIC. lib/playCreditPackages.ts already treats every
// standard flavour as the same "scoop" economic class; this file mirrors
// that by letting the caller name a flavour purely for presentation, never
// for pricing.
//
// FAILS CLOSED. A manifest that cannot be fetched, or that no longer has the
// shape this code expects, resolves to `null` — never a guess, never a
// fallback to some other unrelated URL. The one exception is an UNKNOWN
// flavour key inside an otherwise well-formed manifest (DICS renamed or
// reordered a flavour): that degrades to the first available flavour rather
// than failing the whole purchase, because flavour choice is decorative and
// blocking a purchase over it would be a worse failure than the one it
// prevents.
//
// ONLY buy.stripe.com IS EVER FOLLOWED. The manifest is content Barkóba does
// not control. A payment_link field that is not an https://buy.stripe.com/…
// URL is treated exactly like a missing one — this is what stands between
// "read DICS's product list" and "redirect players wherever a modified or
// compromised manifest says to."
// ---------------------------------------------------------------------------

interface ManifestOffer {
  key?: unknown;
  name?: unknown;
  payment_link?: unknown;
}

interface ManifestShape {
  offers?: {
    standard_flavors?: unknown;
    custom_flavor?: { payment_link?: unknown };
  };
}

export interface DicsFlavorLink {
  key: string;
  name: string;
  paymentLink: string;
}

interface CatalogCache {
  fetchedAt: number;
  scoopFlavors: DicsFlavorLink[];
  customPaymentLink: string | null;
}

/** Five minutes: long enough that a purchase page under real traffic does
 * not hit GitHub Pages on every click, short enough that a DICS-side change
 * reaches Barkóba the same day without a redeploy. */
const CACHE_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;

let cache: CatalogCache | null = null;

function isStripePaymentLink(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "buy.stripe.com";
  } catch {
    return false;
  }
}

function parseManifest(raw: unknown): CatalogCache | null {
  const manifest = raw as ManifestShape;
  const rawFlavors = manifest?.offers?.standard_flavors;
  if (!Array.isArray(rawFlavors)) return null;

  const scoopFlavors: DicsFlavorLink[] = [];
  for (const entry of rawFlavors as ManifestOffer[]) {
    if (
      typeof entry?.key === "string" &&
      entry.key.length > 0 &&
      typeof entry?.name === "string" &&
      entry.name.length > 0 &&
      isStripePaymentLink(entry.payment_link)
    ) {
      scoopFlavors.push({ key: entry.key, name: entry.name, paymentLink: entry.payment_link as string });
    }
  }
  if (scoopFlavors.length === 0) return null;

  const customLink = manifest?.offers?.custom_flavor?.payment_link;
  const customPaymentLink = isStripePaymentLink(customLink) ? (customLink as string) : null;

  return { fetchedAt: Date.now(), scoopFlavors, customPaymentLink };
}

/**
 * Fetches and validates DICS's manifest, cached in-process for CACHE_TTL_MS.
 *
 * Returns null on any fetch, timeout, JSON, or shape failure — the caller's
 * job is to treat that exactly like "purchase unavailable", the same posture
 * app/api/entitlement/intent/route.ts already takes for a malformed
 * DICS_STOREFRONT_URL.
 */
export async function fetchDicsCatalog(): Promise<CatalogCache | null> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const url = new URL(env.dicsManifestUrl());
    if (url.protocol !== "https:") return null;
    const res = await fetch(url.toString(), { signal: controller.signal, cache: "no-store" });
    if (!res.ok) return null;
    const parsed = parseManifest(await res.json());
    if (parsed) cache = parsed;
    return parsed;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[barkoba] DICS manifest fetch failed:", err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The Stripe Payment Link for the requested package, or null if unavailable.
 *
 * `flavorKey` is presentation only (see file header). An unrecognised key
 * falls back to the first published flavour rather than failing the
 * purchase; a manifest that cannot be read or parsed at all still fails
 * closed via fetchDicsCatalog() returning null.
 */
export async function resolveDicsPaymentLink(
  packageId: "dics_scoop" | "dics_custom",
  flavorKey?: string
): Promise<string | null> {
  const catalog = await fetchDicsCatalog();
  if (!catalog) return null;

  if (packageId === "dics_custom") return catalog.customPaymentLink;

  const match = catalog.scoopFlavors.find((f) => f.key === flavorKey);
  // parseManifest() only ever produces a non-empty scoopFlavors array.
  return (match ?? catalog.scoopFlavors[0])!.paymentLink;
}

/**
 * Replicates DICS's own client-side `checkoutUrl()` transform byte-for-byte
 * in intent, so the resulting Stripe session is indistinguishable from one a
 * player would have reached by visiting DICS's page directly: same
 * client_reference_id, same UTM attribution back to Barkóba.
 */
export function withPurchaseRef(paymentLink: string, purchaseRef: string): string {
  const checkout = new URL(paymentLink);
  checkout.searchParams.set("client_reference_id", purchaseRef);
  checkout.searchParams.set("utm_source", "barkoba");
  checkout.searchParams.set("utm_content", purchaseRef);
  return checkout.toString();
}

/** Test-only: clear the in-process cache between cases. */
export function __resetDicsCatalogCacheForTests(): void {
  cache = null;
}
