#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Mechanical enforcement of the isolation invariant. Runs before typecheck and
// before next build. A comment does not fail a build; this does.
//
// TWO CHECKS, because either alone has a hole.
//
// CHECK A — ALLOWLIST (added in M4, and the stronger of the two).
//   Scans EVERY .ts/.tsx file in the tree and asserts that the only modules
//   importing lib/secretStore.ts are the four permitted call sites. This
//   catches a violation in a file nobody thought to list — including files
//   that do not exist yet. M4 is what forced this: adding legitimate secret
//   readers made a quarantine-only model backwards, since it could only ever
//   catch violations in modules already known about.
//
// CHECK B — TRANSITIVE QUARANTINE (from M3).
//   Walks the local import graph from each Racer-facing entry point and fails
//   on any path reaching secretStore, however indirect. The allowlist alone
//   would not catch a Racer module importing an allowlisted module and getting
//   the secret second-hand.
// ---------------------------------------------------------------------------

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join, relative, sep } from "node:path";

const SECRET_MODULE = "lib/secretStore.ts";

/**
 * The complete set of modules permitted to import secretStore.ts.
 * Adding to this list is an architecture decision, not a build fix.
 */
const PERMITTED_SECRET_IMPORTERS = [
  "app/api/game/create/route.ts", // createSecret + lockSecret, at game creation
  "app/api/game/[id]/resolve/route.ts", // getSecretForAdjudication, at resolution
  // V2.3, APPROVED ARCHITECTURE DECISION. getSecretForComposer — the only
  // getter that returns target text to a browser before resolution, and the
  // only one taking an identity. A human Composer who refreshes must recover
  // their OWN secret; without this, reconnect is impossible for that seat.
  // The identity check lives inside the getter, not in this route, so the
  // route cannot forget it. One entry, deliberately narrow.
  "app/api/game/[id]/view/route.ts",
  "lib/prompts/validator.ts", // (reserved) pre-game validation
  "app/api/game/[id]/ask/route.ts", // getSecretForAnswering, every AI-Composer turn
  "app/api/game/[id]/clue/route.ts", // getSecretForAnswering, explicit SÚGÓ request (0.9.8.0)
  "lib/prompts/composerTarget.ts", // (reserved) produces the secret
  "lib/prompts/composerAnswer.ts", // (reserved) answers against the secret
  "lib/prompts/adjudicator.ts", // (reserved) judges the guess
  "lib/prompts/integrityReview.ts", // (reserved) judges the answers
];

/** Modules that must be structurally incapable of reaching the secret. */
const QUARANTINED = [
  // V2.2 — the durable corpus must be structurally incapable of reading the
  // secret. It records target metadata ONLY from the revealed_* fields that
  // /api/game/[id]/resolve writes into public state at the single
  // declassification point. This is the mechanical half of that decision:
  // the deliberate alternative was adding gameCorpus to
  // PERMITTED_SECRET_IMPORTERS, and it was rejected.
  "lib/corpus/gameCorpus.ts",
  "lib/corpus/db.ts",
  "lib/corpus/pendingQueue.ts",
  "lib/corpus/sqlStatements.ts",
  // V2.6 — Contest Verdict. A contest snapshot is a participant-readable
  // artefact assembled from the corpus, so the module that builds it must be
  // structurally incapable of reaching the secret. The target text it does
  // carry comes from corpus.game_targets, which was itself populated only from
  // the revealed_* fields written at the single declassification point — the
  // same seam gameCorpus has used since V2.2. The two routes are quarantined
  // alongside it so a later edit cannot reach the secret through the handler
  // rather than through the module.
  "lib/corpus/gameContests.ts",
  "app/api/game/[id]/contest/route.ts",
  "app/api/contest/[id]/route.ts",
  // V2.4 — the entitlement gate is a PRE-game concern. It has no business near
  // game state, seat authorization or the secret, and quarantining it is what
  // keeps that true as it grows.
  "lib/entitlements.ts",
  "scripts/migrate.ts",
  "lib/playerIdentity.ts",
  "lib/actingPlayer.ts",
  "lib/playerAccounts.ts",
  "lib/accountSession.ts",
  "app/api/account/register/route.ts",
  "app/api/account/login/route.ts",
  "app/api/account/logout/route.ts",
  "app/api/account/session/route.ts",
  "app/api/player/name/route.ts",
  "app/api/player/claim/route.ts",
  "app/api/player/recover/route.ts",
  "lib/playerStore.ts",
  "lib/recoveryCode.ts",
  "middleware.ts",
  "lib/prompts/racer.ts",
  // V2.5-B2 — the provider transports sit directly under the Racer seat, which
  // has been quarantined since V1. They carry whatever the Racer is given to
  // an external endpoint, so a secretStore import here would exfiltrate the
  // target to a vendor rather than merely leak it into a prompt. Quarantined
  // before a second provider exists, so the rule is already in force when
  // lib/providers/xai.ts is written rather than being added afterwards.
  "lib/providers/index.ts",
  "lib/providers/types.ts",
  "lib/providers/anthropic.ts",
  "lib/providers/xai.ts",
  "lib/anthropic.ts",
  // The latency probe drives the real Racer path against a live endpoint. It
  // carries whatever the Racer is given to an external vendor, so it sits in
  // the same blast radius as the adapters it exercises.
  "scripts/probeRacerLatency.ts",
  "lib/racerState.ts",
  "lib/gameStore.ts",
  "lib/resolveResult.ts",
  "lib/disclosureGuard.ts",
  "app/api/game/[id]/turn/route.ts",
  "app/game/[id]/page.tsx",
  "app/game/[id]/GameClient.tsx",
  "app/game/[id]/ResultPanel.tsx",
  "app/game/[id]/RacerClient.tsx", // the human Racer must never reach the target
  "app/RacerSetup.tsx",
];

