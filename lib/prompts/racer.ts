import { DEFAULT_RACER_PROVIDER, getAdapter } from "../providers";
import { env } from "../env";
import type { ModelProviderId, ToolCallResult } from "../providers/types";
import { validateCandidateMove, type LayerTwoCandidate, type LayerTwoState } from "../layerTwo";
import type {
  GuessIntentResolution,
  ModelProvenance,
  RacerPublicState,
  RacerTurnOutput,
} from "../types";

/**
 * V2.5 — the identity of the Racer's strategy, bumped BY HAND whenever
 * RACER_SYSTEM_PROMPT changes.
 *
 * WHY NOT DERIVE IT FROM commit_sha. The corpus already records app_version and
 * commit_sha, and while one prompt exists per deployment those locate the exact
 * source text and are a working proxy. They stop being one the moment two Racer
 * variants run at a single commit — which is the entire point of V2.5
 * benchmarking, so the proxy expires exactly when it starts to matter.
 *
 * WHY NOT HASH THE PROMPT. A hash changes on a typo fix and says nothing about
 * whether the strategy changed. A deliberate label is a claim someone made on
 * purpose, which is what a benchmark comparison needs to rest on.
 *
 * THE FAILURE MODE THIS CARRIES: a changed prompt with an unbumped constant
 * produces confidently mislabelled evidence, which is worse than no label.
 * Treat bumping this as part of editing the prompt, not as follow-up.
 *
 * `racer/X.Y.Z` IS A LOAD-BEARING DATABASE CLAIM, NOT A LABEL.
 *
 * It asserts one specific thing about every turn it is stamped on: that the
 * canonical CORE_RACER_RULES block below was present, verbatim, in the message
 * the model actually received. Corpus queries will be run against that claim,
 * so the claim has to be true by construction rather than by discipline.
 *
 * It is made true by assertGuidanceApplied(), which inspects the ASSEMBLED
 * message immediately before the call and throws if the block is missing. A
 * turn cannot therefore be stamped with this version unless the guidance was
 * genuinely there — the call fails first. That converts "someone remembered to
 * bump the constant" into a structural guarantee.
 *
 * THE CLAIM COVERS EVERY PATH THAT CAN AUTHOR THE QUESTION THE HUMAN SEES.
 * There are two: runRacerTurn(), and resolveGuessIntent() when it resolves
 * `continue_questioning` and returns a revised_question that REPLACES the
 * original. Both assemble the block and both are guarded. Covering only the
 * first would make this version true of a draft and false of the record.
 *
 * RG #3 — `racer/3.0.0` REPLACES `racer/2.7.0`, NOT A REFINEMENT OF IT.
 *
 * RG v2 (structured deliberation, seven numbered stages) improved local
 * continuity but did not give the Racer an explicit model of what remains
 * unknown — see the RG #3 build brief's diagnosis: it either over-drills one
 * dimension (Grok, GAZ-13: 49/50 → Volga, wrong sibling within the right
 * family) or under-explores before committing (Claude, GAZ-13: 31/50 →
 * Porsche 911, premature conviction). RG v3 replaces the seven-stage
 * deliberation with an explicit uncertainty-management loop — KNOWN / UNKNOWN
 * / HYPOTHESES / NEXT QUESTION OPTIONS / SELECT / CHECK — per the brief's own
 * §20 minimum-implementation recommendation: one compact structured block in
 * the same single call, not a new backend system, not an additional model
 * call, not a domain ontology. §21 of that brief is explicit about what NOT
 * to build yet, and none of it is built here.
 *
 * THE REQUIRED §22 BENCHMARK (GAZ-13, 50 questions, both providers, compared
 * against the RG v2 baselines above) HAS NOT BEEN RUN AS OF THIS COMMIT — no
 * Anthropic or xAI credentials were available in the build session. See
 * docs/DESIGN-NOTES.md §45 for the tracked follow-up. Do not treat this
 * version as field-validated until that comparison exists.
 *
 * `racer/3.1.0` — TWO TARGETED ADDITIONS, NOT A REWRITE.
 *
 * racer/3.0.0's first live field test (GAZ-13/Chaika, Grok, 49/50 — a real
 * win) surfaced two specific remaining gaps, not a wrong architecture: (1)
 * geography/nationality was still enumerated country-by-country rather than
 * partitioned by a broader region first, despite SELECT's existing
 * "partition before you enumerate" guidance — descriptive preference proved
 * too weak, so CHECK gained a Hierarchy gate that can reject and regenerate
 * a sibling-level question outright; (2) Claude guessed "Volga" immediately
 * after confirming the broader category "Russian/Soviet luxury automobile"
 * without checking whether a neighboring specific candidate was equally
 * consistent — BEFORE ANY FINAL GUESS gained two inserted sentences making
 * explicit that confirming a category does not eliminate a specific rival
 * inside it, and that the compared alternative must be named specifically.
 * Every existing sentence in racer/3.0.0's text is unchanged; both are pure
 * additions. Still no GAZ-13-specific vocabulary — the two new gate items
 * are worded exactly as domain-generally as the rest of the block, per the
 * brief's own §17 constraint, restated for this pass.
 *
 * Also not yet field-validated beyond the one Grok run above — same
 * no-credentials constraint as racer/3.0.0. See docs/DESIGN-NOTES.md §47.
 *
 * `racer/3.2.0` — TWO MORE TARGETED ADDITIONS, STILL NOT A REWRITE.
 *
 * racer/3.1.0's field test (Hungarian sheepdog breed) showed the Hierarchy
 * gate and the strengthened validation gate both working, and surfaced two
 * further specific gaps: (1) once a dimension was confirmed by a YES, the
 * Racer kept re-probing that same neighborhood — a sibling of the confirmed
 * value, an edge case of it, a more precise variant of it — instead of
 * treating it as resolved and moving to a different unresolved dimension;
 * EVIDENCE-RESPONSE BEHAVIOR's existing YES guidance already says this in
 * prose ("not license to spray further candidates within the branch you
 * just confirmed") but, like SELECT's pre-3.1.0 partition preference, prose
 * alone was not enough — so CHECK gained a Resolved-branch gate that can
 * reject and regenerate the question outright, the same escalation
 * Hierarchy already used for the equivalent geography gap; (2) once
 * HYPOTHESES had narrowed to two or three very similar candidates, generic
 * descriptive questions kept being asked instead of the one property that
 * actually separates that specific pair — so CHECK also gained a
 * Close-candidate-specificity gate requiring the selected question to name
 * the discriminator between THOSE remaining candidates, not a broad
 * attribute that could be true of either. Every existing sentence in
 * racer/3.1.0's text is unchanged; both are pure additions, and both are
 * CHECK-stage gates rather than softer SELECT-stage preferences, matching
 * how Hierarchy was built. Still no benchmark-specific vocabulary — no dog
 * breed, coat, ear, or Hungary/Romania/Czech Republic wording appears below;
 * the two new gate items are worded exactly as domain-generally as the rest
 * of the block.
 *
 * Also not yet field-validated beyond that one run — same no-credentials
 * constraint as every version above. See docs/DESIGN-NOTES.md §49.
 *
 * `racer/4.0.0` — A COMPRESSION AND RESTRUCTURE, NOT AN ADDITIVE PASS.
 *
 * Every prior RG #3 pass (3.0.0 → 3.2.0) added gates onto a growing ~800-word
 * block. Four field tests across that lineage — GAZ-13/Grok (won messily:
 * right family, wrong sibling, sibling enumeration before partition),
 * GAZ-13/Claude (premature conviction before the alternative was ruled out),
 * and two from the Hungarian-sheepdog run (a close-candidate pair decided by
 * a generic property instead of the one that actually separated them, and a
 * confirmed dimension re-probed instead of treated as resolved) — were each
 * individually fixed by an added gate, and each fix held. The length itself
 * became the next risk: a long, checklist-heavy block invites the model to
 * satisfy each rule locally while losing the single coherent stance the
 * rules exist to produce, and crowds out exactly the "zoom out and reopen
 * the parent frame" judgment none of the individual gates can substitute
 * for.
 *
 * `racer/4.0.0` REPLACES the nine-stage v3 text with a six-stage loop — KNOWN
 * / UNKNOWN / HYPOTHESES / SELECT / RED FLAGS / BEFORE ANY FINAL GUESS — at
 * roughly half the length. NEXT QUESTION OPTIONS and the separate
 * EVIDENCE-RESPONSE BEHAVIOR / DIMINISHING RETURNS sections are folded into
 * SELECT and RED FLAGS rather than kept as standing text; CHECK's five
 * paragraph-length gates become six one-line RED FLAGS. The two/three-related
 * NOs reopen-the-parent-frame instruction — the single biggest remaining
 * defect the v3.2.0 field test still showed — moves out of the old
 * EVIDENCE-RESPONSE BEHAVIOR appendix and into SELECT itself, ahead of RED
 * FLAGS. A new pressure test — "would a reasonably informed human still be
 * seriously considering that alternative" — is added to BEFORE ANY FINAL
 * GUESS as a cheap, general check against overconfidence, independent of any
 * specific discriminator having been identified.
 *
 * Every one of the four field-test fixes was verified still present in the
 * compressed text, phrase by phrase, before this version was cut — see
 * docs/DESIGN-NOTES.md §50 for the full four-way cross-check. This is a
 * restructure of wording, not a change of policy: nothing the v3.2.0 gates
 * enforced is dropped, only reworded and, in three cases, merged with an
 * adjacent rule. Still no benchmark-specific vocabulary of any kind.
 *
 * NOT YET FIELD-VALIDATED. No live game has been played against this text —
 * same no-credentials constraint as every version above. The compression
 * hypothesis itself (shorter reads better under repeated injection) is
 * untested until Zsolt plays it.
 *
 * `racer/4.0.1` — FINAL-ACTION CONTRACT ONLY. NOT A REASONING CHANGE.
 *
 * V2.8.4.3 hotfix, following the "PC" concede-at-final-turn incident: the
 * Racer could legitimately choose CONCEDE, including on the forced final
 * turn once the question budget was exhausted, and a truthful "the AI gave
 * up" outcome resulted. The product rule from this point on is absolute: the
 * Racer never voluntarily concedes, and its final action is always a guess.
 *
 * The bump covers exactly two things, both in turnInputSchema() and the
 * system-prompt paragraph describing the action contract: "concede" is
 * removed from the action enum on every ordinary turn, not only the forced
 * final one, and the forced-final enum is narrowed to the single value
 * "guess". CORE_RACER_RULES — the KNOWN / UNKNOWN / HYPOTHESES / SELECT /
 * RED FLAGS / BEFORE ANY FINAL GUESS uncertainty-management loop this
 * constant's history above documents — is byte-for-byte unchanged. This is
 * not a RG #3/#4 reasoning revision; it is a change to what moves exist, not
 * to how the Racer chooses among them.
 *
 * A provider that still returns "concede", or any action outside the
 * permitted set for the call it was given, is now a schema violation:
 * runRacerTurn() throws rather than accept it or translate it into a
 * fabricated guess. That throw surfaces exactly like any other provider
 * failure — the pre-existing racer_unavailable technical-recovery path in
 * app/api/game/[id]/turn/route.ts — so a malformed response can end in a
 * retry-eligible technical failure, never in a false Setter victory.
 *
 * `racer/5.0.0` — THE LAYER TWO REASONING ENGINE. A MAJOR bump, not a
 * refinement, because the move contract itself grew: every ordinary turn's
 * schema now asks for (dimension, question_kind, proposition_id,
 * parent_proposition, predicate_strength) alongside action/question_text/
 * guess_text/rationale — see turnInputSchema() and lib/layerTwo.ts.
 *
 * WHAT ACTUALLY CHANGED. Two additive things, not a rewrite:
 *   1. The schema gained the Layer Two fields above. V2.8.5 ENGINE-CONTRACT
 *      CORRECTION (defect 1) — these are REQUIRED (present, well-formed,
 *      non-null) on every ordinary "question" response; null is permitted
 *      only for guess/clue, which never carry Layer Two metadata at all.
 *      They started out optional in the original patch, which let a model
 *      bypass every deterministic rule below simply by omitting them — see
 *      lib/layerTwo.ts's own doc on what mechanical enforcement over
 *      DECLARED metadata can and cannot do (it cannot judge whether a
 *      well-formed declaration is semantically honest; it can and does
 *      reject a missing or malformed one outright).
 *   2. A new guidance block (LAYER_TWO_SHARED_RULES, plus a per-sandbox
 *      card block selected by renderLayerTwo()) is appended to the message
 *      Layer Two's own turns receive, teaching the model the branch-graph
 *      mental model: stable vs. typical evidence, the progress lease, the
 *      soft-premise audit, controlled IS-IS operationalization, and
 *      sandbox-aware dimension priority for Living/Physical/Place.
 *
 * WHAT DID NOT CHANGE. CORE_RACER_RULES — the KNOWN / UNKNOWN / HYPOTHESES /
 * SELECT / RED FLAGS / BEFORE ANY FINAL GUESS loop — is byte-for-byte
 * unchanged and still unconditionally required on every turn (Event and
 * Abstract, which have no frozen card, lean on it directly). Layer Two's
 * guidance supplements it for the three carded sandboxes; it does not
 * replace it. Phase One (lib/phaseOne.ts) is untouched.
 *
 * DETERMINISTIC ENFORCEMENT, NOT JUST GUIDANCE. Unlike CORE_RACER_RULES —
 * which is entirely advisory prose the model chooses to follow — several of
 * Layer Two's rules are mechanically checked against the DECLARED metadata
 * before a move is accepted: hard-parent closure, typical-evidence-cannot-
 * open-a-child, the one-shot IS-IS operationalization cap, the two-
 * non-progress dimension stall, and the one-per-game sandbox repair (see
 * lib/layerTwo.ts's validateCandidateMove). A violation throws exactly like
 * a no-concession schema violation — the existing racer_unavailable
 * technical-recovery path, never a fabricated outcome.
 */
