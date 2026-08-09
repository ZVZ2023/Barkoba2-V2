// ---------------------------------------------------------------------------
// The artwork layer.
//
// <picture> with media sources so exactly ONE image downloads — the phone never
// pays for the 16:9 render. The art sits behind the interface and is
// decorative: alt="" and aria-hidden, because a screen reader announcing
// "Budapest at sunset" before the actual controls helps nobody.
//
// object-cover keeps it undistorted at every viewport. What that costs is
// cropping, and the composition is edge-anchored (Liberty statue bottom-left,
// horseman bottom-right, ornamental strip along the bottom) — which is exactly
// why three ratios exist rather than one stretched everywhere.
// ---------------------------------------------------------------------------

export default function Stage() {
  return (
    <div className="pointer-events-none fixed inset-0 -z-10" aria-hidden="true">
      <picture>
        <source media="(min-width: 1280px)" srcSet="/art/stage-wide.jpg" />
        <source media="(min-width: 768px)" srcSet="/art/stage-tablet.jpg" />
        <img
          src="/art/stage-portrait.jpg"
          alt=""
          className="h-full w-full object-cover object-center"
        />
      </picture>
      {/* Readability scrim. The art is a light cream that dark type sits on
          well, but the Parliament and flower areas are busy — this lifts
          contrast under the text column without washing the art out. */}
      <div className="absolute inset-0 bg-[#f6ece0]/55 md:bg-gradient-to-r md:from-[#f6ece0]/85 md:via-[#f6ece0]/60 md:to-transparent" />
    </div>
  );
}
