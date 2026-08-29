import type { Metadata } from "next";
import RecoverAccountClient from "./RecoverAccountClient";

export const metadata: Metadata = { title: "Fiók visszaállítása — Barkóba" };

// Token status is per-request, never statically rendered or cached — same
// reasoning as every other identity-dependent page in this app.
export const dynamic = "force-dynamic";

/**
 * V2.7.x — the human-facing landing page for the emailed account-recovery
 * link. Thin shell; see RecoverAccountClient for the scanner-safe GET/POST
 * split, mirroring app/verify-email/.
 */
export default function Page() {
  return <RecoverAccountClient />;
}