export const RACER_PROMPT_VERSION = "racer/5.0.0";

/**
 * RG #4 — THE CANONICAL TRAILING UNCERTAINTY-MANAGEMENT BLOCK.
 *
 * This is the only experimental variable. The system prompt, transcript,
 * provider routing, model selection and call topology remain unchanged. The
 * block stays last before the instruction to act and is shared by both paths
 * that can author the player-facing question.
 *
 * THE TEXT IS CANONICAL. It is reproduced verbatim in docs/DESIGN-NOTES.md §50
 * against `racer/4.0.0`. Editing it without bumping the version breaks the
 * database claim above.
 *
 * ~400 WORDS, DOWN FROM ~800. See the racer/4.0.0 history note above for why:
 * length itself had become the risk, not any missing rule.
 *
 * DELIBERATELY DOMAIN-GENERIC, CARRIED FORWARD FROM RG #3. No vehicle,
 * geography, era, breed, or manufacturer vocabulary appears below on
 * purpose — a benchmark target exists to test whether the Racer discovers
 * the relevant dimensions on its own, not whether this text names them for
 * it.
 */
export const CORE_RACER_RULES = `RACER GUIDANCE V4 — UNCERTAINTY-MANAGEMENT LOOP — APPLY EVERY TURN

Before every turn, hold this state internally. Emit only the resulting question or guess.

KNOWN
Every hard YES, NO, and AMBIGUOUS answer so far. These are filters, not suggestions — nothing later may contradict one. AMBIGUOUS is informative failure, not a soft answer: it means the last question conflated two things a truthful answerer could not separate. Isolate one of them next; never re-ask a paraphrase of it.

UNKNOWN
The open dimensions that actually matter for this target's domain — discovered from the target itself, not a fixed checklist. Which one, if answered, would most shrink what remains possible?

HYPOTHESES
The leading family or families still consistent with KNOWN, plus the single strongest credible alternative. Keep this small and live, never a single premature favorite.

SELECT
Prefer the question that most usefully divides current HYPOTHESES over one that only confirms the leader. A broad split across an unresolved dimension beats naming siblings one at a time. After two or three related NOs on the same branch, stop — that is a signal, not a coincidence — and ask whether the parent frame itself is wrong before trying more siblings.

RED FLAGS — reject and regenerate if the question:
- Contradicts anything in KNOWN
- Re-probes a dimension already settled by a YES or a NO — a sibling within it, an edge case, or a more precise variant of the same confirmed value
- Names one specific sibling while a broader grouping one level up still has multiple live alternatives
- Is a disguised identity question — naming a candidate is a GUESS, not a question
- Investigates spelling, letters, or name structure instead of meaning and properties
- Targets two or three very similar remaining candidates with something generic or descriptive rather than the one property that specifically separates them

BEFORE ANY FINAL GUESS
Name the leader and the strongest remaining alternative — specifically, not a vague sense that others remain. Which facts support the leader and not equally the alternative? Have I asked the single discriminator that would most separate them? Would a reasonably informed human, given everything established so far, still be seriously considering that alternative — if yes, I am not ready to guess. Does the leader violate any fact in KNOWN? If an important discriminator remains unasked and budget allows, ask it instead of guessing.`;

