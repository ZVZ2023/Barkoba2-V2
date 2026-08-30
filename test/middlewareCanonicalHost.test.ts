import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { middleware } from "../middleware";

// ---------------------------------------------------------------------------
// V2.7.0.19 — canonical-host redirect for player-facing pages.
//
// PRODUCTION EVIDENCE: a real Stripe purchase returned the browser to
// barkoba2-v2.vercel.app/play?purchase=return instead of barkobak.com,
// traced to a hardcoded redirect inside a third-party static page this repo
// does not own or control. ACCOUNT_SESSION_COOKIE is host-only (no Domain
// attribute), so a browser on that other host cannot see the session it
// holds for barkobak.com — it resolves as a fresh guest, and the whole
// downstream sequence (anonymous gameplay, "register for +5" CTA on an
// already-registered account) follows from that one fact.
//
// These tests drive the real middleware() function against real
// NextRequest objects — the exact code path Vercel's edge runtime executes.
// ---------------------------------------------------------------------------

const SAVED = {
  siteUrl: process.env.SITE_URL,
  productionUrl: process.env.VERCEL_PROJECT_PRODUCTION_URL,
  deploymentUrl: process.env.VERCEL_URL,
  playerIdSecret: process.env.PLAYER_ID_SECRET,
};

beforeEach(() => {
  process.env.SITE_URL = "https://barkobak.com";
  delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  delete process.env.VERCEL_URL;
  process.env.PLAYER_ID_SECRET ||= "test-secret-please-do-not-use-in-production";
});

afterEach(() => {
  for (const [key, value] of Object.entries(SAVED)) {
    const envKey =
      key === "siteUrl"
        ? "SITE_URL"
        : key === "productionUrl"
          ? "VERCEL_PROJECT_PRODUCTION_URL"
          : key === "deploymentUrl"
            ? "VERCEL_URL"
            : "PLAYER_ID_SECRET";
    if (value === undefined) delete process.env[envKey];
    else process.env[envKey] = value;
  }
});

test("a request for /play on the known legacy host redirects to the canonical host, same path and query", async () => {
  const req = new NextRequest("https://barkoba2-v2.vercel.app/play?purchase=return");
  const res = await middleware(req);
  assert.equal(res?.status, 307);
  assert.equal(res?.headers.get("location"), "https://barkobak.com/play?purchase=return");
});

test("a request for /purchase on the legacy host redirects too", async () => {
  const req = new NextRequest("https://barkoba2-v2.vercel.app/purchase");
  const res = await middleware(req);
  assert.equal(res?.headers.get("location"), "https://barkobak.com/purchase");
});

test("the -zvz-x and -git-main-zvz-x stable aliases redirect identically", async () => {
  for (const host of ["barkoba2-v2-zvz-x.vercel.app", "barkoba2-v2-git-main-zvz-x.vercel.app"]) {
    const req = new NextRequest(`https://${host}/`);
    const res = await middleware(req);
    assert.equal(res?.headers.get("location"), "https://barkobak.com/");
  }
});

test("a per-deployment preview URL (random hash) is NEVER redirected — it must stay reachable for testing a specific build", async () => {
  const req = new NextRequest("https://barkoba2-v2-9a63g2ten-zvz-x.vercel.app/play");
  const res = await middleware(req);
  // No redirect: either NextResponse.next() (no Location header) or nothing.
  assert.equal(res?.headers.get("location"), null);
});

test("the canonical host itself is never redirected", async () => {
  const req = new NextRequest("https://barkobak.com/play?purchase=return");
  const res = await middleware(req);
  assert.equal(res?.headers.get("location"), null);
});

test("API routes are NEVER redirected, even on a legacy host — a webhook/server-to-server call must not have its method or body put at risk", async () => {
  for (const path of ["/api/entitlement/grant", "/api/game/create", "/api/account/profile"]) {
    const req = new NextRequest(`https://barkoba2-v2.vercel.app${path}`, { method: "POST" });
    const res = await middleware(req);
    assert.equal(res?.headers.get("location"), null, `${path} must not redirect`);
  }
});

test("with no canonical URL configured at all, the legacy host is left alone rather than redirecting nowhere", async () => {
  delete process.env.SITE_URL;
  delete process.env.VERCEL_PROJECT_PRODUCTION_URL;
  delete process.env.VERCEL_URL;
  const req = new NextRequest("https://barkoba2-v2.vercel.app/play");
  const res = await middleware(req);
  assert.equal(res?.headers.get("location"), null);
});
