import type { Metadata } from "next";
import ContentPage, { Section } from "../components/ContentPage";

export const metadata: Metadata = { title: "Kapcsolat — Barkóba" };

// No email, address, phone or social account is invented here. None exists in
// the repository or configuration, so the page says so plainly. A made-up
// address on a contact page is the one lie a visitor will definitely discover.

export default function ContactPage() {
  return (
    <ContentPage
      title="Kapcsolat"
      lead="Kapcsolati lehetőségeink hamarosan elérhetők lesznek."
    >
      <Section heading="Most még nincs elérhetőség">
        <p>
          A Barkóba fejlesztés alatt áll, és egyelőre nincs olyan nyilvános e-mail-cím vagy
          csatorna, amelyet őszintén meg tudnánk adni. Inkább nem adunk meg olyat, ami nem
          működik.
        </p>
        <p>
          Amint van, itt fog megjelenni.
        </p>
      </Section>

      <Section heading="Ha hibát találsz">
        <p>
          Ha a játék közben valami nem működik, jegyezd fel, mi történt és mikor — a
          kérdést, a választ, és hogy melyik játékmódban. Ez a leghasznosabb, amit később
          át tudunk nézni.
        </p>
      </Section>
    </ContentPage>
  );
}