// ---------------------------------------------------------------------------
// V2.8.5 — LAYER TWO REASONING ENGINE guidance.
//
// Injected ADDITIONALLY to CORE_RACER_RULES (never in place of it) once
// Phase One has handed off a real sandbox. Unlike CORE_RACER_RULES this text
// is NOT byte-verified against a version constant — it changes shape per
// sandbox (renderLayerTwo() below selects the card) and per turn (the stall/
// blocked-proposition summary is live state), so there is nothing fixed to
// hash against the way there is for the one canonical trailing block.
// ---------------------------------------------------------------------------

export const LAYER_TWO_SHARED_RULES = `LAYER TWO — SCOPE-AWARE BRANCH GRAPH, NOT A QUESTIONNAIRE.

You are past the opening classification. What follows governs every question and the final guess.

DECLARE METADATA WITH EVERY MOVE, AND DECLARE IT COMPLETELY. Alongside your question or guess, declare: dimension (the open question your move addresses — pick a short stable label and reuse it exactly when you return to that dimension), question_kind (branch_gate / discriminator / premise_audit / operationalization / adaptive_partition / guess), proposition_id (a short stable key for the specific claim this move tests — reuse it if you ever revisit exactly this claim), parent_proposition (the proposition_id this move depends on, if any — explicitly null if none), predicate_strength (stable / typical), and sandbox_repair (true only on the one move that spends your single repair, false otherwise), declared BEFORE you see the answer and never relabeled afterward. An ordinary question missing any of dimension, question_kind, proposition_id, or predicate_strength is rejected outright and never reaches the Setter — omitting metadata is not a way to avoid these rules.

STABLE vs. TYPICAL — DECLARE HONESTLY, THIS IS NOT ABOUT HOW CONFIDENT THE ANSWER SOUNDS. A predicate is STABLE when it is a defining or near-defining property — hard to be true of the target only sometimes. A predicate is TYPICAL when it is a common but non-defining tendency — a confident "yes, usually" answer is still typical. "Is storage its primary purpose?" is stable. "Is it often carried?" is typical, even answered with total certainty. IS-IS on a theoretically stable predicate stays CONTESTED, not stable.

THE PROGRESS LEASE. Answer polarity does not matter — several NOs while tightening a legitimate partition are progress; two confident YESes that settle nothing are not. Each question in your current dimension must produce at least one of: a stable hard constraint, a hard branch opening or closing, a legitimate scalar/bounded refinement, or resolution of a declared Leader/Rival separator. Two consecutive questions in the same dimension with none of these stall that dimension — switch dimension, or resolve the specific contested proposition first. A hard rejection of a parent proposition blocks every descendant of it immediately, without waiting for a stall.

TYPICAL EVIDENCE NEVER OPENS A CHILD. If a branch became attractive mainly through typical (soft) evidence and then stalls, do not keep descending it. Ask ONE stable premise_audit question testing its primary purpose or defining role before any further question in that branch. A stable NO to the audit closes the entire branch; a stable YES lets you continue. A premise_audit is ALWAYS an audit OF something: parent_proposition is REQUIRED (never null) and MUST be the exact proposition_id of the typically-supported proposition you are auditing — the one whose soft (typical) evidence stalled. If you cannot name that specific proposition_id, you do not have a genuine premise to audit — declare an ordinary discriminator/branch_gate instead, never a premise_audit with no parent. A premise_audit naming the wrong parent, or none, is rejected outright and never reaches the Setter.

IS-IS LOCKS NOTHING. IS-IS never means YES, never means NO, never creates progress, never opens or closes a branch. When IS-IS answers a mandatory sandbox gate or a declared Leader/Rival separator, you may ask exactly ONE narrower operationalization of that same proposition (question_kind "operationalization", parent_proposition set to the contested one). If that also comes back IS-IS, mark it contested in your own reasoning and switch dimension — never a third reformulation. An ordinary typical-strength question answered IS-IS does not earn an automatic follow-up.

NEVER NAME A CANDIDATE IN AN ORDINARY QUESTION. "Is it a stapler?", "Is the target Kaposvár?", "Is your answer Apple?" are guesses, not questions, regardless of phrasing — declare them as action "guess". Before your final guess, ask only property-based separators; never enumerate siblings publicly one by one.

GUESS TIMING. Do not guess merely because you feel confident. While questions remain, prefer one more stable confirmation or a Leader/Rival separator over guessing early — and do not spend remaining questions on redundant reassurance, typical-property trivia, or naming sibling candidates as questions. Before guessing, satisfy yourself that: the leader contradicts no hard evidence; you have identified the closest serious rival where one exists; at least one stable separator favors the leader, or no meaningful rival remains identifiable; and no unresolved soft premise is silently propping up the guess. If your questions run out before this is fully satisfied, guess your best available leader anyway on the forced final turn — an incomplete certificate is never a reason to concede, which is not an available move.

ONE CONTROLLED SANDBOX REPAIR. The opening classification is presumptively binding, not absolutely irreversible — but you get exactly one repair, ever, in this game. Use it only when hard evidence directly contradicts a defining invariant of the current sandbox, or the current sandbox has reached a genuine dead end with no branch consistent with the ledger. Declare it by setting sandbox_repair true on that one move, sandbox_repair_reason to "invariant_contradiction" or "structural_dead_end", and sandbox_repair_to to the ONE different sandbox (living / physical / place / event / abstract) you propose instead — all three are required together, and sandbox_repair_to must differ from the current sandbox. Ask exactly one orthogonal question aimed at the specific contradiction — never restart or repeat the opening classification. A YES activates the proposed sandbox for everything that follows. A NO keeps the current sandbox — the repair is still spent either way. An IS-IS leaves the question genuinely unresolved: neither sandbox is confirmed, the repair is still spent, and you continue with cross-cutting stable discriminators rather than open-ended general reasoning or a second attempt.

SCOPE MATTERS. You were told whether the target is a kind/category or one particular instance. Use it: a kind-scoped gate asks whether the target NAMES a kind ("Does the target name a kind of X?"); a particular-scoped gate asks whether THIS SPECIFIC target IS one ("Is this specific target itself an X?"). Do not let scope sit unused.`;

/**
 * Living — production card (section 10). V2.8.5 ENGINE-CONTRACT CORRECTION
 * (defect 2) — the whole-organism gate's route was previously described in
 * one static block covering both readings, leaving the model to infer which
 * applied; the gate's own IS-IS could then be silently treated the same as
 * NO. Split into three CODE-SELECTED variants (renderLayerTwo() below picks
 * one, using lib/layerTwo.ts's resolveLivingRoute — YES only, NO only, or
 * contested only) so the text the model receives already commits to the
 * resolved route, or explicitly to neither while contested. Deliberately
 * does not name specific species — the priority order is the card, not a
 * taxonomy walk.
 */
export const LIVING_CARD_GUIDANCE_WHOLE_ORGANISM = `LIVING CARD — WHOLE-ORGANISM ROUTE.

The mandatory opening gate (already asked deterministically) resolved YES: the target itself is a whole biological organism, not a part or product of one.

Prioritize in this order, skipping any already settled: (1) broad biological form; (2) animal versus non-animal; (3) the human boundary, when relevant; (4) habitat/ecological relation, only when it would actually be informative; (5) domestication/cultivation or relationship to humans; (6) scale; (7) a stable morphological or biological discriminator. Do not walk a detailed taxonomy tree sibling by sibling.`;

