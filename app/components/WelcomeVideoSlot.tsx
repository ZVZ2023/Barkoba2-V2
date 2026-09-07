// ---------------------------------------------------------------------------
// V2.7.0 human-test fix — the natural slot for the ~30-second welcome video
// (what Barkóba is, the gondolkodó/kérdező idea, one play tip, a light nod to
// competitions/history), reused unchanged by both PurchaseClient.tsx and
// ClaimPrompt.tsx (see V2.7.x's own comments there) — one placeholder/player,
// not a second mechanism.
//
// V2.9.1 — the real Hungarian YouTube Short now fills this slot. Both call
// sites are entirely Hungarian with no HU/EN toggle of their own, so this
// stays Hungarian-only too — there is no established bilingual behavior to
// preserve beyond that.
//
// PRIVACY-ENHANCED EMBED (youtube-nocookie.com), NOT the ordinary
// youtube.com embed host — this is what actually keeps YouTube from setting
// tracking cookies before the viewer chooses to interact with the player.
//
// NO AUTOPLAY: the embed src carries no `autoplay` parameter, and the
// `allow` feature-policy below deliberately omits "autoplay" too, so nothing
// here could enable it even indirectly.
//
// VERTICAL (9:16) SHORT: capped to a small max-width and centered, rather
// than the pre-existing 16:9 `aspect-video` placeholder box — a full-width
// 9:16 player would otherwise become implausibly tall on a normal desktop
// viewport width.
// ---------------------------------------------------------------------------

const WELCOME_VIDEO_ID = "X29Iyc0vUnk";
const WELCOME_VIDEO_EMBED_SRC = `https://www.youtube-nocookie.com/embed/${WELCOME_VIDEO_ID}`;
const WELCOME_VIDEO_WATCH_URL = `https://www.youtube.com/shorts/${WELCOME_VIDEO_ID}`;

export default function WelcomeVideoSlot() {
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="mx-auto aspect-[9/16] w-full max-w-[220px] overflow-hidden rounded-md border border-[var(--ink)]/15 bg-[var(--ink)]/5">
        <iframe
          src={WELCOME_VIDEO_EMBED_SRC}
          title="Barkóba bemutató videó"
          className="h-full w-full"
          loading="lazy"
          allow="clipboard-write; encrypted-media; picture-in-picture; web-share"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
        />
      </div>
      {/* Fallback for whenever the embed itself cannot load (blocked, no JS,
          a restrictive network) — a normal, always-present external link,
          not a conditional rendered only after a detected failure. */}
      <a
        href={WELCOME_VIDEO_WATCH_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="text-xs text-[var(--ink-soft)] underline-offset-2 hover:underline"
      >
        Megnézem a YouTube-on
      </a>
    </div>
  );
}
