import type { Metadata } from "next";
import ContentPage, { Section } from "../components/ContentPage";

export const metadata: Metadata = { title: "Rólunk — Barkóba" };

// Deliberately short, and deliberately contains no company, team, funding,
// address or history — none of that was supplied, and inventing it would be
// the easiest lie on the site to tell.

export default function AboutPage() {
  return (
    <ContentPage
      title="Rólunk"
      lead="A Barkóba a klasszikus magyar kitalálós játék mai értelmezése — ember és mesterséges intelligencia közötti gondolkodásról."
    >
      <Section heading="Miről szól">
        <p>
          A régi játék egyszerű: valaki gondol valamire, a többiek kérdésekkel jutnak el
          hozzá. Ebben a változatban az egyik oldalon mesterséges intelligencia ül —
          hol kérdezőként, hol a titok őrzőjeként.
        </p>
      </Section>

      <Section heading="Ami érdekel minket">
        <p>
          Nem az, hogy melyik fél nyer. Az, hogy hogyan lesz valaki jobb kérdező: hogyan
          szűkíti a lehetőségeket, mikor éri meg egy feltevést inkább megcáfolni, mint
          megerősíteni, és mit árul el egy jó kérdés arról, aki felteszi.
        </p>
        <p>
          A tisztességes játék ennek a feltétele. Egy nyerés, amit félrevezető válasz vagy
          kihasznált rés hozott, semmit nem tanít.
        </p>
      </Section>

      <Section heading="Hol tart most">
        <p>
          A Barkóba fejlesztés alatt áll. A jelenlegi V1 két játékmódot tartalmaz, ember és
          AI között. Ami még nem működik, azt a felületen is jelezzük — nem úgy teszünk,
          mintha készen lenne.
        </p>
      </Section>
    </ContentPage>
  );
}