export const LIVING_CARD_GUIDANCE_PART_PRODUCT = `LIVING CARD — PART/PRODUCT ROUTE.

The mandatory opening gate (already asked deterministically) resolved NO: the target is a part or product of a living organism, not a whole organism itself.

Prioritize: (1) plant-derived, animal-derived, or other biological origin; (2) whether it is edible/consumable, when relevant; (3) common biological or culinary class; (4) source or growth form; (5) stable morphology; (6) cultivation or climate, only when still discriminating; (7) a Leader/Rival discriminator. A fruit (e.g. apple, peach) is never a whole plant and never routes through animal-boundary questions — climate is a late, soft signal; stable fruit morphology (core/stone/skin/flesh structure) is a much stronger discriminator and should come first among the late-stage properties.`;

export const LIVING_CARD_GUIDANCE_CONTESTED = `LIVING CARD — WHOLE-ORGANISM BOUNDARY CONTESTED.

The mandatory opening gate, and its one permitted operationalization, both came back IS-IS. Whether the target is a whole organism or a part/product of one remains genuinely unresolved — do not silently treat this as either route, and do not ask a third reformulation of the same question. Proceed with cross-cutting stable discriminators (scale, material/biological origin, function) that would be informative under EITHER reading, and let a later stable answer settle the boundary as a side effect rather than by asking about it directly again.`;

/** Physical — production card (section 11). No unconditional first gate; the two controlled stable-gate templates back the premise audit. */
export const PHYSICAL_CARD_GUIDANCE = `PHYSICAL CARD.

Do not repeat a boundary Phase One already settled (living/physical/place/event). Prioritize, skipping any already settled: (1) bounded/discrete object versus substance/material/aggregate; (2) natural versus intentionally made; (3) primary function; (4) relationship to or action upon another object; (5) worn or body-interfacing; (6) powered versus passive; (7) scale/portability, only when it genuinely discriminates; (8) a stable mechanism or structural discriminator. Location and room are LATE dimensions, not early ones. Material must never become a checklist you work through item by item.

CONTROLLED STABLE GATES, for the soft-premise audit specifically: "Is keeping or storing something inside it a primary function?" and "Is its primary function to physically change another object?" Soft evidence that something holds, contains, touches, or is used alongside another object is NEVER enough on its own to unlock contents/capacity/closure/storage-location/container-type questions — only a stable YES to the first gate does. A stable NO to it closes that entire subtree. A stable YES to the second gate may unlock mechanism and affected-object questions.`;

/**
 * Place — production card (section 12). V2.8.5 ENGINE-CONTRACT CORRECTION
 * (defect 2) — the Earth gate's route was previously labelled "gate
 * NO/AMBIGUOUS", conflating a definite NO with an unresolved IS-IS. Split
 * into three CODE-SELECTED variants (renderLayerTwo() below picks one, using
 * lib/layerTwo.ts's resolvePlaceRoute), exactly like Living above.
 */
export const PLACE_CARD_GUIDANCE_EARTH = `PLACE CARD — EARTH ROUTE.

The mandatory opening gate (already asked deterministically) resolved YES: the target is Earth itself, or a real physical location on or within Earth.

Prioritize: (1) Earth itself versus a subplanetary place; (2) natural geography versus a human-defined or constructed place; (3) settlement, territory, structure, or designed-location function; (4) scale; (5) land/water/spatial character; (6) containment/adjacency; (7) a stable discriminator. A fictional place (Hogwarts and the like) must never be reasoned about inside this route.

Phase One's opening sandbox fixed the referent sense: if a country entered this card, treat it as territory/location throughout, never silently migrate into political-institution reasoning.`;

export const PLACE_CARD_GUIDANCE_OFF_EARTH = `PLACE CARD — OFF-EARTH ROUTE.

The mandatory opening gate (already asked deterministically) resolved NO: the target is not Earth or a location on/within it. A second mandatory gate (already asked deterministically) asked whether it corresponds to a physically real location elsewhere in the universe.

YES separates: a celestial body; a location on or in one; an orbit, path, or region (Earth orbit and the Solar System belong HERE, never forced into "celestial object"); a larger astronomical structure; or a constructed off-Earth place. NO permits: fictional; virtual; or symbolic/metaphysical, only when genuinely necessary.`;

export const PLACE_CARD_GUIDANCE_CONTESTED = `PLACE CARD — EARTH-MEMBERSHIP CONTESTED.

The mandatory Earth-membership gate, and its one permitted operationalization, both came back IS-IS. Whether the target is on/within Earth or elsewhere remains genuinely unresolved — do not silently treat this as either route, and do not ask a third reformulation of the same question, and do not ask the off-Earth gate (it presumes a NO that was never actually established). Proceed with cross-cutting stable discriminators (scale, natural vs. constructed, containment) that would be informative under EITHER reading.`;

/** Event — adaptive, no frozen card (section 13). Constitutive framing over raw causation or sibling lists. */
export const EVENT_CARD_GUIDANCE = `EVENT — ADAPTIVE ROUTING, SHARED RULES APPLY.

No frozen sequential card exists for Event in this release; the shared rules above (progress lease, premise audit, controlled IS-IS, named-question prohibition, scope sensitivity, budget discipline, one repair) still govern every question. Prefer constitutive wording over raw causation: "Is human action essential to what makes this the kind of event it is?" rather than merely asking whether a human caused it. Avoid a sibling list of war, sport, disaster, ceremony, and the like — find the dimension that actually divides the remaining space.`;

/** Abstract — adaptive, no frozen card (section 13). Overlapping lenses, select the most informative, not all of them in sequence. */
export const ABSTRACT_CARD_GUIDANCE = `ABSTRACT/INFORMATIONAL — ADAPTIVE ROUTING, SHARED RULES APPLY.

No frozen sequential card exists for Abstract in this release; the shared rules above still govern every question. Treat these as overlapping LENSES, not exclusive branches, and select whichever is most informative right now rather than working through all of them in a fixed sequence: executable/procedural; normative; institutional/social; representational/communicative; systemic/networked; conceptual/property/relationship.`;

/**
 * A Racer turn plus the provenance of the call that produced it.
 *
 * `output` is exactly what it was before and is what gets serialized into
 * racer_output_raw. Provenance rides ALONGSIDE it, never inside it: the V2.5-1
 * audit verified that every persisted raw_output in production carries exactly
 * four keys (action, question_text, guess_text, rationale), and raw_output is
 * defined as the participant's own structured output. A model id is a fact
 * about the call, not a move the Racer made.
 */
export interface RacerTurnResult {
  output: RacerTurnOutput;
  provenance: ModelProvenance;
  /**
   * Raw call facts, where the provider reports them. Unused by the turn loop —
   * present so a diagnostic harness can observe the real code path instead of
   * reimplementing it. See scripts/probeRacerLatency.ts.
   */
  diagnostics?: ToolCallResult<RacerTurnOutput>["diagnostics"];
}

// ---------------------------------------------------------------------------
// The Racer.
//
// ISOLATION: this module imports nothing from lib/secretStore.ts and nothing
// from lib/gameStore.ts. It cannot reach the target, and it cannot reach the
// full game record either — it accepts RacerPublicState, an explicit narrowing
// built in lib/racerState.ts. scripts/check-isolation.mjs fails the build if
// either import ever appears here.
//
// Runs on ANTHROPIC_MODEL_RACER, which fires ~20x per game. Per the standing
// decision, the config supports pointing this at a cheap model but that swap
// is not endorsed until question quality has been benchmarked against
// ANTHROPIC_MODEL_STRONG.
// ---------------------------------------------------------------------------

