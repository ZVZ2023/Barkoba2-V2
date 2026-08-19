import { NextResponse } from "next/server";
import { resolveActingPlayer } from "@/lib/actingPlayer";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const context = await resolveActingPlayer(req.headers);
  return NextResponse.json({
    authenticated: context.kind === "account",
    registered: context.kind === "account" || context.kind === "registered",
  });
}
