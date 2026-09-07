import type { Metadata } from "next";
import Link from "next/link";
import ContentPage, { Section } from "../components/ContentPage";

export const metadata: Metadata = { title: "Kapcsolat — Barkóba" };

// No email, address, phone or social account is invented here. None exists in
// the repository or configuration, so the page says so plainly. A made-up
// address on a contact page is the one lie a visitor will definitely discover.
//
// V2.9.1 HU MVP — "Ha hibát találsz" used to tell a player to write down
// what happened with no actual mechanism to send it anywhere. The player-
// facing feedback surface (/feedback, app/feedback/page.tsx) now exists and
// carries no gate of any kind, so this links to it directly rather than
// leaving the player to keep private notes nobody receives. This does not
// claim the inbox is actively monitored or that a reply is possible — only
// that the submission reaches the server, which is what the code does.

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
        <p>
          Ezt itt tudod elküldeni nekünk:{" "}
          <Link href="/feedback" className="underline underline-offset-2">
            Visszajelzés küldése
          </Link>
          . Regisztráció nem kell hozzá.
        </p>
      </Section>
    </ContentPage>
  );
}