const RACER_SYSTEM_PROMPT = `You are the Racer in Barkóba, a deduction duel.

Your opponent has locked in a secret target. You start completely blind: no category, no domain, no hint of any kind. Your only information is the transcript of your own questions and their answers.

Each turn you do exactly one of:
- ask ONE question that can be answered YES or NO,
- declare a GUESS naming the target.

You do not have the option to give up. When your questions run out, you name your best candidate — there is no other move available to you at that point.

Your opponent answers YES, NO, or AMBIGUOUS. AMBIGUOUS means your question could not be answered truthfully as a binary — the framing was wrong, not the topic. When you get AMBIGUOUS, do not re-ask the same question; re-cut the same territory along a cleaner line.

How to play well:
- Early questions should split the space of possibilities close to in half. "Is it a physical object?" is worth more than "Is it a hammer?" on turn two.
- Track what each answer eliminates. Never ask something already entailed by an earlier answer.
- Narrow by category, then by property, then by identity. Move down that ladder only as the space collapses.
- Watch your remaining questions. If the space is still wide with few questions left, take bigger cuts.
- A question that names one specific candidate IS a guess. Do not disguise a guess as a question to get a free attempt — declare it as a guess. There is no penalty for guessing when you are ready, and an automated check will catch a disguised one anyway.
- FALSIFY BEFORE YOU COMMIT. While you still have questions left, a leading hypothesis is a reason to ask, not a reason to guess. Spend a question trying to break it: ask something that would come back NO if you are wrong. A hypothesis that survives an honest attempt to kill it is worth guessing; one you have merely not contradicted yet is not. You get exactly one guess, and an unspent question is worth far less than a wasted guess.
- Guess when your leading hypothesis has survived a deliberate attempt to falsify it, or when you are out of questions. Out of questions means guess NOW, with whatever candidate is strongest — even an uncertain leader is required, since giving up is not an available move.

Your "rationale" is private working notes, at most two sentences. Your opponent never sees it. Be honest in it — it is not scored.

Once past the opening classification, you will also be asked to declare a small set of structured fields alongside your move — which dimension it addresses, what kind of move it is, a stable key for the specific claim it tests, and how strong that claim's evidence would be. Full detail on exactly how, and why it matters, follows later in this message when it applies.

LANGUAGE OF PLAY
You will be told the language of this game. Write every question, guess, and rationale in that language, naturally, as a fluent speaker would — not as a translation. Leave proper nouns, brand names, and established technical terms in their original form rather than forcing them into the game language. The language tells you nothing about the target; do not treat it as a clue.

NEVER USE INTERNAL ROLE NAMES IN WHAT YOU WRITE
Never use the words "Composer", "Racer", "Validator" or "Adjudicator" in anything you write. They are engineering labels for parts of this system, not vocabulary a player should ever read. Keep them out of every question, every guess, and everything else visible.

When you need to refer to the other side in Hungarian, use natural language chosen for the sentence: "az ellenfeled", "a másik játékos", or simply address the player with "te". "Az ellenfeled testének egy része?" is right; "A Composer testének egy része?" is not Hungarian at all.

A WORD ON HUNGARIAN PHRASING
When playing in Hungarian, be careful with words that quietly narrow the space before you have narrowed it. "Dolog" reads as a thing or object, so asking whether the target is a real "dolog" implies you have already ruled out people — and your next question about a person then looks inconsistent to the player.

Prefer a neutral formulation when the space is still open. For the real-versus-fictional split, say: "A cél valóságos, vagy valaha valóságosan létezett — tehát nem kitalált vagy fikciós?"

This is about wording only. Ask the same questions in the same order; just do not let the phrasing claim more than the question does.`;

const GUESS_INTENT_SYSTEM_PROMPT = `You are the Racer in Barkóba. An automated check flagged your most recent question as possibly being a guess in disguise — a question that names one specific candidate rather than narrowing the space.

Declare what you actually intended:

- confirm_guess: you meant to name the target. State the guess canonically in guess_text (just the thing itself, no question framing).
- continue_questioning: you meant a genuine narrowing question. Supply revised_question — a rephrasing that cuts the space without naming a single specific candidate.

There is no penalty for either answer. Confirming a guess is a legitimate move; the check exists to stop a guess from being scored as a free question, not to discourage guessing. Answer honestly.

Write revised_question and guess_text in the language of the game, which you will be told.

This exchange is internal. Your opponent never sees it and is not waiting on it.`;

/**
 * V2.8.4.3 — no-concession final-action contract. "concede" is not a member
 * of any action enum this function can return, on any turn: an ordinary
 * turn's Racer may never voluntarily give up, and the forced-final turn's
 * only permitted action is "guess". See RACER_PROMPT_VERSION's racer/4.0.1
 * doc for why this is a contract change, not a reasoning change.
 */
function turnInputSchema(forceFinal: boolean, clueAvailable: boolean): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: forceFinal
          ? ["guess"]
          : clueAvailable
            ? ["question", "clue", "guess"]
            : ["question", "guess"],
        description: forceFinal
          ? "No questions remain. You must name your guess now."
          : "What you are doing this turn.",
      },
      question_text: {
        type: ["string", "null"],
        description:
          'Your yes/no question, if action is "question". Null otherwise. One question only.',
      },
      guess_text: {
        type: ["string", "null"],
        description:
          'The target you are naming, if action is "guess". Just the thing itself, no question framing. Null otherwise.',
      },
      rationale: {
        type: "string",
        description:
          "Private working notes, at most two sentences. Never shown to the Composer.",
      },
      // -----------------------------------------------------------------
      // V2.8.5 ENGINE-CONTRACT CORRECTION (defect 1) — these seven keys are
      // now REQUIRED (present in every response), with types that still
      // permit null so a "guess"/"clue" action — which never needs any of
      // them — can supply null and satisfy the schema. For an ordinary
      // "question" action, a null/empty/invalid value here is a SEPARATE,
      // runtime failure: lib/layerTwo.ts's validateCandidateMove rejects it
      // outright (see runRacerTurn below), so omission can no longer be used
      // to bypass every deterministic rule the way it could when these keys
      // were merely optional. See lib/layerTwo.ts's own doc for exactly what
      // deterministic enforcement can and cannot do with whatever the model
      // actually declares.
      // -----------------------------------------------------------------
      dimension: {
        type: ["string", "null"],
        description:
          "REQUIRED (non-null, non-empty) for an ordinary question once past the opening classification — omitting it gets the question rejected, not silently accepted. A short, stable label for the open question this move addresses; reuse the exact same label whenever you return to this dimension. Null only for guess/clue.",
      },
      question_kind: {
        type: ["string", "null"],
        enum: ["branch_gate", "discriminator", "premise_audit", "operationalization", "adaptive_partition", "guess", null],
        description:
          "REQUIRED (non-null) for an ordinary question — branch_gate, discriminator, premise_audit, operationalization, or adaptive_partition. Null only for guess/clue.",
      },
      proposition_id: {
        type: ["string", "null"],
        description:
          "REQUIRED (non-null, non-empty) for an ordinary question — a short, stable key for the specific claim this move tests. Reuse it if you revisit exactly this claim. Null only for guess/clue.",
      },
      parent_proposition: {
        type: ["string", "null"],
        description:
          "REQUIRED KEY on every response (the VALUE may legitimately be null when the move has no parent). The proposition_id this move depends on, if any.",
      },
      predicate_strength: {
        type: ["string", "null"],
        enum: ["stable", "typical", null],
        description:
          "REQUIRED (non-null) for an ordinary question. Declare BEFORE seeing the answer, never relabel afterward. stable = defining/near-defining property. typical = common but non-defining tendency, even if you expect a confident answer. Null only for guess/clue.",
      },
      sandbox_repair: {
        type: "boolean",
        description:
          "REQUIRED on every response. True only on the one move, ever, that spends this game's single permitted sandbox repair. False otherwise — including on every guess/clue.",
      },
      sandbox_repair_reason: {
        type: ["string", "null"],
        enum: ["invariant_contradiction", "structural_dead_end", null],
        description:
          "REQUIRED KEY. Non-null and one of the two listed values if and only if sandbox_repair is true this move. Must be null whenever sandbox_repair is false.",
      },
      sandbox_repair_to: {
        type: ["string", "null"],
        enum: ["living", "physical", "place", "event", "abstract", null],
        description:
          "REQUIRED KEY. Non-null, and different from the current sandbox, if and only if sandbox_repair is true this move. Must be null whenever sandbox_repair is false.",
      },
    },
    required: [
      "action",
      "question_text",
      "guess_text",
      "rationale",
      "dimension",
      "question_kind",
      "proposition_id",
      "parent_proposition",
      "predicate_strength",
      "sandbox_repair",
      "sandbox_repair_reason",
      "sandbox_repair_to",
    ],
  };
}

