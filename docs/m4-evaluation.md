# M4 — Evaluation & Execution Status

**Status: BLOCKED on live model execution.** Everything reachable without a
real Anthropic API call and a real Vercel Preview deployment is done:
pre-registration ([docs/m4-experiment-spec.md](m4-experiment-spec.md)),
`racer/4.1.0` implementation, the held-out fixture, and the full local test
suite are green. No PASS/REVISE/REJECT verdict is rendered below — rendering
one without the evidence the pre-registered criteria require would be
exactly the "mislabelled evidence is worse than missing evidence" failure
this codebase's own conventions exist to prevent (see
[lib/prompts/racer.ts](../lib/prompts/racer.ts)'s `assertGuidanceApplied`
comment). See §1 for the precise blocker and the one action that clears it.

---

## 0. Evidence index

Every run this milestone touches, real or pending, in one table. No row is
ever filled with fabricated data — "not yet run" is a status, not something
worked around with placeholder content.

| Fixture | Guidance | Transcript | Status |
|---|---|---|---|
| D-1 (generic backpack) | `racer/4.0.0` (control) | [docs/m4-evidence/control-rg-4.0.0/d1-generic-backpack.transcript.json](m4-evidence/control-rg-4.0.0/d1-generic-backpack.transcript.json) | Existing, frozen — mirror of [docs/m3-evidence/d1-generic-backpack.transcript.json](m3-evidence/d1-generic-backpack.transcript.json) |
| D-2 (Eiffel Tower) | `racer/4.0.0` (control) | [docs/m4-evidence/control-rg-4.0.0/d2-eiffel-tower.transcript.json](m4-evidence/control-rg-4.0.0/d2-eiffel-tower.transcript.json) | Existing, frozen — mirror of [docs/m3-evidence/d2-eiffel-tower.transcript.json](m3-evidence/d2-eiffel-tower.transcript.json) |
| D-1 (generic backpack) | `racer/4.1.0` (candidate) | `docs/m4-evidence/candidate-rg-4.1.0/d1-generic-backpack.transcript.json` | **NOT YET RUN — blocked, §1** |
| D-2 (Eiffel Tower) | `racer/4.1.0` (candidate) | `docs/m4-evidence/candidate-rg-4.1.0/d2-eiffel-tower.transcript.json` | **NOT YET RUN — blocked, §1** |
| Held-out 01 (Mona Lisa) | `racer/4.0.0` (control) | `docs/m4-evidence/control-rg-4.0.0/heldout-01-mona-lisa.transcript.json` | **NOT YET RUN — blocked, §1** |
| Held-out 01 (Mona Lisa) | `racer/4.1.0` (candidate) | `docs/m4-evidence/candidate-rg-4.1.0/heldout-01-mona-lisa.transcript.json` | **NOT YET RUN — blocked, §1** |

Two of six required games exist; both are historical `racer/4.0.0` evidence
carried over, never rerun. The four `racer/4.1.0`-involving games — the two
that actually test this milestone's hypothesis, plus the held-out control —
do not exist yet.

---

## 1. Why execution is blocked, and the one action that clears it

**HUMAN GATE FOUND**

**A. What is blocked.** All four "not yet run" rows in §0 — every game that
would actually test the `racer/4.1.0` hypothesis (D-1 and D-2 candidate
reruns) or provide held-out evidence (both held-out passes). Nothing about
`racer/4.1.0`'s correctness, D9's measurement methodology, or the held-out
fixture's design is in question — the blocker is purely infrastructural
access, checked directly rather than assumed:

- `ANTHROPIC_API_KEY`, `DATABASE_URL`, `UPSTASH_REDIS_REST_URL`,
  `UPSTASH_REDIS_REST_TOKEN`, `BENCHMARK_INGRESS_SECRET` are all **entirely
  unset** in this environment — not masked placeholders, genuinely absent
  (checked for presence only, values never read or logged).
