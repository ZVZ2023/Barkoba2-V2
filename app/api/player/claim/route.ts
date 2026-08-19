import { NextResponse } from "next/server";
export { GET, POST } from "@/app/api/account/register/route";

export const dynamic = "force-dynamic";

/**
 * Compatibility alias for the account registration endpoint. DELETE is
 * deliberately disabled: Module 1 has no destructive registered-account flow.
 */

export async function DELETE() {
  return NextResponse.json(
    {
      error: "account_deletion_unavailable",
      message: "A regisztrált játékos törlése ebben a verzióban nem érhető el.",
    },
    { status: 405, headers: { Allow: "GET, POST" } }
  );
}