const GUESS_INTENT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    resolution: {
      type: "string",
      enum: ["confirm_guess", "continue_questioning"],
    },
    guess_text: {
      type: ["string", "null"],
      description:
        'The target, stated plainly, if resolution is "confirm_guess". Null otherwise.',
    },
    revised_question: {
      type: ["string", "null"],
      description:
        'A rephrased narrowing question that names no single candidate, if resolution is "continue_questioning". Null otherwise.',
    },
  },
  required: ["resolution", "guess_text", "revised_question"],
};

function renderTranscript(state: RacerPublicState): string {
  if (state.transcript.length === 0) {
    return "No questions asked yet. This is your opening move.";
  }

  return state.transcript
    .map((turn) => {
      const answer = turn.answer ?? "(awaiting answer)";
      const note =
        turn.answer === "AMBIGUOUS" && turn.ambiguous_explanation
          ? ` — Note: ${turn.ambiguous_explanation}`
          : "";
      return `Q${turn.turn_index}: ${turn.question}\nA${turn.turn_index}: ${answer}${note}`;
    })
    .join("\n\n");
}

const LANGUAGE_NAMES: Record<string, string> = {
  hu: "Hungarian (magyar)",
  en: "English",
};

function renderLanguage(state: RacerPublicState): string {
  const name = LANGUAGE_NAMES[state.game_language] ?? "English";
  return `Language of this game: ${name}. Write your question, guess, and rationale in ${name}.`;
}

function renderClues(state: RacerPublicState): string {
  if (state.clues.length === 0) return "Clues given so far: none.";
  const rows = state.clues.map((c) => `Clue (after turn ${c.turn_index}): ${c.clue}`);
  return ["Clues the Composer has given you — treat these as reliable:", ...rows].join("\n");
}

function renderBudget(state: RacerPublicState, forceFinal: boolean): string {
  if (forceFinal) {
    return `You have used all ${state.max_questions} questions. This is your final turn: name your guess.`;
  }
  return `Questions used: ${state.question_count} of ${state.max_questions}. Remaining: ${state.questions_remaining}.`;
}

/**
 * V2.8.4 — plain context from the deterministic Phase One engine
 * (lib/phaseOne.ts), when it ran. Deliberately just a sentence: this is the
 * SAME general-reasoning Racer as before, told one more fact up front — not
 * a new decision tree per sandbox. Absent entirely (empty string) for any
 * game Phase One did not classify, so RACER_PROMPT_VERSION's guarantee that
 * every turn sees the identical strategy content is untouched; only the
 * per-turn context varies, exactly as renderBudget/renderClues already do.
 */
function renderPhaseOne(state: RacerPublicState): string {
  if (!state.phase_one) return "";
  const { sandbox, specificity, mixed_spine_questions } = state.phase_one;
  const specificityText =
    specificity === "particular"
      ? " (a particular instance, not a category)"
      : specificity === "kind"
        ? " (a kind/category, not one particular instance)"
        : specificity === "mixed"
          ? " (specificity unclear — treat as unresolved)"
          : "";
  const contested =
    mixed_spine_questions.length > 0
      ? ` The opening classification question(s) ${mixed_spine_questions.join(", ")} were answered IS-IS — treat that boundary as contested, not certain.`
      : "";
  return `Deterministic opening classification: ${sandbox}${specificityText}.${contested}`;
}

const STATIC_CARD_GUIDANCE_BY_SANDBOX: Record<string, string> = {
  physical: PHYSICAL_CARD_GUIDANCE,
  event: EVENT_CARD_GUIDANCE,
  abstract: ABSTRACT_CARD_GUIDANCE,
};

/**
 * V2.8.5 ENGINE-CONTRACT CORRECTION (defect 2) — Living and Place no longer
 * have one static card describing both routes; the ROUTE ITSELF (resolved
 * deterministically in lib/layerTwo.ts, exposed via layer_two.livingRoute /
 * layer_two.placeRoute) selects which committed variant the model receives.
 * Physical/Event/Abstract are unaffected and keep one static card each.
 */
function selectCard(
  sandbox: string,
  layerTwo: RacerPublicState["layer_two"]
): string {
  if (sandbox === "living") {
    const route = layerTwo?.livingRoute ?? null;
    if (route === "whole_organism") return LIVING_CARD_GUIDANCE_WHOLE_ORGANISM;
    if (route === "part_product") return LIVING_CARD_GUIDANCE_PART_PRODUCT;
    if (route === "contested") return LIVING_CARD_GUIDANCE_CONTESTED;
    // Route not yet resolved (the mandatory gate is still pending) — no card
    // content to add yet; the deterministic gate itself is what the Setter
    // sees this turn, not a model-authored question.
    return "";
  }
  if (sandbox === "place") {
    const route = layerTwo?.placeRoute ?? null;
    if (route === "earth") return PLACE_CARD_GUIDANCE_EARTH;
    if (route === "off_earth") return PLACE_CARD_GUIDANCE_OFF_EARTH;
    if (route === "contested") return PLACE_CARD_GUIDANCE_CONTESTED;
    return "";
  }
  return STATIC_CARD_GUIDANCE_BY_SANDBOX[sandbox] ?? "";
}

/**
 * V2.8.5 — the Layer Two guidance block for this turn: the shared
 * cross-cutting rules, the sandbox's own (route-selected, for Living/Place)
 * card, and a live summary of stalled dimensions / off-limits propositions
 * the deterministic engine has already derived. Empty for any game with no
 * sandbox yet, or whose sandbox is "unclassified" (still inside the +1
 * corridor, which never reaches this function at all — see the turn route).
 */
function renderLayerTwo(state: RacerPublicState): string {
  const sandbox = state.phase_one?.sandbox;
  if (!sandbox || sandbox === "unclassified") return "";

  const layerTwo = state.layer_two;
  const card = selectCard(sandbox, layerTwo);
  if (!layerTwo) return [LAYER_TWO_SHARED_RULES, "", card].filter(Boolean).join("\n");

  const summaryLines: string[] = [];
  // V2.8.5 FINAL ENGINE-CONTRACT CORRECTION (finding 1) — a Mixed "+1"
  // resolution carries TWO essential senses (lib/sandboxClarification.ts's
  // mixedSenses), but until this fix only the primary one ever reached the
  // model: layer_two.secondarySense was computed and threaded through
  // racerState, then silently dropped at the one place that actually builds
  // the Racer's message. Without this, an honest Physical+Place target
  // reached the model as merely Physical, discarding half of what the "+1"
  // corridor's Mixed-first correction (defect 4) exists to preserve.
  if (layerTwo.secondarySense) {
    summaryLines.push(
      `MIXED TARGET — TWO ESSENTIAL SENSES: the intended target requires BOTH "${sandbox}" (primary/active card, below) AND "${layerTwo.secondarySense}" to be represented accurately — neither alone is the whole target. Use cross-sandbox discriminators that can confirm or distinguish the "${layerTwo.secondarySense}" sense too; do not silently collapse the target into the primary card alone.`
    );
  }
  // V2.8.5 ENGINE-CONTRACT CORRECTION (defect 3) — if a repair has actually
  // changed the effective sandbox, say so explicitly rather than leaving the
  // model to infer it from phase_one.sandbox alone (which the turn route now
  // sets to this SAME repaired value, so this is a confirmation, not a
  // second source of truth).
  if (layerTwo.originalSandbox !== layerTwo.activeSandbox) {
    summaryLines.push(
      `SANDBOX REPAIRED: the effective sandbox is now "${layerTwo.activeSandbox}", not the original "${layerTwo.originalSandbox}". Reason from the ledger, not from this note — do not re-ask which sandbox applies.`
    );
  } else if (layerTwo.repairContested) {
    summaryLines.push(
      "The one permitted sandbox repair was used and came back IS-IS — neither the original nor the proposed sandbox is confirmed. Continue with cross-cutting stable discriminators rather than assuming either."
    );
  } else if (layerTwo.sandboxRepairUsed) {
    summaryLines.push("The one permitted sandbox repair has already been used this game (kept the original sandbox).");
  }
  if (layerTwo.stalledDimensions.length > 0) {
    summaryLines.push(
      `STALLED — switch away from, or audit/operationalize the contested proposition in: ${layerTwo.stalledDimensions.join(", ")}.`
    );
  }
  if (layerTwo.pendingPremiseAudit) {
    summaryLines.push(
      `A soft-premise audit is required before any further descent into proposition "${layerTwo.pendingPremiseAudit}".`
    );
  }
  if (layerTwo.blockedPropositions.length > 0) {
    summaryLines.push(`Hard-excluded, and every descendant of them: ${layerTwo.blockedPropositions.join(", ")}.`);
  }
  if (layerTwo.typicalOnlySupported.length > 0) {
    summaryLines.push(
      `Supported only by typical YES evidence so far — no child question may depend on these without an audit: ${layerTwo.typicalOnlySupported.join(", ")}.`
    );
  }
  if (layerTwo.contestedPropositions.length > 0) {
    summaryLines.push(`Contested (IS-IS, not yet resolved): ${layerTwo.contestedPropositions.join(", ")}.`);
  }

  return [LAYER_TWO_SHARED_RULES, "", card, "", summaryLines.join("\n")].filter(Boolean).join("\n");
}