- `scripts/runD3Fixture.ts`'s CLI path needs a real `ANTHROPIC_API_KEY` at
  minimum (`DATABASE_URL`/`UPSTASH_REDIS_REST_URL` have a documented
  in-memory fallback for local mechanics testing, per that script's own
  header comment) — none is available here, and this session has no way to
  obtain one.
- The Preview-gated routes
  (`app/api/internal/benchmark/{d1-generic-backpack,d2-eiffel-tower,heldout-01-mona-lisa}/route.ts`)
  refuse everything outside `VERCEL_ENV === "preview"` by design (Gate 1) —
  this is correct, intentional behavior, not a bug to route around.
- The connected Vercel account (team `zvz-x`, confirmed reachable via this
  session's Vercel MCP connection) has **zero projects** visible to it —
  root-caused, not just observed: `.vercel/repo.json` in the main checkout
  names the real project (`barkoba2-v2`, `prj_P8itlozWZiHiRbHZZg9SAMk81yiO`,
  same `team_YQ5feGh1HADzgCAO5bE6RECA` org this session's connector
  authenticates to), but `get_project` on that exact ID and slug both 404,
  and `get_git_deployment_context` reports zero linked projects for that
  team. Matching team, zero project visibility — the project has no
  installed Claude/Vercel connector integration (confirmed by Zsolt), so
  this session's Vercel connector is authenticated at the team level but was
  never granted access to this specific project. **Fix location, confirmed:
  Claude → Settings → Connectors → Vercel** (not a Vercel-side integration
  page — none exists yet). No tool call available to this session can
  restore that access; it needs the account holder's own click there.
- `test/benchmarkD2Route.test.ts`'s own header comment already documents
  this exact limitation for D-2: *"no fixture game is actually completed by
  these tests, and none should be"* — the project's own test suite was
  written assuming this constraint, not discovering it new here.

**B. Exact action Zsolt must take** — either path, whichever is faster on
Zsolt's side:

- **Path 1 (matches the established M1/M3 evidentiary convention).** From
  wherever the real Barkóba Vercel project actually lives, push this branch
  (or a copy of `lib/prompts/racer.ts` + `scripts/runD3Fixture.ts` +
  `app/api/internal/benchmark/heldout-01-mona-lisa/route.ts`) to a Preview
  deployment with `ANTHROPIC_API_KEY`, `DATABASE_URL`,
  `UPSTASH_REDIS_REST_URL/TOKEN`, and `BENCHMARK_INGRESS_SECRET` already
  configured (as D-1/D-2 presumably were), then `POST` each confirmation
  body from a trusted context: `{"confirm":"run-d1-once"}` /
  `{"confirm":"run-d2-once"}` (after redeploying with `racer/4.1.0` live —
  §2 below explains why D-1/D-2 need two deploys, not one) /
  `{"confirm":"run-heldout-01-once"}`, run once under `racer/4.0.0` and once
  under `racer/4.1.0` per §2's ordering. Hand back the six resulting
  `game_id`s (or export the transcripts directly via
  `scripts/exportFullTranscript.ts`, exactly as D-1/D-2's were produced) —
  no other decision is needed from Zsolt for this path.
- **Path 2 (runs locally from this session, no deployment needed).** Supply
  `ANTHROPIC_API_KEY` (and, if durable corpus rows are also wanted,
  `DATABASE_URL` + `UPSTASH_REDIS_REST_URL/TOKEN`) as environment variables
  to this session. `BENCHMARK_INGRESS_SECRET` can be any non-empty string —
  it is a readiness gate only (§4 of `scripts/runD3Fixture.ts`'s own header
  comment), never compared against anything. With those set, this session
  can run `npx tsx scripts/runBenchmarkFixture.ts` (existing, D-1) /
  `scripts/runD2Fixture.ts` (existing) / `scripts/runD3Fixture.ts` (new,
  this milestone) directly via their CLI entry points, once under the
  current `racer/4.1.0` code and once with `lib/prompts/racer.ts` checked
  out at the `racer/4.0.0` commit (`2ca5f1b`) for the two fixtures that need
  a fresh control pass.

**C. Where to take it.** Path 1: wherever Zsolt already manages the Barkóba
Vercel project and its environment variables (outside this session — the
Vercel account this session is connected to has no projects, confirmed by a
harmless `list_projects` read, so Zsolt's real project lives elsewhere or
under different access). Path 2: paste the credential(s) into this
conversation or the session's environment; no web UI, login, or approval
click needed beyond that.

**D. What will be verified immediately afterward.** Once either path
produces real transcripts: they are copied byte-for-byte into
`docs/m4-evidence/{control-rg-4.0.0,candidate-rg-4.1.0}/`, the §0 index above
is updated from "not yet run" to a real link, the §2 primary D9 measurement
below is extended to the candidate/held-out runs exactly as it was already
computed for the two existing control transcripts, the regression dimensions
(§3) are scored, and a real PASS/REVISE/REJECT verdict is rendered against
the criteria frozen in `docs/m4-experiment-spec.md` §9 — no criterion is
loosened or reinterpreted to fit whatever the evidence turns out to say.

**Everything else on the preflight checklist passed:**
git state is correct (M4 branch fast-forwarded to `2ca5f1b`, the intended M3
baseline, then advanced by ordinary M4 commits — see git log); `npm run
typecheck`, `npm run check:isolation`, `npm test` (1105/1105), and `npm run
build` all pass clean on this working tree; the held-out fixture and its
route/test exist and compile without requiring a manual web-UI step beyond
the one live deployment/credential action above; transcript files write into
the M4 branch exactly as planned (§0's two existing rows are real, committed
evidence, not placeholders). The single blocker is live model/deployment
access, isolated to exactly the four rows in §0 above.

---

## 2. Run ordering, once unblocked

`RACER_PROMPT_VERSION` is a module constant, not a runtime parameter — there
is exactly one guidance version live per deployment/checkout, matching every
prior RG pass. This means the two `racer/4.1.0` reruns of D-1/D-2 and the
`racer/4.0.0` control pass of the held-out fixture cannot all happen from a
single deployed state:

1. **Held-out control first, against the current M3 baseline state**
   (`racer/4.0.0`, commit `2ca5f1b` or any checkout before this branch's
   `racer/4.1.0` commit) — produces
   `control-rg-4.0.0/heldout-01-mona-lisa.transcript.json`.
2. **Deploy/checkout this branch's `racer/4.1.0`** (current `HEAD` of
   `claude/m4-ai-play-intelligence-1394d4`).
3. **Run D-1, D-2, and the held-out fixture again**, all three under
   `racer/4.1.0` — produces all three `candidate-rg-4.1.0/*.transcript.json`
   files.

Steps 2–3 can happen in one deployment; step 1 needs a separate one (or a
separate local checkout at the pre-M4 commit, for Path 2). No `racer/4.0.0`
evidence is regenerated for D-1/D-2 — the existing frozen transcripts in
`control-rg-4.0.0/` already are that evidence and are never rerun (per
`docs/m4-experiment-spec.md` §6).

---

## 3. Primary D9 measurement — computed now, on the two existing control transcripts

This is real analysis of real, already-existing evidence — not blocked, and
not dependent on any live run. Per `docs/m4-experiment-spec.md` §7, for
every run of two or more consecutive same-branch sibling `NO`s in the
`racer/4.0.0` control transcripts:

### D-1 (generic backpack), `racer/4.0.0` control

| Episode | Begins | Consecutive NOs | 4th+ sibling asked after 3rd NO? | Recovery move | D9 (M0 rubric, already scored in M3) |
|---|---|---|---|---|---|
| 1 | t7 | 8 (t7–t14: feet/legs, upper-body/torso, hands/wrists/neck, hips/waist/legs, face/head, waist, underwear, ears/jewelry — one body-location family) | **Yes** — siblings 4–8 (t10, t11, t12, t13, t14) all asked after the 3rd NO (t9) | t15 pivots to the parent container-category ("holds, contains, or carries other items") — a genuine step-back, not another sibling | Poor (`docs/m3-baseline-evaluation.md`, cited t7–t14→t15) |

No other run of 2+ consecutive same-branch NOs occurs elsewhere in D-1's 50
turns (checked against the full turn list; every other `NO` — t16, t21,
t30, t39, t49 — is isolated, not part of a sibling run).

### D-2 (Eiffel Tower), `racer/4.0.0` control

| Episode | Begins | Consecutive NOs | 4th+ sibling asked after 3rd NO? | Recovery move | D9 (M0 rubric, already scored in M3) |
|---|---|---|---|---|---|
| A | t8 | 7 (t8–t14: habitation, religious, infrastructure/bridge, art/sculpture, natural feature, industrial, vehicle — one "type of structure" family) | **Yes** — siblings 4–7 (t11, t12, t13, t14) after the 3rd NO (t10) | t15 pivots to a material-composition question (stone/brick/concrete) — a different dimension, though it also answers NO | Poor (part of `docs/m3-baseline-evaluation.md`'s combined citation) |
| B | t17 | 8 (t17–t24: archaeological artifact, weapon/tool, scientific instrument, royal regalia item, royal-regalia association, literary work, tapestry/textile, musical instrument — one "type of object" family within the confirmed metal/wood/glass material) | **Yes** — siblings 4–8 (t20, t21, t22, t23, t24) after the 3rd NO (t19) | t25 pivots to a narrower material question (specifically metal) — recovers | Poor |
| C | t26 | 12 (t26–t37: fountain/clock/bell, portable object, door/gate, chain/link, dam/sluice, courtyard structure, production structure, staircase/walkway, statue/monument, bridge-like span, roof/dome, gate/door-frame-metal — one "type of freestanding structure" family) | **Yes** — siblings 4–12 (t29 through t37, nine turns) after the 3rd NO (t28) | t38 pivots to structural completeness ("complete, intact physical structure or architectural element") — recovers, and t42 lands on "tower-like vertical structure" two turns later | Poor |

D-2's three episodes match `docs/m3-baseline-evaluation.md`'s own citation
(*"t8–14→t15; t17–24→t25; t26–37→t38 (3 episodes, up to 12 consecutive
NOs)"*) exactly.

**The decisive behavioral test stated in the pre-registered spec** — *no
fourth same-branch sibling probe after three consecutive related NOs* — is
violated in **all four control episodes**, confirming the M3 finding was
real and not an artifact of scoring. This is the baseline the `racer/4.1.0`
candidate reruns (once produced) are measured against: does the identical
test, run against `racer/4.1.0`, show zero fourth-sibling violations in the
equivalent episodes?

`racer/4.1.0` candidate rows for this table, and the held-out fixture's own
D9 measurement (both control and candidate), are added once the blocked
runs in §0/§1 complete.

---

## 4. Regression dimensions (D1–D8)

The `racer/4.0.0` control scores for every other dimension are already
frozen in `docs/m3-baseline-evaluation.md` and are not reproduced here —
this section will hold the `racer/4.1.0` candidate scores once those
transcripts exist, compared dimension-by-dimension against that same table.
D4 (redundancy) in particular stays a secondary observation only, per
`docs/m4-experiment-spec.md` §1 and §8 — reported honestly if it moves,
never used to justify the verdict in §5.

---

## 5. PASS / REVISE / REJECT

**Not renderable yet.** The criteria are fixed in
`docs/m4-experiment-spec.md` §9 and will not be restated, loosened, or
reinterpreted here once real evidence exists — this section is filled in
only after the four blocked rows in §0 are resolved.
