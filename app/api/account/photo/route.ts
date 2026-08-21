import { NextResponse } from "next/server";
import { resolveActingPlayer } from "@/lib/actingPlayer";
import { setAccountPhotoUrl } from "@/lib/playerAccounts";
import { isAllowedPhotoType, isPhotoSizeAllowed, uploadProfilePhoto } from "@/lib/photoUpload";

export const dynamic = "force-dynamic";

/**
 * V2.6.x — profile photo upload. Requires an active session, same bar as
 * rotate-recovery-code: this writes to the account, so a merely-registered
 * (not logged in) browser cannot use it.
 *
 * The storage call is a stub — see lib/photoUpload.ts. This route's own job
 * is authorization and validation, and neither changes when that stub is
 * replaced with a real Vercel Blob call.
 */
export async function POST(req: Request) {
  const context = await resolveActingPlayer(req.headers);
  if (context.kind !== "account") {
    return NextResponse.json(
      { error: "account_required", message: "A fotó feltöltéséhez be kell jelentkezned." },
      { status: 401 }
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "invalid_body", message: "Hibás kérés." }, { status: 400 });
  }

  const file = form.get("photo");
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "missing_file", message: "Nincs kiválasztott fájl." },
      { status: 400 }
    );
  }
  if (!isAllowedPhotoType(file.type)) {
    return NextResponse.json(
      { error: "unsupported_type", message: "Csak JPEG, PNG vagy WEBP kép tölthető fel." },
      { status: 400 }
    );
  }
  if (!isPhotoSizeAllowed(file.size)) {
    return NextResponse.json(
      { error: "file_too_large", message: "A kép mérete legfeljebb 4 MB lehet." },
      { status: 400 }
    );
  }

  try {
    const uploaded = await uploadProfilePhoto(file);
    const saved = await setAccountPhotoUrl(context.playerId, uploaded.url);
    if (!saved) {
      return NextResponse.json(
        { error: "upload_failed", message: "A fotó mentése most nem sikerült." },
        { status: 503 }
      );
    }
    return NextResponse.json({ photo_url: uploaded.url });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[barkoba] profile photo upload failed:", err);
    return NextResponse.json(
      { error: "upload_failed", message: "A fotó feltöltése most nem sikerült." },
      { status: 503 }
    );
  }
}