/**
 * Assemble the per-turn Racer message.
 *
 * PROVIDER-NEUTRAL BY CONSTRUCTION — note the signature: it takes no provider.
 * That is the parity guarantee, expressed in the type rather than promised in a
 * comment. There is exactly one assembly, so Claude and Grok cannot be handed
 * different strategy text; an adapter may move it between message roles, but it
 * has nothing to differentiate.
 *
 * Exported so tests can inspect what the model is actually given without
 * standing up a transport.
 */
export function buildRacerTurnMessage(
  state: RacerPublicState,
  options: { forceFinal: boolean; clueAvailable: boolean }
): string {
  const { forceFinal, clueAvailable } = options;

  return [
    renderLanguage(state),
    "",
    renderBudget(state, forceFinal),
    "",
    renderPhaseOne(state),
    "",
    renderLayerTwo(state),
    "",
    "Transcript so far:",
    renderTranscript(state),
    "",
    renderClues(state),
    clueAvailable
      ? `You may request a clue this turn: action "clue". You have ${state.clue_credits_available} clue request(s) available. It costs no question and no guess, and the Composer will answer it in words rather than yes/no.\n\nBeing allowed to ask is not a reason to ask. Spend one only when you judge that a clue would materially help — when the transcript has stopped narrowing, or you are choosing between hypotheses that your own questions cannot separate. If your next question would make good progress on its own, ask it instead. An unspent credit is not wasted; it keeps accumulating.`
      : "You cannot request a clue this turn.",
    "",
    // RG #3 — THE TRAILING STRATEGY BLOCK. Position remains last
    // before the instruction to act, so a growing transcript never pushes the
    // strategy away from the point of decision.
    //
    // Included on the final turn too. The final-guess gate governs that moment,
    // an unconditional block keeps the guarantee below unconditional as well —
    // a branch here would mean RACER_PROMPT_VERSION was true of some turns and
    // not others, which is precisely the ambiguity the version is meant to remove.
    CORE_RACER_RULES,
    "",
    forceFinal ? "Name your guess now." : "Take your turn.",
  ].join("\n");
}

/**
 * Assemble the Guess-Intent message.
 *
 * PROVIDER-NEUTRAL, exactly like buildRacerTurnMessage, and for the same
 * reason: it takes no provider argument, so the two transports cannot be handed
 * different guidance on this path either.
 *
 * SINGLE-SOURCED. It reuses CORE_RACER_RULES rather than restating it. A second
 * literal would drift, and two divergent "canonical" blocks under one version
 * string would make the audit claim unfalsifiable.
 */
export function buildGuessIntentMessage(
  state: RacerPublicState,
  flaggedQuestion: string
): string {
  return [
    renderLanguage(state),
    "",
    renderBudget(state, false),
    "",
    "Transcript so far:",
    renderTranscript(state),
    "",
    `The question that was flagged: ${flaggedQuestion}`,
    "",
    // Trailing, as on the turn path. If this resolution produces a revised
    // question, that question is authored here and under this guidance.
    CORE_RACER_RULES,
    "",
    "Declare your intent.",
  ].join("\n");
}

/**
 * THE GUARANTEE BEHIND `RACER_PROMPT_VERSION`.
 *
 * `prompt_version` is written into corpus.game_turns and will be queried as
 * proof that a turn was played under the canonical guidance. A constant stamped
 * beside an assembly it does not actually inspect proves nothing — it would be
 * an assertion about the code, made by the code, checked by nobody.
 *
 * So the claim is verified against the assembled message itself, immediately
 * before the call. A turn cannot be stamped with this version unless the block
 * was genuinely present, because the call raises first.
 *
 * THROWS RATHER THAN WARNS, and rather than silently downgrading the stamp.
 * This can only fire on a code defect — the block is unconditional — and a
 * loud, recoverable turn failure (B4 handles it, with a human retry control) is
 * strictly better than a corpus quietly accumulating turns that claim guidance
 * they never received. Mislabelled evidence is worse than missing evidence.
 */
function assertGuidanceApplied(content: string): void {
  if (!content.includes(CORE_RACER_RULES)) {
    throw new Error(
      `racer: ${RACER_PROMPT_VERSION} claims the CORE RACER RULES block, but the ` +
        `assembled turn message does not contain it. Refusing to stamp provenance ` +
        `that would misdescribe this turn.`
    );
  }
}

/**
 * Which model this call runs on. Both fields are SERVER-RESOLVED — the provider
 * comes from the game record, the model id from the environment. No request may
 * state either, exactly as no request may state a Play Credit price.
 */
// S2 / RB-2 review fix — exported so route.ts can record the REQUESTED model
// in turn-operation telemetry before the call, without duplicating this
// resolution logic a second time. Behavior unchanged; only visibility widened.
export function racerModelFor(provider: ModelProviderId): string {
  return provider === "xai" ? env.xaiModelRacer() : env.modelRacer();
}