const SCAN_ROOTS = ["app", "lib", "scripts", "test"];
const IMPORT_RE =
  /(?:import|export)[\s\S]*?from\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

function readImports(file) {
  const src = readFileSync(file, "utf8");
  const specs = [];
  for (const match of src.matchAll(IMPORT_RE)) {
    const spec = match[1] ?? match[2];
    if (spec) specs.push(spec);
  }
  return specs;
}

/** Resolve an import specifier to an absolute .ts/.tsx path, or null. */
function resolveSpec(spec, fromFile) {
  let base;
  if (spec.startsWith("@/")) base = resolve(process.cwd(), spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else return null; // package import

  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const repoRelative = (abs) => relative(process.cwd(), abs).split(sep).join("/");

const secretAbs = resolve(process.cwd(), SECRET_MODULE);
const violations = [];

// --- CHECK A: allowlist ----------------------------------------------------
const permitted = new Set(
  PERMITTED_SECRET_IMPORTERS.map((p) => resolve(process.cwd(), p))
);

const allFiles = SCAN_ROOTS.flatMap((root) => walk(resolve(process.cwd(), root)));
let scannedCount = 0;

for (const file of allFiles) {
  if (file === secretAbs) continue;
  scannedCount += 1;
  for (const spec of readImports(file)) {
    if (resolveSpec(spec, file) === secretAbs && !permitted.has(file)) {
      violations.push(
        `${repoRelative(file)} imports ${SECRET_MODULE} but is not a permitted call site`
      );
    }
  }
}

// --- CHECK B: transitive quarantine ----------------------------------------
for (const entry of QUARANTINED) {
  const entryAbs = resolve(process.cwd(), entry);
  if (!existsSync(entryAbs)) continue; // not all quarantined modules exist in every milestone

  const seen = new Set();
  const stack = [[entryAbs, [entry]]];

  while (stack.length > 0) {
    const frame = stack.pop();
    if (!frame) break;
    const [file, path] = frame;
    if (seen.has(file)) continue;
    seen.add(file);

    for (const spec of readImports(file)) {
      const target = resolveSpec(spec, file);
      if (!target) continue;
      if (target === secretAbs) {
        violations.push(
          `${entry} reaches ${SECRET_MODULE} via: ${[...path, SECRET_MODULE].join(" -> ")}`
        );
        continue;
      }
      stack.push([target, [...path, spec]]);
    }
  }
}

if (violations.length > 0) {
  console.error("\nISOLATION INVARIANT VIOLATED\n");
  for (const v of [...new Set(violations)]) console.error(`  ✗ ${v}`);
  console.error(
    `\n${SECRET_MODULE} is the only module permitted to touch SecretRecord, and\n` +
      "only the call sites in PERMITTED_SECRET_IMPORTERS may import it.\n\n" +
      "If a new path genuinely needs secret data, that is an architecture\n" +
      "decision — widen the allowlist deliberately and record why in\n" +
      "docs/DESIGN-NOTES.md. Do not widen it to make a build pass.\n"
  );
  process.exit(1);
}

console.log(
  `✓ isolation invariant holds ` +
    `(${scannedCount} files scanned, ${PERMITTED_SECRET_IMPORTERS.length} permitted call sites, ` +
    `${QUARANTINED.filter((q) => existsSync(resolve(process.cwd(), q))).length} quarantined modules walked)`
);
