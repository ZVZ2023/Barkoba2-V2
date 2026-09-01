// ---------------------------------------------------------------------------
// The three real human-vs-AI games played 2026-09-01 that motivated
// lib/duplicateQuestionGuard.ts. These are the ACTUAL question_text values
// from the durable corpus (corpus.game_turns, main branch, in turn order),
// not synthetic fixtures — pulled from the transcript export for:
//
//   Marcali    corpus_game_id 56d52ca3-9efe-4613-9f09-34b7a6d54170
//   Hole       corpus_game_id 8e18281f-70b1-41cd-a649-b093a85bd0c7
//   Black hole corpus_game_id 7682f01f-2be6-4853-aaf8-8e57ce6f0a9e
//
// All three: xai / grok-4.20-0309-non-reasoning, racer/4.0.0. See the
// forensic report for the full analysis; this file exists only to pin the
// exact strings the duplicate-question guard's shadow validation runs
// against, so a future edit to this file is a deliberate, reviewable change
// to the evidence, not an accidental paraphrase drift.
// ---------------------------------------------------------------------------

/** Marcali (racer_correct, 34/35 questions) — main-branch questions, in order. */
export const MARCALI_QUESTIONS: string[] = [
  "A cél valóságos, vagy valaha valóságosan létezett — tehát nem kitalált vagy fikciós?", // 1
  "Élő vagy valaha élt személy?", // 2
  "Természetes jelenség vagy tárgy, mint például egy elem, ásvány vagy természeti erő?", // 3
  "Ember alkotta tárgy vagy eszköz?", // 4
  "A cél egy absztrakt fogalom, mint például egy tudományos elmélet, matematikai tárgy vagy filozófiai idea?", // 5
  "A cél a művészetek vagy szórakozás területéhez tartozik, például zene, film, irodalom, képzőművészet vagy játék?", // 6
  "A cél egy földrajzi hely, például ország, város, hegy vagy hasonló?", // 7
  "A cél egy kontinens, ország vagy hasonló nagyobb politikai/földrajzi egység?", // 8
  "A cél egy ország, város, folyó, tó, hegy vagy más természetes képződmény?", // 9
  "A cél egy város?", // 10
  "A cél egy európai város?", // 11
  "A cél egy főváros?", // 12
  "A cél egy nyugat-európai ország fővárosa?", // 13 — logically redundant given 12, out of scope for this guard
  "A cél egy német város?", // 14
  "A cél egy kelet-európai város?", // 15
  "A cél egy magyar város?", // 16
  "A cél egy megyeszékhely?", // 17 — exact duplicate of 27
  "A cél egy megyei jogú város?", // 18
  "A cél egy megyeszékhely közelében található város?", // 19 — exact duplicate of 21
  "A cél egy dunántúli város?", // 20
  "A cél egy megyeszékhely közelében található város?", // 21 — exact duplicate of 19
  "A cél egy balatoni város?", // 22
  "A cél Veszprém megyében található?", // 23
  "A cél egy baranyai város?", // 24
  "A cél egy pécsi agglomerációhoz tartozó település?", // 25
  "A cél egy somogyi város?", // 26
  "A cél egy megyeszékhely?", // 27 — exact duplicate of 17
  "A cél Kaposvár?", // 28 — named-identity question, NOT this guard's concern
  "A cél egy balaton-parti település?", // 29 — exact duplicate of 33
  "A cél Kaposvártól délre található?", // 30
  "A cél egy somogyi megyeszékhely közelében található település?", // 31 — near-duplicate of 19/21, MUST NOT fire
  "A cél Siófok?", // 32 — named-identity question, NOT this guard's concern
  "A cél egy balaton-parti település?", // 33 — exact duplicate of 29
  "A cél Marcali?", // 34 — named-identity question, NOT this guard's concern
];

/** The three known exact-duplicate pairs in Marcali, by 1-based question number. */
export const MARCALI_KNOWN_DUPLICATE_PAIRS: Array<[number, number]> = [
  [17, 27],
  [19, 21],
  [29, 33],
];

/** Q31 — wording deliberately close to Q19/Q21 but a genuinely different (narrower) question. Must never fire. */
export const MARCALI_NEAR_DUPLICATE_INDEX = 31; // "...somogyi megyeszékhely közelében..."
export const MARCALI_NEAR_DUPLICATE_REFERENCE_INDEX = 19; // "...megyeszékhely közelében..."

/** Named-identity questions — Guess-Detector territory, explicitly out of scope for this guard. */
export const MARCALI_NAMED_IDENTITY_INDEXES = [28, 32, 34]; // Kaposvár / Siófok / Marcali

