// ---------------------------------------------------------------------------
// V2.6.x — profile photo upload.
//
// uploadProfilePhoto() IS A STUB. No storage provider is called; it logs what
// it would have uploaded and returns a placeholder URL immediately.
//   // TODO: wire to Vercel Blob once BLOB_READ_WRITE_TOKEN exists
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
}

/**
 * STUB. Logs what would be uploaded and returns a placeholder URL; no
 * storage provider is called.
 *
 * The signature is deliberately final: one File in, one URL out. Wiring
 * Vercel Blob means replacing this function's body with a `put()` call —
 * nothing that calls it needs to change.
 *
 * // TODO: wire to Vercel Blob once BLOB_READ_WRITE_TOKEN exists
 */
export async function uploadProfilePhoto(file: File): Promise<UploadedPhoto> {
  // eslint-disable-next-line no-console
  console.log(
    `[barkoba] STUB uploadProfilePhoto: would upload "${file.name}" (${file.type}, ${file.size} bytes)`
  );
  return { url: `stub://profile-photo/${crypto.randomUUID()}` };
}
