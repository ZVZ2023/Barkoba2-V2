import type { Metadata } from "next";
import JoinClient from "./JoinClient";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Barkóba — Csatlakozás" };

/**
 * V2.3 — the invitation landing page.
 *
 * Server component only so the code arrives from the route. The join itself is
 * a POST from the client, because it needs the player-identity cookie that
 * middleware issues, and on a brand-new visitor that cookie is set on THIS
 * response — so the first request that can carry it is the next one.
 */
export default function JoinPage({ params }: { params: { code: string } }) {
  return (
    <div className="flex min-h-screen w-full flex-col bg-[#f6ece0] text-neutral-900">
      <JoinClient code={params.code} />
    </div>
  );
}
