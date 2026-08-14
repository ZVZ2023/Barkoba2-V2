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
// UPDATED IN 2.2.0.0, IN THE SAME RELEASE AS THE CHANGE IT DESCRIBES. Durable
// game records (lib/corpus/*) mean the previous claim — that nothing survives
// the 24h game state — became false the moment corpus writes were switched on.
// This page ships with that change rather than after it, because the 2.1.1.0
// cookie omission recorded above is exactly what happens otherwise.
//
// Two things are stated plainly rather than glossed:
//   - failed and abandoned games are kept on purpose, not by oversight;
//   - player deletion UNLINKS, and unlinking is not anonymization, because the
//     free text is the player's own words. Claiming otherwise would be the
//     comfortable lie.
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
          Ez a játék élő munkapéldánya: a játékazonosítóhoz kötődik, nem
          személyhez, és <strong>24 óra</strong> után automatikusan törlődik.
          Jelenleg nincs olyan felület, amelyen korábbi játékokat vissza
          lehetne nézni.
        </p>
        <p>
          A ténylegesen lejátszott játékokból ezen felül tartós másolat is
          készül — lásd lentebb a „Megőrzött játékok” részt.
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
          Alapesetben a játékosazonosítód a böngésződben marad, és nem tárolunk
          róla semmit a szervereinken. (A lejátszott játékok megőrzése ettől
          független — arról a „Megőrzött játékok” rész szól.) Ha a játék végén úgy
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

      <Section heading="Megőrzött játékok">
        <p>
          A Barkóba mostantól tartósan megőrzi azokat a játékokat, amelyekben
          legalább egy kérdés és válasz ténylegesen lezajlott. Ez a játék 24 órás
          munkapéldányán túl él, és nem törlődik magától.
        </p>
        <Bullets
          items={[
            "A játék menetét: a kérdéseket, a válaszokat, a tippet és az eredményt, időrendben.",
            "A játék beállításait: nehézség, kérdéskeret, nyelv, ki volt a kérdező és ki válaszolt.",
            "A megfejtést és annak meghatározását — de csak akkor, ha a játék le is zárult, és a megfejtés amúgy is láthatóvá vált. A félbehagyott játékoknál ez nem kerül eltárolásra.",
            "Ha van azonosított játékosod, azt is, hogy melyik játékos játszotta.",
          ]}
        />
        <p>
          A félbehagyott, megszakadt és sikertelen játékokat is megőrizzük, ha
          volt bennük legalább egy lezajlott kérdés-válasz. Ez szándékos: a
          félresikerült játék ugyanannyit elárul a játék működéséről, mint a
          sikeres. Amiben egyetlen kérdés sem hangzott el, abból nem lesz
          megőrzött játék.
        </p>
        <p>
          Miért: a Barkóba ezekből tanulja meg, hol hibázik — hol kérdez rosszul
          az AI, hol válaszol ellentmondásosan, hol dönt tévesen. Ehhez valódi
          játékok kellenek.
        </p>
        <p>
          Ez jelenleg egy nyilvánosság előtti, zárt teszt- és kutatási szakasz. A
          nyilvános indulás előtt ezt a részt újra kell gondolni, és ez az oldal
          frissülni fog.
        </p>
      </Section>

      <Section heading="Ha másik emberrel játszol">
        <p>
          A másik emberrel játszott játékokban a titkodat a szerver őrzi, és a
          kérdező nem kapja meg — sem az oldalon, sem a háttérben futó
          adatforgalomban. Csak a játék végén, az eredménnyel együtt derül ki.
        </p>
        <p>
          Amit a másik játékos lát: a kérdéseket, a válaszaidat, és a megadott
          megszólításodat, ha van ilyen. Ez az első helyzet a Barkóbában, ahol a
          neved egy másik ember számára is látszik — ha ezt nem szeretnéd, hagyd
          ki a nevet, vagy válassz becenevet.
        </p>
        <p>
          A meghívó link egyetlen játékhoz szól, és amint a második játékos
          csatlakozott, harmadik már nem tud belépni.
        </p>
      </Section>

      <Section heading="Játékkeret">
        <p>
          A játékindításhoz játékkeret tartozik. Amikor kapsz vagy felhasználsz
          belőle, arról tartós bejegyzés készül: mennyi, mikor, milyen jogcímen
          (ajándék vagy vásárolt), és melyik játékhoz lett felhasználva. Ez a
          játékosazonosítódhoz kötődik, nem a nevedhez.
        </p>
        <p>
          A bejegyzések utólag nem módosulnak és nem törlődnek — egy tévedést új
          bejegyzés javít, hogy a javítás is nyomon követhető maradjon. Ez teszi
          ellenőrizhetővé, mennyi keretet kaptál és mennyit használtál el.
        </p>
        <p>
          Ha valaha fizetett keretet kapsz, ahhoz helyreállítható játékos kell,
          hogy a böngésződ törlése ne vigye el a kifizetett értéket. Ezért ilyen
          esetben — ha még nincs — automatikusan létrejön a helyreállító kódod.
          Az ajándékkeret ilyet nem igényel: ha ajándékkerettel játszol és
          elveszted a sütidet, a fel nem használt rész elvész.
        </p>
      </Section>

      <Section heading="Ha törlöd a védett játékosodat">
        <p>
          A törlés leválasztja a megőrzött játékokat a játékosodról: a
          játékosazonosító eltűnik mellőlük, és nem lesz visszakereshető, hogy
          melyik játékot te játszottad.
        </p>
        <p>
          Amit viszont őszintén el kell mondanunk: maguk a játékok megmaradnak. A
          bennük szereplő szöveg — a megfejtés, a kérdések, a tippek — a te
          szavaid, és tartalmazhat rád vonatkozó információt akkor is, ha az
          azonosító már nincs mellette. A leválasztás tehát nem teljes
          névtelenítés, és nem is állítjuk annak.
        </p>
        <p>
          Ha ez zavar, a legbiztosabb, ha nem írsz a játékba olyat, amit nem
          szeretnél megőrizve látni.
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