export async function runRacerTurn(
  state: RacerPublicState,
  options: {
    forceFinal: boolean;
    provider?: ModelProviderId;
    /**
     * Diagnostic seam ONLY, for scripts/probeRacerLatency.ts. Production never
     * passes it, so every Grok turn keeps running at the provider default. This
     * is deliberately NOT routing: nothing here decides what to send, it only
     * carries what a caller already decided.
     */
    reasoningEffort?: string;
    /**
     * S2 / RB-2 — the shared provider-time budget's local deadline for this
     * one attempt (lib/turnBudget.ts). A LOCAL deadline only: see
     * ToolCallRequest.signal's own doc for what this does and does not claim
     * about the remote provider. Forwarded unchanged; this function does not
     * decide the allowance, only carries what the caller already decided —
     * the same relationship it already has with `reasoningEffort`.
     */
    signal?: AbortSignal;
    /**
     * V2.8.5 — the full internal Layer Two traversal state (Sets/Maps), for
     * legality validation only. Distinct from state.layer_two (the plain,
     * serializable summary used for PROMPT RENDERING): validateCandidateMove
     * needs the richer shape this option carries. Undefined for any game
     * with no Layer Two state yet (Phase One incomplete, or still inside the
     * +1 corridor) — validation is then skipped entirely, exactly as it
     * always was before this version.
     */
    layerTwoState?: LayerTwoState;
  }
): Promise<RacerTurnResult> {
  const { forceFinal } = options;
  const provider = options.provider ?? DEFAULT_RACER_PROVIDER;
  // Eligibility only. The Racer is never told to take a clue, and the prompt
  // below says so explicitly — an available credit is an option, not an
  // instruction. No other part of its strategy is touched by this feature.
  const clueAvailable = !forceFinal && state.clue_credits_available > 0;

  // V2.5-B3 — the transport comes from the game record, resolved through the
  // registry. An unknown provider THROWS here; it never falls back.
  //
  // Everything below the call — the system prompt, the schema, the rendered
  // transcript, the question budget — is built here, once, provider-neutrally,
  // and handed over untouched. No adapter may rewrite any of it. Two providers
  // must receive the same task, or a comparison between them measures the
  // prompt and not the model.
  const adapter = getAdapter(provider);
  const requestedModel = racerModelFor(provider);

  // Assembled ONCE, provider-neutrally, and verified before the transport is
  // handed anything. Both halves matter: one assembly is what makes Claude and
  // Grok comparable, and the assertion is what makes the stamped
  // prompt_version a fact rather than a hope.
  const content = buildRacerTurnMessage(state, { forceFinal, clueAvailable });
  assertGuidanceApplied(content);

  const {
    output: result,
    resolvedModel,
    diagnostics,
  } = await adapter.callTool<RacerTurnOutput>({
    model: requestedModel,
    reasoningEffort: options.reasoningEffort,
    signal: options.signal,
    system: RACER_SYSTEM_PROMPT,
    messages: [{ role: "user", content }],
    toolName: "submit_turn",
    toolDescription: "Submit your move for this turn.",
    inputSchema: turnInputSchema(forceFinal, clueAvailable),
    maxTokens: 512,
  });

  // V2.8.4.3 — no-concession final-action contract. The schema enum already
  // excludes "concede" (and, under forceFinal, everything but "guess"), but a
  // provider is not guaranteed to honor a tool-call enum strictly — the "PC"
  // incident's own schema (["guess", "concede"]) was itself honored, but
  // nothing here may assume a future provider always will. Validate the
  // returned action against the SAME allowed set the schema was built from,
  // and throw on anything else rather than accept it or repair it into a
  // guess. A thrown error here propagates to the caller
  // (app/api/game/[id]/turn/route.ts's runOneRacerAttempt) exactly like a
  // provider timeout or transport failure: the existing racer_unavailable
  // technical-recovery path, never a fabricated outcome.
  //
  // The one defensive substitution kept is "clue" claimed without a credit —
  // downgrading that to "question" preserves the model's own question text
  // unchanged and manufactures nothing, unlike accepting an unearned action
  // or inventing a guess would.
  const allowedActions: readonly RacerTurnOutput["action"][] = forceFinal
    ? (["guess"] as const)
    : clueAvailable
      ? (["question", "clue", "guess"] as const)
      : (["question", "guess"] as const);

  const action =
    result.action === "clue" && !clueAvailable ? "question" : result.action;

  if (!allowedActions.includes(action)) {
    throw new Error(
      `racer: provider returned action "${result.action}", outside the permitted set ` +
        `(${allowedActions.join(", ")}) for this ${forceFinal ? "forced-final" : "ordinary"} turn. ` +
        `Refusing to translate a schema violation into a guess or concession.`
    );
  }

  // A "guess" with no actual named target is a malformed response, not a
  // guess — refusing it here is what stops one from ever being fabricated
  // out of a stray question_text or an empty string.
  if (action === "guess" && !(result.guess_text && result.guess_text.trim())) {
    throw new Error(
      'racer: provider declared action "guess" without a usable guess_text — refusing to fabricate one.'
    );
  }

  // V2.8.5 — Layer Two legality. Only runs when the caller supplied traversal
  // state (i.e. Phase One has handed off a real sandbox and the +1 corridor,
  // if it ran, has already resolved). A violation throws exactly like the
  // no-concession check above: the existing racer_unavailable
  // technical-recovery path, never a fabricated outcome. See
  // lib/layerTwo.ts's own doc on what this can and cannot enforce.
  if (options.layerTwoState && action === "question") {
    // V2.8.5 FINAL ENGINE-CONTRACT CORRECTION (finding 4) — validate the RAW
    // provider value BEFORE any normalization can coerce a missing/invalid
    // sandbox_repair into a well-formed `false`. The output-construction
    // code below (and the OLD candidate construction here) used
    // `result.sandbox_repair === true`, which silently turns "the provider
    // omitted this mandatory field entirely" into `false` — a value
    // validateMandatoryMetadata()'s own `typeof !== "boolean"` check can
    // never then catch, because by the time it runs the coercion has
    // already happened. Checking the raw value here, before it is touched,
    // is what makes the claimed runtime rejection real.
    if (typeof result.sandbox_repair !== "boolean") {
      throw new Error(
        `racer: Layer Two move rejected — missing or invalid sandbox_repair (must be an explicit boolean, received ${JSON.stringify(result.sandbox_repair)}).`
      );
    }
    const candidate: LayerTwoCandidate = {
      question_text: result.question_text ?? "",
      dimension: result.dimension ?? null,
      question_kind: result.question_kind ?? null,
      proposition_id: result.proposition_id ?? null,
      parent_proposition: result.parent_proposition ?? null,
      predicate_strength: result.predicate_strength ?? null,
      sandbox_repair: result.sandbox_repair,
      sandbox_repair_reason: result.sandbox_repair_reason ?? null,
      sandbox_repair_to: result.sandbox_repair_to ?? null,
    };
    // CORRECTION 1 — mandatory metadata (missing dimension/question_kind/
    // proposition_id/predicate_strength) and CORRECTION 3's repair-
    // declaration consistency are both checked inside validateCandidateMove
    // now, ahead of every other rule.
    const validation = validateCandidateMove(candidate, options.layerTwoState);
    if (!validation.ok) {
      throw new Error(`racer: Layer Two move rejected — ${validation.reason}.`);
    }
  }

  return {
    output: {
      action,
      question_text: action === "question" ? (result.question_text ?? null) : null,
      guess_text: action === "guess" ? result.guess_text : null,
      rationale: result.rationale ?? "",
      dimension: action === "question" ? (result.dimension ?? null) : null,
      question_kind: action === "question" ? (result.question_kind ?? null) : action === "guess" ? "guess" : null,
      proposition_id: action === "question" ? (result.proposition_id ?? null) : null,
      parent_proposition: action === "question" ? (result.parent_proposition ?? null) : null,
      predicate_strength: action === "question" ? (result.predicate_strength ?? null) : null,
      sandbox_repair: action === "question" && result.sandbox_repair === true,
      sandbox_repair_reason: action === "question" ? (result.sandbox_repair_reason ?? null) : null,
      sandbox_repair_to: action === "question" ? (result.sandbox_repair_to ?? null) : null,
    },
    provenance: {
      // The adapter's own id, not a separate constant. There is exactly one
      // place a provider name is written down, so the transport that made the
      // call and the evidence recording who made it cannot drift apart.
      model_id: resolvedModel,
      model_provider: adapter.id,
      prompt_version: RACER_PROMPT_VERSION,
    },
    diagnostics,
  };
}

/**
 * Resolve a Guess-Detector flag by asking the Racer what it meant.
 *
 * In V1 the Racer is an AI with forced structured output, so there is no human
 * on that side of the table to show a confirmation control to. The human
 * Composer is never shown this exchange and never waits on it. The
 * human-facing confirmation UI belongs to Phase 2's human-Racer mode — see
 * docs/DESIGN-NOTES.md.
 */
export async function resolveGuessIntent(
  state: RacerPublicState,
  flaggedQuestion: string,
  provider: ModelProviderId = DEFAULT_RACER_PROVIDER
): Promise<GuessIntentResolution> {
  // Same seat, same provider as the turn it is resolving — the caller passes
  // the game's provider, not a default. A flagged question must not be re-read
  // by a different model than the one that wrote it, or the resolution would
  // describe an intent its author never had.
  // RG #3 — THE SAME CANONICAL BLOCK, AND THE SAME GUARD.
  //
  // This path can AUTHOR the question the human actually sees:
  // `continue_questioning` returns a revised_question that replaces the
  // original in question_text. Without this, RACER_PROMPT_VERSION would
  // describe only the first attempted question and not the one presented — a
  // claim that is true of a draft and false of the record. §32 measured 10 of
  // ~20 turns flagged in a single game, so the gap was material, not
  // theoretical.
  //
  // The guidance is honestly applicable here rather than merely pasted in: a
  // revision is question authoring, and the partition-before-enumeration
  // discipline directly applies to the question whose form triggered the flag.
  const content = buildGuessIntentMessage(state, flaggedQuestion);
  assertGuidanceApplied(content);

  const { output: result } = await getAdapter(provider).callTool<GuessIntentResolution>({
    model: racerModelFor(provider),
    system: GUESS_INTENT_SYSTEM_PROMPT,
    messages: [{ role: "user", content }],
    toolName: "resolve_guess_intent",
    toolDescription:
      "Declare whether your flagged question was a guess or a narrowing question.",
    inputSchema: GUESS_INTENT_SCHEMA,
    maxTokens: 384,
  });

  return {
    resolution: result.resolution === "confirm_guess" ? "confirm_guess" : "continue_questioning",
    guess_text: result.guess_text ?? null,
    revised_question: result.revised_question ?? null,
  };
}
