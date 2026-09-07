import type { Metadata } from "next";
import ContentPage, { Bullets, Section } from "../components/ContentPage";

export const metadata: Metadata = { title: "Szabályzat — Barkóba" };

// Every number and rule below was read from the implementation, not recalled:
// question budgets from app/api/game/create/route.ts, the flat question cost
// from the turn and ask routes, and the adjudication/integrity conditions from
// lib/resolveResult.ts. If the engine changes, this page is wrong until updated.
//
// CORRECTED IN 2.9.1.2 — "jelenlegi V1 változat" is the same hardcoded-
// version mistake app/privacy/page.tsx already documents fixing twice (see
// its own 2.1.3.1 note): version-neutral phrasing now matches Privacy's.
// "Ember a ember elleni játék jelenleg nem érhető el" was also stale —
// Human-vs-Human has been live, ungated, since V2.3.0.0 (app/play/human/) —
// folded into a third mode instead of a denial. Experience modes, the
// automatic question-wording pass, and the no-spelling fairness rule were
// simply never described here; added below.

export default function RulesPage() {
  return (
    <ContentPage
      title="Szabályzat"
      lead="A Barkóba kérdéseken és következtetésen alapuló játék. Az alábbiak a jelenleg telepített változat tényleges szabályai."
    >
      <Section heading="A játék lényege">
        <p>
          Az egyik fél gondol valamire és rögzíti a titkot. A másik fél — a Kérdező —
          igen/nem típusú kérdésekkel próbálja kitalálni, mi az.
        </p>
        <p>
          A titok a feloldásig rejtve marad a Kérdező elől. A rendszer külön tárolja a
          rögzített célt, így az a játék közben nem változhat meg.
        </p>
      </Section>

      <Section heading="Három játékmód">
        <Bullets
          items={[
            "Én gondolok valamire → az AI találja ki. Te rögzíted a titkot, az AI kérdez.",
            "Az AI gondol valamire → én találom ki. Az AI rögzíti a titkot, te kérdezel.",
            "Ember a ember ellen → meghívod a másik játékost egy linkkel, és ti ketten játszotok — az AI nincs jelen egyik szerepben sem.",
          ]}
        />
      </Section>

      <Section heading="Élmény">
        <p>
          Amikor az AI gondol valamire, a hangvételt is választhatod — ez csak a
          megfogalmazást változtatja, sosem azt, mire kérdez, vagy a stratégiáját.
        </p>
        <Bullets
          items={[
            "Verseny: semleges, tömör hangvétel, díszítés nélkül.",
            "Baráti: melegebb hangvétel — a játék elején köszön, utána a kérdésre koncentrál.",
            "Tanító: időnként egy rövid megjegyzés arról, mit próbál éppen leszűkíteni.",
            "Humoros: könnyed, játékos hangvétel — a kérdés pontossága ettől nem csorbul.",
          ]}
        />
      </Section>

      <Section heading="Kérdésfinomítás">
        <p>
          Ha egy kérdés nem tiszta igen/nem formában érkezik, a rendszer
          finomíthatja a megfogalmazást — anélkül, hogy megváltoztatná, mire
          kérdezel.
        </p>
      </Section>

      <Section heading="Kérdések és költségük">
        <Bullets
          items={[
            "Amikor az AI gondol valamire, a kérdéskeret választható: 20, 35, 50 vagy 100 kérdés.",
            "Amikor te gondolsz valamire, az AI alapértelmezetten 20 kérdést kap.",
            "Minden feltett kérdés egy kérdést használ el — függetlenül attól, hogy IGEN, NEM vagy BIZONYTALAN választ kap.",
            "A BIZONYTALAN válaszok száma nincs korlátozva.",
          ]}
        />
      </Section>

      <Section heading="Válaszok">
        <p>
          A válasz IGEN, NEM vagy BIZONYTALAN lehet. A BIZONYTALAN akkor helyes, ha egy
          igen vagy nem érdemben félrevezetné a Kérdezőt — például mert a kérdés a
          célkategórián belül egyes esetekre igaz, másokra nem.
        </p>
        <p>
          A válaszoknak igaznak és tisztességesnek kell lenniük a rögzített célhoz képest.
        </p>
      </Section>

      <Section heading="Egyetlen tipp">
        <p>
          A Kérdezőnek egyetlen tippje van. Ha nem akar tippelni, feladhatja. A tipp
          leadásával a kérdezési szakasz lezárul.
        </p>
      </Section>

      <Section heading="Értékelés">
        <p>
          A tippet AI-alapú értékelés bírálja el: nem a szó szerinti egyezés számít, hanem
          hogy a tipp ugyanarra a dologra mutat-e. Az elgépelések, ragozott alakok és
          bevett szinonimák elfogadottak.
        </p>
        <p>
          Ha a tipp nem talált, vagy a Kérdező feladta, egy integritás-ellenőrzés
          átnézi a válaszokat: ellentmondtak-e a rögzített célnak. Helyes tipp esetén ez
          az ellenőrzés nem fut le.
        </p>
      </Section>

      <Section heading="Nehézség és segítség">
        <p>
          Amikor az AI gondol valamire, három nehézségi szint közül lehet választani:
          könnyű, közepes és nehéz. Nehéz fokozaton beállítható, hogy az AI adjon-e
          segítő megjegyzéseket: nincs segítség, minimális, vagy fokozatosan erősödő.
        </p>
      </Section>

      <Section heading="Tisztességes játék">
        <Bullets
          items={[
            "Ne használd ki a rendszer hibáit.",
            "Ne próbáld promptinjekcióval vagy más módon kicsalni a titkot.",
            "Ne manipuláld szándékosan a játékrendszert.",
            "Ne kérdezz betűzésre, helyesírásra vagy kiejtésre — a jelentésről és a tulajdonságokról szól a játék, nem a szóalakról.",
          ]}
        />
      </Section>

      <Section heading="Mit jelentenek az eredmények">
        <p>
          A játék kísérleti és szórakoztató célú. Az eredmények egyetlen játék
          kimenetelét mutatják, nem az AI képességeinek mérőszámai.
        </p>
      </Section>
    </ContentPage>
  );
}
