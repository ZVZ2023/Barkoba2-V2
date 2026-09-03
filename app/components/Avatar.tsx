"use client";

import { useEffect, useState } from "react";

/**
 * V2.8.4.3 — the one compact avatar shared by every account-control surface
 * (SiteHeader/AccountControl on the home page and /play, GameShell's header
 * on the new-game setup screens, and GameClient's own header during active
 * play). A single implementation on purpose: three independently-drifting
 * copies is exactly how "the header shows a photo everywhere except..." bugs
 * get made.
 *
 * Renders the saved profile photo, circular and cropped, at the same
 * footprint the generic account glyph already occupied — this replaces that
 * glyph in place, it does not add a row or grow the header. Falls back to
 * the glyph when there is no photo, or the moment the image fails to load.
 */
export default function Avatar({
  photoUrl,
  sizePx = 22,
}: {
  photoUrl: string | null;
  sizePx?: number;
}) {
  const [failed, setFailed] = useState(false);

  // A photo replacing an existing one (upload, or the post-upload refresh)
  // must not stay stuck on a stale failure from a previous, different URL.
  useEffect(() => {
    setFailed(false);
  }, [photoUrl]);

  if (!photoUrl || failed) {
    return (
      <span aria-hidden="true" className="shrink-0">
        👤
      </span>
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- a remote Vercel
    // Blob URL, not a local asset; next/image's optimizer has nothing to do here.
    <img
      src={photoUrl}
      alt=""
      onError={() => setFailed(true)}
      width={sizePx}
      height={sizePx}
      style={{ width: sizePx, height: sizePx }}
      className="shrink-0 rounded-full border border-neutral-900/15 object-cover"
    />
  );
}