/** Black hole (racer_win_integrity_violation, 27/50 questions) — zero exact duplicates expected. */
export const BLACK_HOLE_QUESTIONS: string[] = [
  "Is the target a real thing that exists or has existed in the physical world?",
  "Is the target a fictional character?",
  "Is the target a conceptual or abstract entity, such as an idea, theory, or mathematical construct?",
  "Is the target a mathematical concept or construct?",
  "Is the target a philosophical concept or idea?",
  "Is the target a scientific concept or theory?",
  "Is the target a legal or juridical concept, such as a right, principle, or doctrine in law?",
  "Is the target a religious or spiritual concept, such as a doctrine, belief, or theological idea?",
  "Is the target related to economics, finance, or business?",
  "Is the target a linguistic or grammatical concept?",
  "Is the target related to art, literature, or cultural studies, such as a trope, motif, or narrative device?",
  "Is the target a concept from the field of psychology, such as a cognitive bias, mental process, or behavioral phenomenon?",
  "Is the target a concept from the field of logic, such as a principle, fallacy, or method of reasoning?",
  "Is the target a concept from the field of computer science, such as an algorithm, data structure, or computational principle?",
  "Is the target a concept from the field of sociology, such as a social structure, process, or phenomenon?",
  "Is the target a concept from the field of history or historiography, such as a periodization, historical method, or historiographical approach?",
  "Is the target a concept from the field of politics, government, or political theory, such as an ideology, system, or principle?",
  "Is the target a concept from the field of music theory or musicology?",
  "Is the target a concept from the field of physics, such as a principle, law, or physical phenomenon?",
  "Is the target one of the fundamental forces or interactions in physics?",
  "Is the target a specific named law or principle in physics, such as one of Newton's laws, the laws of thermodynamics, or similar?",
  "Is the target a principle or law related to thermodynamics or energy?",
  "Is the target a principle or law related to electromagnetism or electricity and magnetism?",
  "Is the target a principle or law related to mechanics or classical mechanics?",
  "Is the target a principle or law related to optics or light?",
  "Is the target a principle or law related to relativity, gravity, or quantum mechanics?",
  "Is the target a specific named phenomenon, effect, or paradox in physics?",
];

/** Hole (composer_win_integrity_upheld, 35/35 questions) — zero exact duplicates expected. */
export const HOLE_QUESTIONS: string[] = [
  "Is it a living thing?",
  "Is it a physical object?",
  "Is it a concept or idea?",
  "Is it a work of fiction, such as a book, movie, or song?",
  "Is it a person who has existed in reality?",
  "Is it a place that exists or has existed in reality?",
  "Is it a brand name or trademark?",
  "Is it a natural phenomenon?",
  "Is it a fictional entity, such as a character, creature, or organization from a story, game, or mythology?",
  "Is it a human-made creation or invention?",
  "Is it a mathematical object or entity, such as a number, set, or function?",
  "Is it something that exists or has existed in the real world?",
  "Is it an event that has occurred or occurs in the real world?",
  "Is it a historical period or era?",
  "Is it an organization, group, or institution that exists or has existed in the real world?",
  "Is it an abstract entity or concept that relates to science, technology, or philosophy?",
  "Is it a language?",
  "Is it a color?",
  "Is it a sound?",
  "Is it a specific law or legal principle that exists or has existed in the real world?",
  "Is it a celestial body or astronomical object?",
  "Is it a time-related entity, such as a specific date, year, or recurring calendar event?",
  "Is it a type of food or beverage?",
  "Is it a specific chemical element?",
  "Is it a specific instance of a man-made structure or building that exists or has existed in the real world?",
  "Is it a specific instance of a man-made object, device, or invention that exists or has existed in the real world?",
  "Is it a specific instance of a natural geographical feature that exists or has existed in the real world, such as a mountain, river, or ocean?",
  "Is it a specific instance of a man-made process, method, or procedure that exists or has existed in the real world, such as a medical treatment, manufacturing technique, or algorithm?",
  "Is it a specific instance of a man-made work of art or creative expression that exists or has existed in the real world, such as a painting, sculpture, or performance?",
  "Is it a specific instance of a man-made document, record, or written text that exists or has existed in the real world, such as a treaty, constitution, or scientific paper?",
  "Is it an emotion or feeling?",
  "Is it a specific instance of a man-made system, framework, or model that exists or has existed in the real world, such as a government, economic system, scientific theory, or educational curriculum?",
  "Is it a specific instance of a man-made game, sport, or competitive activity that exists or has existed in the real world, such as chess, the Olympics, or the World Cup?",
  "Is it a specific instance of a man-made financial instrument, agreement, or economic tool that exists or has existed in the real world, such as a stock, bond, mortgage, or cryptocurrency?",
  "Is it a specific instance of a real-world company, corporation, or business entity that exists or has existed?",
];
