import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  fetchDicsCatalog,
  resolveDicsPaymentLink,
  withPurchaseRef,
  __resetDicsCatalogCacheForTests,
} from "../lib/dicsCatalog";

// ---------------------------------------------------------------------------
// V2.7.x — resolving a package straight to DICS's own published Stripe
// Payment Link, without ever sending the player's browser to DICS's
// storefront page. See docs/DESIGN-NOTES.md §51.8.
//
// What matters here, proven directly rather than assumed:
//   - a well-formed manifest resolves the expected Payment Link
//   - anything that is not a genuine https://buy.stripe.com/... URL is
//     rejected, even inside an otherwise well-formed manifest — the manifest
//     is external content Barkóba does not control
//   - a fetch failure, timeout, or malformed manifest fails CLOSED (null),
//     never a guess and never the storefront URL as a fallback
//   - an unrecognised flavor key degrades to the first published flavor
//     rather than failing the whole purchase — flavor is cosmetic
//   - the purchase_ref transform matches DICS's own checkoutUrl() exactly:
//     client_reference_id, utm_source=barkoba, utm_content=<ref>
// ---------------------------------------------------------------------------

const REAL_FETCH = globalThis.fetch;
const REAL_MANIFEST_URL = process.env.DICS_MANIFEST_URL;

const VALID_MANIFEST = {
  offers: {
    standard_flavors: [
      { key: "pistachio", name: "Pistachio", payment_link: "https://buy.stripe.com/scoop-a" },
      { key: "mango", name: "Mango", payment_link: "https://buy.stripe.com/scoop-b" },
    ],
    custom_flavor: { payment_link: "https://buy.stripe.com/custom-a" },
  },
};

beforeEach(() => {
  process.env.DICS_MANIFEST_URL = "https://dics.example/manifest.json";
  __resetDicsCatalogCacheForTests();
});

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
  if (REAL_MANIFEST_URL === undefined) delete process.env.DICS_MANIFEST_URL;
  else process.env.DICS_MANIFEST_URL = REAL_MANIFEST_URL;
  __resetDicsCatalogCacheForTests();
});

function stubFetch(handler: () => Response) {
  globalThis.fetch = (async () => handler()) as typeof fetch;
}

test("a well-formed manifest resolves the requested flavor's Payment Link", async () => {
  stubFetch(() => new Response(JSON.stringify(VALID_MANIFEST), { status: 200 }));
  const link = await resolveDicsPaymentLink("dics_scoop", "mango");
  assert.equal(link, "https://buy.stripe.com/scoop-b");
});

test("dics_custom resolves the custom_flavor Payment Link, ignoring flavor_key", async () => {
  stubFetch(() => new Response(JSON.stringify(VALID_MANIFEST), { status: 200 }));
  const link = await resolveDicsPaymentLink("dics_custom", "mango");
  assert.equal(link, "https://buy.stripe.com/custom-a");
});

test("an unrecognised flavor key degrades to the first published flavor, not a failure", async () => {
  stubFetch(() => new Response(JSON.stringify(VALID_MANIFEST), { status: 200 }));
  const link = await resolveDicsPaymentLink("dics_scoop", "flavor-that-does-not-exist");
  assert.equal(link, "https://buy.stripe.com/scoop-a");
});

test("a missing flavor key also degrades to the first published flavor", async () => {
  stubFetch(() => new Response(JSON.stringify(VALID_MANIFEST), { status: 200 }));
  const link = await resolveDicsPaymentLink("dics_scoop", undefined);
  assert.equal(link, "https://buy.stripe.com/scoop-a");
});

test("a payment_link that is not buy.stripe.com is rejected, not followed", async () => {
  const manifest = {
    offers: {
      standard_flavors: [
        { key: "pistachio", name: "Pistachio", payment_link: "https://evil.example/steal-payment" },
      ],
      custom_flavor: { payment_link: "https://buy.stripe.com/custom-a" },
    },
  };
  stubFetch(() => new Response(JSON.stringify(manifest), { status: 200 }));
  // The one offered flavor is entirely rejected, so there is nothing left to
  // fall back to — this must fail closed, not silently drop the guard.
  const link = await resolveDicsPaymentLink("dics_scoop", "pistachio");
  assert.equal(link, null);
});

