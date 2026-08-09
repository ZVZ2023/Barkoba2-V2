import type { Metadata } from "next";
import ContentPage, { Bullets, Section } from "../components/ContentPage";

export const metadata: Metadata = { title: "Adatvédelem — Barkóba" };

// Written from repository inspection only. Every claim traces to code:
//   lib/rateLimit.ts   — the IP address is part of a stored key
//   lib/gameStore.ts   — state:<id>, TTL from GAME_TTL_SECONDS (24h default)
//   lib/secretStore.ts — secret:<id>, same TTL
//   lib/callBudget.ts  — aggregate counters, no personal data
//   lib/anthropic.ts   — game text is sent to api.anthropic.com
// No cookies, analytics, localStorage or third-party scripts were found.
//
// Claims that could NOT be verified from the repository — what the hosting
// provider logs, how long those logs live — are described as unknown rather
// than asserted. Saying "we store nothing" would have been false.

export default function PrivacyPage() {
  return (
    <ContentPage
      title="Adatvédelem"
      lead="Ez az oldal azt írja le, amit a Barkóba jelenlegi V1 változatának kódjából egyértelműen meg lehet állapítani."
    >
      <Section heading="Nincs regisztráció">
        <p>
          A Barkóba V1 nem kér és nem kezel felhasználói fiókot, jelszót, e-mail-címet vagy
          profilt. Nem kell bejelentkezni a játékhoz.
        </p>
      </Section>

      <Section heading="Mit tárolunk a játék alatt">
        <Bullets
          items={[
            "A játék menetét: a kérdéseket, a válaszokat, a végső tippet és az eredményt.",
            "A rögzített titkot és annak meghatározását, a játék állapotától elkülönítve tárolva.",
            "A játék beállításait: nehézség, kérdéskeret, segítségmód.",
          ]}
        />
        <p>
          Ezek a játékazonosítóhoz kötődnek, nem személyhez. Alapértelmezetten
          <strong> 24 óra </strong> után automatikusan törlődnek, és nincs olyan funkció,
          amellyel korábbi játékok visszakereshetők lennének.
        </p>
      </Section>

      <Section heading="IP-cím">
        <p>
          A visszaélések és a költségek korlátozása érdekében a rendszer óránként számolja,
          hány játék indul egy IP-címről. Ehhez az IP-cím rövid ideig — nagyjából
          <strong> egy órán át </strong> — szerepel a tárolt számláló kulcsában, majd
          automatikusan törlődik.
        </p>
        <p>
          Ezt azért írjuk le, mert az IP-cím személyes adatnak minősülhet, és nem lenne
          igaz azt állítani, hogy semmilyen ilyen adatot nem kezelünk.
        </p>
      </Section>

      <Section heading="Amit az AI-szolgáltatónak elküldünk">
        <p>
          A játék működéséhez a szövegek — a titok, a meghatározása, a kérdések és a
          válaszok — feldolgozásra elküldésre kerülnek az Anthropic API-jának. Csak azt
          küldjük el, ami a játékhoz szükséges.
        </p>
        <p>
          Kérünk, ne írj a játékba olyan személyes vagy bizalmas információt, amelyet nem
          szeretnél elküldeni egy külső szolgáltatónak.
        </p>
      </Section>

      <Section heading="Sütik és követés">
        <p>
          A kódban nem található sütikezelés, analitika, hirdetési vagy követőszkript.
        </p>
      </Section>

      <Section heading="Amit nem tudunk pontosan megállapítani">
        <p>
          Az alkalmazást tárhelyszolgáltató üzemelteti, amely a saját rendszerében
          kiszolgálási naplókat vezethet — például IP-címet vagy hibaüzeneteket —
          függetlenül az alkalmazás kódjától. Ennek pontos tartalmát és megőrzési idejét a
          kódból nem lehet megállapítani, ezért erről nem állítunk többet, mint amit
          igazolni tudunk.
        </p>
      </Section>

      <Section heading="Ez a jelenlegi állapot">
        <p>
          Ez a V1 változatra vonatkozó tájékoztatás. Ha később fiókok, mentett játékok
          vagy többszereplős funkciók készülnek, ez az oldal frissülni fog. A szöveg nem
          jogi szakértő által ellenőrzött dokumentum.
        </p>
      </Section>
    </ContentPage>
  );
}
