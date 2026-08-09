import type { Metadata } from "next";
import ContentPage, { Bullets, Section } from "../components/ContentPage";

export const metadata: Metadata = { title: "Szabályzat — Barkóba" };

// Every number and rule below was read from the implementation, not recalled:
// question budgets from app/api/game/create/route.ts, the flat question cost
// from the turn and ask routes, and the adjudication/integrity conditions from
// lib/resolveResult.ts. If the engine changes, this page is wrong until updated.

export default function RulesPage() {
  return (
    <ContentPage
      title="Szabályzat"
      lead="A Barkóba kérdéseken és következtetésen alapuló játék. Az alábbiak a jelenlegi V1 változat tényleges szabályai."
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

      <Section heading="Két játékmód">
        <Bullets
          items={[
            "Én gondolok valamire → az AI találja ki. Te rögzíted a titkot, az AI kérdez.",
            "Az AI gondol valamire → én találom ki. Az AI rögzíti a titkot, te kérdezel.",
          ]}
        />
        <p>
          Ember a ember elleni játék jelenleg nem érhető el.
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
