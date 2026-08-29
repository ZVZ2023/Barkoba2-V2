import type { Metadata } from "next";
import VerifyEmailClient from "./VerifyEmailClient";

export const metadata: Metadata = { title: "E-mail megerősítés — Barkóba" };

// Identity/verification state is per-request, never statically rendered or
// cached — same reasoning as every other player-state page in this app.
export const dynamic = "force-dynamic";

/**
 * V2.7.x — the human-facing landing page for the emailed verification link.
 *
 * This is what closes the loop the previous onboarding pass left open: the
 * link used to point straight at GET /api/account/verify-email, a raw JSON
 * API route, so clicking it showed a player unstyled JSON instead of a
 * welcome. This page is a thin shell — see VerifyEmailClient — around that
 * same, unmodified-in-its-contract-shape API route; nothing about the
 * verification logic itself lives here.
 */
export default function Page() {
  return <VerifyEmailClient />;
}
