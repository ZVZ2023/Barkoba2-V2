import type { Metadata } from "next";
import ContentPage, { Bullets, Section } from "../components/ContentPage";

export const metadata: Metadata = { title: "Adatvédelem — Barkóba" };

// Written from repository inspection only. Every claim traces to code:
//   lib/rateLimit.ts   — the IP address is part of a stored key
//   lib/gameStore.ts   — state:<id>, TTL from GAME_TTL_SECONDS (24h default)
//   lib/secretStore.ts — secret:<id>, same TTL
//   lib/callBudget.ts  — aggregate counters, no personal data
//   lib/anthropic.ts   — game text is sent to api.anthropic.com
//   lib/playerIdentity.ts / middleware.ts — two functional cookies (V2)
//
// CORRECTED IN 2.1.2.0. This page previously stated that no cookie handling
// existed. That was true of V1 and became false in 2.1.1.0, when the anonymous
// Player identity cookie shipped — the page was not updated with it. No
// analytics, advertising or third-party tracking script exists; both cookies
// are functional and neither is used to track anyone across sites.
//
// CORRECTED AGAIN IN 2.1.3.1. The substance above was right, but the page still
// framed itself as describing "V1" while documenting V2.1 identity protection,
// recovery codes and deletion — a public page contradicting its own version
// label. The framing is now version-neutral ("jelenleg telepített változat") on
// purpose: a hardcoded milestone number is what went stale here twice, and the
// visible build number already lives in the footer via getAppVersion().
//
// Claims that could NOT be verified from the repository — what the hosting
// provider logs, how long those logs live — are described as unknown rather
// than asserted. Saying "we store nothing" would have been false.

export default function PrivacyPage() {
  return (
    <ContentPage
      title="Adatvédelem"
      lead="Ez az oldal azt írja le, amit a Barkóba jelenleg telepített változatának kódjából egyértelműen meg lehet állapítani."
    >
      <Section heading="Nincs regisztráció">
        <p>
          A Barkóba nem kér és nem kezel felhasználói fiókot, jelszót, e-mail-címet vagy
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

      <Section heading="Sütik">
        <p>
          A Barkóba két sütit használ, és mindkettő a játék működéséhez kell. Egyik sem
          szolgál analitikára, hirdetésre vagy oldalak közötti követésre — ilyen szkript
          nincs a kódban.
        </p>
        <Bullets
          items={[
            "Egy azonosító süti, amely egy véletlenszerű, önmagában semmit el nem áruló számot tárol. Ez az, ami alapján ugyanaz a böngésző visszatéréskor ugyanaz a játékos marad. Nincs benne név, e-mail cím vagy bármi, ami rád mutatna.",
            "Egy név süti, de csak akkor, ha megadsz egy megszólítást — vagy ha a kérdést kihagyod. A kihagyást is el kell tárolnunk, különben minden alkalommal újra megkérdeznénk.",
          ]}
        />
        <p>
          Nincs regisztráció, nincs jelszó, és nincs fiók. A sütik a böngésződben élnek:
          ha törlöd őket, a hozzájuk tartozó játékos és a megadott név is elvész, és
          újként indulsz. Másik eszközön nem lehet visszaszerezni őket.
        </p>
        <p>
          A megadott név szabadon választható, nem kell a valódi nevednek lennie, és
          jelenleg csak neked jelenik meg.
        </p>
      </Section>

      <Section heading="Ha megvéded a játékosodat">
        <p>
          Alapesetben minden a böngésződben marad, és a szervereinken nem őrzünk meg
          rólad semmit a játék 24 órás állapotán túl. Ha viszont a játék végén úgy
          döntesz, hogy megvéded a játékosodat, akkor ehhez tartósan eltárolunk három
          dolgot:
        </p>
        <Bullets
          items={[
            "A játékosod azonosítóját — ugyanazt a véletlen számot, ami eddig is csak a böngésződben volt.",
            "A megadott megszólítást, ha adtál meg ilyet. Enélkül másik eszközön nem tudnánk visszaadni.",
            "A helyreállító kódod ellenőrzőjét. Magát a kódot nem tároljuk el sehol: csak egy olyan matematikai lenyomatot, amiből a kód nem állítható vissza. Ezért nem is tudjuk neked újra megmutatni, ha elveszik.",
          ]}
        />
        <p>
          Ez nem regisztráció: nincs e-mail cím, nincs jelszó, és nincs fiók. A
          helyreállító kód birtokosa férhet hozzá a játékoshoz, ezért érdemes ugyanúgy
          vigyázni rá, mint egy kulcsra.
        </p>
        <p>
          Bármikor törölheted a védett játékosodat a játék végi képernyőn. A törlés
          végleges: a tárolt azonosító, a név és a helyreállító kód ellenőrzője is
          megszűnik, a kódod többé nem működik, és újként indulsz tovább.
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
          Ez a jelenleg telepített változatra vonatkozó tájékoztatás. Ha később fiókok, mentett játékok
          vagy többszereplős funkciók készülnek, ez az oldal frissülni fog. A szöveg nem
          jogi szakértő által ellenőrzött dokumentum.
        </p>
      </Section>
    </ContentPage>
  );
}
