import { put } from "@vercel/blob";
import { env } from "./env";

// ---------------------------------------------------------------------------
// V2.6.x — profile photo upload.
//
// uploadProfilePhoto() calls Vercel Blob's put(). The path never encodes the
// player_id — a fresh UUID plus Blob's own addRandomSuffix, the same "opaque
// reference" instinct as lib/purchaseRef.ts, so a public photo URL cannot be
// walked back to an account.
// ---------------------------------------------------------------------------

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const ALLOWED_PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export function isAllowedPhotoType(type: string): boolean {
  return ALLOWED_PHOTO_TYPES.has(type);
}

export function isPhotoSizeAllowed(bytes: number): boolean {
  return Number.isFinite(bytes) && bytes > 0 && bytes <= MAX_PHOTO_BYTES;
}

export interface UploadedPhoto {
  url: string;
  pathname: string;
}

function extensionFor(type: string): string {
  switch (type) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    default:
      return "bin";
  }
}

/**
 * Uploads to Vercel Blob and returns its public URL.
 *
 * The signature is (File) in, a result out — unchanged from the stub this
 * replaced, so nothing that calls it needed to change. Throws when
 * BLOB_READ_WRITE_TOKEN is unset or the upload itself fails; the caller
 * (app/api/account/photo/route.ts) already wraps this call in a try/catch
 * and answers 503, since a photo upload IS the action that request asked
 * for — unlike verification email, there is no secondary effect to shrug off.
 */
export async function uploadProfilePhoto(file: File): Promise<UploadedPhoto> {
  const token = env.blobReadWriteToken();
  if (!token) {
    throw new Error("BLOB_READ_WRITE_TOKEN is not set; cannot upload a profile photo.");
  }

  const pathname = `profile-photos/${crypto.randomUUID()}.${extensionFor(file.type)}`;
  const blob = await put(pathname, file, {
    access: "public",
    addRandomSuffix: true,
    contentType: file.type,
    token,
  });

  return { url: blob.url, pathname: blob.pathname };
}
