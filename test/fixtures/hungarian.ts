// ---------------------------------------------------------------------------
// Hungarian Guess-Detector fixtures.
//
// ⚠ NEEDS A NATIVE-SPEAKER PASS BEFORE THIS IS TRUSTED.
//
// These are Barkóba-style Hungarian phrasings written to exercise the detector,
// not transcripts of real play. They are plausible and grammatical, but they
// have not been validated by a native speaker, and phrasing that is merely
// grammatical can still be phrasing no Hungarian player would actually type.
// Tuning a detector against fixtures that misrepresent real usage produces a
// detector that is confidently wrong.
//
// Review protocol: read each line as "would a Hungarian Racer actually write
// this?". Fix the phrasing, don't fix the classification — if a corrected line
// then lands on the wrong side of the threshold, that is a real finding about
// the rules, which is the entire point of the fixture set.
//
// Scope is deliberately narrow: enough coverage to close the specific gap
// documented in docs/DESIGN-NOTES.md §5. This is not a Hungarian NLP project.
// ---------------------------------------------------------------------------

/** Guesses stated outright. The Racer is naming the target. */
export const HU_EXPLICIT_GUESSES: string[] = [
  "A tippem az Eiffel-torony.",
  "Arra gondolsz, hogy ez egy csavarhúzó?",
  "A fűnyíródra gondolsz?",
  "A megfejtés a piros bicikli?",
  "A titkod egy hangszer?",
  "Tippelek: ez egy kalapács.",
  "A válasz az, hogy kutya?",
  "Ez a végső válaszom: a Duna.",
];

/**
 * Guesses that name a specific instance in the Composer's world without using
 * any guess vocabulary. This is the class the English-only detector missed
 * entirely — Hungarian marks "your X" with a suffix, not a separate word.
 */
export const HU_DESCRIPTIVE_GUESSES: string[] = [
  "Ez a fűnyíród fogantyúja?",
  "A kerékpárod kormánya az?",
  "Ez a konyhád csaptelepe?",
  "A nagyapád órája az?",
  "Ez az autód kormánykereke?",
  "A kutyád nyakörve az?",
];

/** Ordinary narrowing questions. These must stay out of the net. */
export const HU_NARROWING_QUESTIONS: string[] = [
  "Ez egy fizikai tárgy?",
  "Tárgy ez, vagy élőlény?",
  "Nagyobb ez, mint egy kenyérpirító?",
  "Ember alkotta dolog?",
  "Elfér a kezedben?",
  "Van mozgó alkatrésze?",
  "Ez egy hétköznapi használati tárgy?",
  "Élőlény-e?",
  "Konyhában szoktad használni?",
  "Fémből készült?",
  "Ez valamilyen szerszám?",
  "Régebbi, mint száz év?",
];
