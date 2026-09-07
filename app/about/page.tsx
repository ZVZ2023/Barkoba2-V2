import type { Metadata } from "next";
import Link from "next/link";
import ContentPage from "../components/ContentPage";

export const metadata: Metadata = { title: "Rólunk — Barkóba" };

// V2.9.1.3 — replaced the prior short, deliberately-anonymous "no company,
// no team, no history" text with William's own personal note, approved
// verbatim. The obsolete "jelenlegi V1" status framing (already corrected
// elsewhere on the site — see app/rules/page.tsx and app/privacy/page.tsx's
// own version-neutral phrasing) is gone along with the rest of the old body.
// No Section wrapper: this is one flowing personal note, not a set of
// separately-headed topics — ContentPage's own title ("Rólunk") and article
// styling already give it the same page chrome every other content page has.

export default function AboutPage() {
  return (
    <ContentPage title="Rólunk">
      {/*
        Matches Section's own inner-content typography (app/components/
        ContentPage.tsx) exactly, without using Section itself — a single
        flowing personal note has no natural sub-heading to give it, and
        Section requires one.
      */}
      <div className="flex flex-col gap-3 text-[15px] leading-relaxed text-neutral-800">
        <p>William vagyok, Tajvanon született magyar, önálló tanuló.</p>
        <p>
          Tizenegy éves korom óta tanulok programozni. Tizenöt évesen
          befejeztem a középiskolai tanulmányaimat, és amint tizenhat évesen
          lehetőségem nyílt rá, kiléptem a számomra elavult
          iskolarendszerből, hogy a saját utamat járjam.
        </p>
        <p>
          Édesapámmal közösen készítettük el a Barkóba K első, már
          kipróbálható változatát. Rengeteget tanultam közben, és most arra
          vagyunk kíváncsiak, hogy nektek is örömet ad-e, amit létrehoztunk.
        </p>
        <p>
          Ez nekünk szerelemprojekt. Magyar nevelőapám ismertette meg velem
          és a testvéreimmel a barkóbát, és azóta naponta játszunk. Ezt a
          közös élményt szeretnénk továbbadni — most már a mesterséges
          intelligenciát is bevonva.
        </p>
        <p>
          Legyetek velem egy kicsit türelmesek: még néhány hónapig nem
          vagyok nagykorú, és közben már elkezdtem a mechatronikai
          tanulmányaimat is. Van tehát bőven a tányéromon! Ha valami nem
          működik, vagy nem érthető, írjátok meg a{" "}
          <Link href="/feedback" className="underline underline-offset-2">
            visszajelző űrlapon
          </Link>
          . Ezzel segítetek jobbá tenni a játékot.
        </p>
        <p>Remélem, nektek is örömet és gondolkodnivalót ad majd a Barkóba K.</p>
        <p>William</p>
      </div>
    </ContentPage>
  );
}
