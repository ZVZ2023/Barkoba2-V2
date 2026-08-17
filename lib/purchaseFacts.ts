// Attested payment provenance. This module validates and preserves facts; it
// never classifies a package or calculates Play Credits.

export const PURCHASE_FACTS_SCHEMA_VERSION = "dic-purchase/1" as const;
export const PURCHASE_FACTS_MAX_BYTES = 4 * 1024;

export interface PurchaseFacts {
  provider: "stripe";
  source: "dics";
  purchase_facts_schema_version: typeof PURCHASE_FACTS_SCHEMA_VERSION;
  product: string;
  flavour: string | null;
  stripe_price_id: string;
  quantity: number;
  currency: string;
  amount_total: number;
  purchased_at: string;
  livemode: boolean;
}

const KEYS = new Set<keyof PurchaseFacts>([
  "provider",
  "source",
  "purchase_facts_schema_version",
  "product",
  "flavour",
  "stripe_price_id",
  "quantity",
  "currency",
  "amount_total",
  "purchased_at",
  "livemode",
]);

function shortString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

/**
 * Validate the payment-side adapter's attested facts without interpreting them.
 * The returned object is the original object so the accepted envelope is stored
 * verbatim rather than reconstructed into a subtly different purchase record.
 */
export function validatePurchaseFacts(raw: unknown): PurchaseFacts | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const facts = raw as Record<string, unknown>;

  const keys = Object.keys(facts);
  if (keys.length !== KEYS.size || keys.some((key) => !KEYS.has(key as keyof PurchaseFacts))) {
    return null;
  }

  if (facts.provider !== "stripe" || facts.source !== "dics") return null;
  if (facts.purchase_facts_schema_version !== PURCHASE_FACTS_SCHEMA_VERSION) return null;
  if (!shortString(facts.product, 200)) return null;
  if (facts.flavour !== null && !shortString(facts.flavour, 200)) return null;
  if (!shortString(facts.stripe_price_id, 255)) return null;
  if (!Number.isSafeInteger(facts.quantity) || Number(facts.quantity) <= 0) return null;
  if (typeof facts.currency !== "string" || !/^[a-zA-Z]{3}$/.test(facts.currency)) return null;
  if (!Number.isSafeInteger(facts.amount_total) || Number(facts.amount_total) < 0) return null;
  if (!shortString(facts.purchased_at, 40) || Number.isNaN(Date.parse(facts.purchased_at))) {
    return null;
  }
  if (typeof facts.livemode !== "boolean") return null;

  let serialized: string;
  try {
    serialized = JSON.stringify(raw);
  } catch {
    return null;
  }
  if (new TextEncoder().encode(serialized).byteLength > PURCHASE_FACTS_MAX_BYTES) return null;

  return raw as PurchaseFacts;
}
