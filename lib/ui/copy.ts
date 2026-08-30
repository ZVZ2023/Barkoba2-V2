// ---------------------------------------------------------------------------
// Every user-facing string, in one place.
//
// The interface language is Hungarian. This is NOT an i18n system and must not
// grow into one by accident — it is one flat object so that when a real i18n
// layer arrives there is a single file to lift, rather than fifty JSX literals
// to hunt down. That is the whole reason it exists.
// ---------------------------------------------------------------------------

export const copy = {
  brand: { name: "Barkóba", tagline: "Gondolj valamire. Az AI kitalálja." },

  header: {
    language: "HU",
    languageAria: "Nyelv",
    languageLabel: "Nyelv",
    login: "Bejelentkezés",
  },

  hero: {
    headline: ["Barkóba", "az AI korszakára."],
    support: ["Ember ↔ Ember", "Ember → AI", "AI → Ember", "AI ↔ AI"],
    primary: "Új játék indítása",
    secondary: "Hogyan működik?",
  },

  modes: {
    title: "Új játék indítása",
    subtitle: "Válassz módot.",
    humanComposer: {
      title: "Én gondolok valamire",
      subtitle: "→ az AI találja ki",
      detail: "Te zárod le a titkot. Az AI kérdez, és egyszer tippel.",
    },
    aiComposer: {
      title: "Az AI gondol valamire",
      subtitle: "→ én találom ki",
      detail: "Az AI zárja le a titkot. Te kérdezel, és egyszer tippelsz.",
    },
    back: "Vissza",
  },

  features: [
    { title: "20 kérdés", lines: ["Egy tipp.", "Semmi találgatás."] },
    { title: "Titokban marad", lines: ["A gondolatod csak a tiéd."] },
    { title: "Tiszta logika", lines: ["Nincsenek trükkök.", "Csak következtetés."] },
    { title: "Tisztességes játék", lines: ["Átlátható szabályok.", "Tisztelet mindenkinek."] },
    { title: "Mérd és tanulj", lines: ["Kövesd a teljesítményt.", "Fejleszd a stratégiád."] },
    { title: "Hívd ki az AI-t", lines: ["Ember vs AI.", "Te állítod a kihívást."] },
  ],

  howItWorks: {
    title: "Hogyan működik?",
    steps: [
      { title: "Te gondolsz valamire", lines: ["Személyre, tárgyra,", "helyre, fogalomra..."] },
      { title: "Az AI kérdez", lines: ["Igen/Nem típusú", "kérdésekkel kutat."] },
      { title: "Következtet", lines: ["Elemzi a válaszokat,", "szűkíti a lehetőségeket."] },
      { title: "Egy tippje van", lines: ["Kitalálja, mire", "gondoltál?"] },
    ],
  },

  footer: {
    tagline: "Egy gondolat. Húsz kérdés. Egy tipp.",
    rules: "Szabályzat",
    privacy: "Adatvédelem",
    about: "Rólunk",
    contact: "Kapcsolat",
    social: "Közösség",
  },

  comingSoon: {
    title: "Dolgozunk rajta.",
    body: "Ez a funkció hamarosan érkezik.",
    close: "Bezárás",
  },
} as const;