// --- host-spoofing: exact match, not substring/prefix ----------------------
//
// The manifest is content Barkóba does not control, so the guard around it
// must survive the three classic ways to spoof a host string past a naive
// check: a lookalike SUFFIX ("buy.stripe.com.attacker.tld"), a lookalike
// PREFIX/subdomain ("attacker.buy.stripe.com"), and userinfo-in-the-URL
// tricks ("https://buy.stripe.com@attacker.tld/"), where the part before
// "@" looks like the real host but the browser's actual destination is
// whatever follows "@". `new URL(...).hostname` already resolves each of
// these to the TRUE host, and lib/dicsCatalog.ts compares against that with
// strict `===`, but that property is worth proving directly rather than
// trusting the reasoning.

for (const [label, evilLink] of [
  ["suffix lookalike", "https://buy.stripe.com.attacker.tld/scoop-a"],
  ["subdomain/prefix lookalike", "https://attacker.buy.stripe.com/scoop-a"],
  ["userinfo trick", "https://buy.stripe.com@attacker.tld/scoop-a"],
] as const) {
  test(`a ${label} payment_link is rejected, not treated as buy.stripe.com`, async () => {
    const manifest = {
      offers: {
        standard_flavors: [{ key: "pistachio", name: "Pistachio", payment_link: evilLink }],
        custom_flavor: { payment_link: evilLink },
      },
    };
    stubFetch(() => new Response(JSON.stringify(manifest), { status: 200 }));
    assert.equal(await resolveDicsPaymentLink("dics_scoop", "pistachio"), null);
    __resetDicsCatalogCacheForTests();
    stubFetch(() => new Response(JSON.stringify(manifest), { status: 200 }));
    assert.equal(await resolveDicsPaymentLink("dics_custom"), null);
  });
}

test("a manifest fetch failure fails closed", async () => {
  stubFetch(() => new Response("nope", { status: 500 }));
  assert.equal(await resolveDicsPaymentLink("dics_scoop"), null);
  assert.equal(await fetchDicsCatalog(), null);
});

test("a network error fails closed rather than throwing", async () => {
  globalThis.fetch = (async () => {
    throw new Error("network down");
  }) as typeof fetch;
  assert.equal(await resolveDicsPaymentLink("dics_custom"), null);
});

test("a malformed manifest (no standard_flavors array) fails closed", async () => {
  stubFetch(() => new Response(JSON.stringify({ offers: {} }), { status: 200 }));
  assert.equal(await resolveDicsPaymentLink("dics_scoop"), null);
});

test("only https is followed for the manifest URL itself", async () => {
  process.env.DICS_MANIFEST_URL = "http://dics.example/manifest.json";
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return new Response(JSON.stringify(VALID_MANIFEST), { status: 200 });
  }) as typeof fetch;
  assert.equal(await fetchDicsCatalog(), null);
  assert.equal(called, false, "an insecure manifest URL must never be fetched");
});

test("the manifest is cached in-process rather than fetched on every call", async () => {
  let calls = 0;
  stubFetch(() => {
    calls += 1;
    return new Response(JSON.stringify(VALID_MANIFEST), { status: 200 });
  });
  await fetchDicsCatalog();
  await fetchDicsCatalog();
  await resolveDicsPaymentLink("dics_scoop", "mango");
  assert.equal(calls, 1);
});

test("withPurchaseRef matches DICS's own checkoutUrl() transform exactly", () => {
  const url = withPurchaseRef("https://buy.stripe.com/scoop-a", "ABCDEFGH12345678");
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get("client_reference_id"), "ABCDEFGH12345678");
  assert.equal(parsed.searchParams.get("utm_source"), "barkoba");
  assert.equal(parsed.searchParams.get("utm_content"), "ABCDEFGH12345678");
  assert.equal(parsed.origin + parsed.pathname, "https://buy.stripe.com/scoop-a");
});
