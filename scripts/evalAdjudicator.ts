/**
 * Adjudicator evaluation harness.
 *
 *   npm run eval:adjudicator
 *   npm run eval:adjudicator -- --repeat 3
 *   npm run eval:adjudicator -- --category part_vs_whole
 *   npm run eval:adjudicator -- --gate 0.9
 *
 * DELIBERATELY NOT PART OF `npm test` OR `npm run verify`. This hits the real
 * API: it costs money, needs a key, and can fail on a network blip. A build
 * that breaks for those reasons is a build people learn to ignore. The fixture
 * DATA is protected hermetically by test/adjudicationFixtures.test.ts instead.
 *
 * NO PASS THRESHOLD BY DEFAULT. The first run establishes a baseline; gates get
 * set afterwards, per category, once there is evidence to set them from.
 * Picking a number before seeing a single result would be inventing a standard,
 * not measuring against one.
 *
 * --repeat N re-runs every fixture N times and reports how many gave unstable
 * verdicts. At temperature 0 that count is EXPECTED to be zero — but expected
 * is not the same as guaranteed, which is why it is measured rather than
 * assumed.
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runAdjudicator } from "../lib/prompts/adjudicator";
import {
  ADJUDICATION_CATEGORIES,
  ADJUDICATION_FIXTURES,
  type AdjudicationFixture,
} from "../test/fixtures/adjudication";

/**
 * Minimal .env.local loader, no dependency.
 *
 * `next dev` and `next build` read .env.local automatically. A bare
 * `tsx script.ts` does not. Without this, the key would have to be set twice —
 * once where the README says to put it, and again in the shell — and the
 * failure would present as "the harness is broken" rather than "the harness
 * cannot see your config".
 *
 * Never overrides a variable already set in the real environment.
 */
function loadEnvFiles(): string | null {
  for (const file of [".env.local", ".env"]) {
    const path = resolve(process.cwd(), file);
    if (!existsSync(path)) continue;
    for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
    return file;
  }
  return null;
}

const envFileUsed = loadEnvFiles();

interface Outcome {
  fixture: AdjudicationFixture;
  verdicts: string[];
  confidences: number[];
  reasonings: string[];
  errors: string[];
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1] as string;
  const inline = process.argv.find((a) => a.startsWith(`--${name}=`));
  return inline ? inline.split("=").slice(1).join("=") : null;
}

const repeat = Math.max(1, Number.parseInt(arg("repeat") ?? "1", 10) || 1);
const categoryFilter = arg("category");
const gateRaw = arg("gate");
const gate = gateRaw === null ? null : Number.parseFloat(gateRaw);

/**
 * Parallel in-flight requests. Lower this on a new or low-tier API account —
 * a fresh key can have tight rate limits, and 429s during a 210-call run
 * produce an unreadable baseline.
 */
const CONCURRENCY = Math.max(1, Number.parseInt(arg("concurrency") ?? "4", 10) || 4);

/** Transient failures worth retrying: rate limits and overload. */
function isTransient(err: unknown): boolean {
  const text = String(err);
  return /\b(429|529|500|502|503|504)\b/.test(text) || /rate.?limit|overloaded/i.test(text);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function passed(o: Outcome, i: number): boolean {
  const f = o.fixture;
  const verdict = o.verdicts[i];
  const confidence = o.confidences[i];
  if (verdict === undefined || confidence === undefined) return false;
  // An infrastructure failure is not an adjudication failure. Callers must
  // exclude these from rates rather than score them — see the report loop.
  if (verdict === "ERROR") return false;
  if (f.expect === null) {
    // Borderline: calibration, not correctness. Either verdict is acceptable;
    // overconfidence is not.
    return confidence <= (f.maxConfidence ?? 1);
  }
  return verdict === f.expect;
}

async function runPool<T>(items: T[], worker: (item: T) => Promise<void>) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      const item = items[index];
      if (item !== undefined) await worker(item);
    }
  });
  await Promise.all(runners);
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "\nANTHROPIC_API_KEY is not set.\n\n" +
        "This harness calls the real Adjudicator. Two ways to provide the key:\n\n" +
        "  1. Put it in .env.local at the project root (git-ignored):\n" +
        "       ANTHROPIC_API_KEY=sk-ant-...\n\n" +
        "  2. Or set it for one shell session:\n" +
        "       PowerShell:  $env:ANTHROPIC_API_KEY=\"sk-ant-...\"\n" +
        "       bash/zsh:    export ANTHROPIC_API_KEY=sk-ant-...\n\n" +
        (envFileUsed
          ? `Read ${envFileUsed}, but it did not contain ANTHROPIC_API_KEY.\n`
          : "No .env.local or .env file was found at the project root.\n")
    );
    process.exit(2);
  }

  // Comma-separated, so a targeted re-run after fixture corrections is one
  // command rather than one command per category.
  const wanted = categoryFilter
    ? categoryFilter.split(",").map((c) => c.trim()).filter(Boolean)
    : null;

  if (wanted) {
    const unknown = wanted.filter(
      (c) => !(ADJUDICATION_CATEGORIES as string[]).includes(c)
    );
    if (unknown.length > 0) {
      console.error(`Unknown categor${unknown.length > 1 ? "ies" : "y"}: ${unknown.join(", ")}`);
      console.error(`Known: ${ADJUDICATION_CATEGORIES.join(", ")}`);
      process.exit(2);
    }
  }

  const fixtures = wanted
    ? ADJUDICATION_FIXTURES.filter((f) => wanted.includes(f.category))
    : ADJUDICATION_FIXTURES;

  if (fixtures.length === 0) {
    console.error(`No fixtures for category "${categoryFilter}".`);
    process.exit(2);
  }

  console.log(
    `\nAdjudicator eval — ${fixtures.length} fixtures x ${repeat} run(s) = ` +
      `${fixtures.length * repeat} model calls` +
      (envFileUsed ? `  (key from ${envFileUsed})` : "  (key from environment)") +
      "\n"
  );

  const outcomes = new Map<string, Outcome>();
  for (const f of fixtures) {
    outcomes.set(f.id, { fixture: f, verdicts: [], confidences: [], reasonings: [], errors: [] });
  }

  for (let round = 0; round < repeat; round++) {
    process.stdout.write(repeat > 1 ? `  run ${round + 1}/${repeat} ` : "  running ");
    await runPool(fixtures, async (f) => {
      const o = outcomes.get(f.id)!;
      // Retry transient failures. A 429 on a fresh API key is not evidence
      // about the Adjudicator, and must not be recorded as though it were.
      let lastErr: unknown = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const r = await runAdjudicator({
            target: f.target,
            privateClarification: f.clarification,
            guess: f.guess,
            gameLanguage: f.language,
          });
          o.verdicts.push(r.verdict);
          o.confidences.push(r.confidence);
          o.reasonings.push(r.reasoning);
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          if (!isTransient(err) || attempt === 3) break;
          await sleep(1000 * Math.pow(2, attempt));
          process.stdout.write("r");
        }
      }
      if (lastErr !== null) {
        o.verdicts.push("ERROR");
        o.confidences.push(0);
        o.reasonings.push("");
        o.errors.push(String(lastErr));
      }
      process.stdout.write(".");
    });
    process.stdout.write("\n");
  }

  // --- per-category report --------------------------------------------------
  console.log("\n" + "-".repeat(78));
  console.log(
    "CATEGORY".padEnd(24) +
      "PASS".padStart(9) +
      "RATE".padStart(9) +
      "  MEAN CONF" +
      "   ERR"
  );
  console.log("-".repeat(78));

  const categories = ADJUDICATION_CATEGORIES.filter((c) =>
    fixtures.some((f) => f.category === c)
  );
  let totalPass = 0;
  let totalRuns = 0;
  let totalErrs = 0;

  for (const category of categories) {
    const inCat = fixtures.filter((f) => f.category === category);
    let pass = 0;
    let runs = 0;
    let errs = 0;
    let confSum = 0;
    for (const f of inCat) {
      const o = outcomes.get(f.id)!;
      for (let i = 0; i < o.verdicts.length; i++) {
        if (o.verdicts[i] === "ERROR") {
          errs++;
          continue; // excluded from the denominator, not scored as a wrong verdict
        }
        runs++;
        confSum += o.confidences[i] ?? 0;
        if (passed(o, i)) pass++;
      }
    }
    totalPass += pass;
    totalRuns += runs;
    totalErrs += errs;
    const rate = runs > 0 ? pass / runs : 0;
    console.log(
      category.padEnd(24) +
        `${pass}/${runs}`.padStart(9) +
        `${(rate * 100).toFixed(0)}%`.padStart(9) +
        `  ${(confSum / Math.max(1, runs)).toFixed(2)}` +
        `${errs > 0 ? String(errs).padStart(6) : "".padStart(6)}`
    );
  }

  console.log("-".repeat(78));
  const overall = totalRuns > 0 ? totalPass / totalRuns : 0;
  console.log(
    "OVERALL".padEnd(24) +
      `${totalPass}/${totalRuns}`.padStart(9) +
      `${(overall * 100).toFixed(0)}%`.padStart(9) +
      "".padStart(12) +
      `${totalErrs > 0 ? String(totalErrs).padStart(6) : ""}`
  );

  if (totalErrs > 0) {
    console.log(
      `\n!! ${totalErrs} call(s) failed and are EXCLUDED from the rates above.\n` +
        "   Rates are computed over completed calls only, so they are not\n" +
        "   depressed by infrastructure failures — but with this many errors the\n" +
        "   sample is incomplete. Re-run with --concurrency 2 before treating\n" +
        "   this as a baseline."
    );
  }

  // --- failures -------------------------------------------------------------
  const failing = fixtures.filter((f) => {
    const o = outcomes.get(f.id)!;
    return o.verdicts.some((_, i) => !passed(o, i));
  });

  if (failing.length > 0) {
    console.log("\nFAILURES\n" + "-".repeat(78));
    for (const f of failing) {
      const o = outcomes.get(f.id)!;
      const expected =
        f.expect === null ? `confidence <= ${f.maxConfidence}` : f.expect;
      console.log(`\n  ${f.id}  [${f.category}]`);
      console.log(`    target      : ${f.target}`);
      console.log(`    clarification: ${f.clarification}`);
      console.log(`    guess       : ${JSON.stringify(f.guess)}`);
      console.log(`    expected    : ${expected}`);
      console.log(`    got         : ${o.verdicts.join(", ")} @ conf ${o.confidences.map((c) => c.toFixed(2)).join(", ")}`);
      if (o.reasonings[0]) console.log(`    reasoning   : ${o.reasonings[0]}`);
      if (f.note) console.log(`    fixture note: ${f.note}`);
    }
  }

  // --- variance -------------------------------------------------------------
  if (repeat > 1) {
    // A failed call is not a changed verdict. Excluding ERROR here is the same
    // correction applied to the pass rates: infrastructure noise must never be
    // reported as model instability, or a rate-limited run looks like a
    // non-deterministic Adjudicator.
    const realVerdicts = (o: Outcome) => o.verdicts.filter((v) => v !== "ERROR");
    const unstable = fixtures.filter(
      (f) => new Set(realVerdicts(outcomes.get(f.id)!)).size > 1
    );
    const tainted = fixtures.filter((f) => outcomes.get(f.id)!.verdicts.includes("ERROR"));

    console.log("\n" + "-".repeat(78));
    console.log(
      `VARIANCE across ${repeat} runs: ${unstable.length}/${fixtures.length} fixtures gave unstable verdicts`
    );
    console.log(
      unstable.length === 0
        ? "  No instability observed. Note this detects gross flipping, not rare ones:\n" +
            `  a fixture that flips 10% of the time has only ~${(100 * (1 - (0.9 ** repeat + 0.1 ** repeat))).toFixed(0)}% chance of showing up in ${repeat} runs.`
        : "  Verdicts are not fully reproducible. Determinism is carried by prompt\n" +
            "  instruction only — sampling parameters are deprecated on current models."
    );

    if (tainted.length > 0) {
      console.log(
        `\n  !! ${tainted.length} fixture(s) had at least one FAILED call. Their stability\n` +
          "     result is incomplete and should not be classified until re-run cleanly:"
      );
      for (const f of tainted) {
        console.log(`       ${f.id}: ${outcomes.get(f.id)!.verdicts.join(" / ")}`);
      }
    }

    // Per-repeat reasoning for unstable fixtures. Without this there is no way
    // to tell whether the model changed its mind or applied a different rule.
    for (const f of unstable) {
      const o = outcomes.get(f.id)!;
      console.log(`\n  ${f.id}  [${f.category}]  ${o.verdicts.join(" / ")}`);
      console.log(`    target : ${f.target}`);
      console.log(`    guess  : ${JSON.stringify(f.guess)}`);
      for (let i = 0; i < o.verdicts.length; i++) {
        console.log(
          `    run ${i + 1}: ${o.verdicts[i]} @ ${(o.confidences[i] ?? 0).toFixed(2)} — ${o.reasonings[i] || "(none)"}`
        );
      }
    }
  }

  const errored = fixtures.filter((f) => outcomes.get(f.id)!.errors.length > 0);
  if (errored.length > 0) {
    console.log(`\n${errored.length} fixture(s) errored:`);
    for (const f of errored) {
      console.log(`  ${f.id}: ${outcomes.get(f.id)!.errors[0]}`);
    }
  }

  if (gate === null) {
    console.log(
      "\nNo gate set — this is a baseline run. Inspect the per-category table,\n" +
        "then set thresholds with --gate once there is evidence to set them from.\n"
    );
    if (totalErrs === 0) {
      console.log("All calls completed. This baseline is safe to read.\n");
    }
    process.exit(errored.length > 0 ? 1 : 0);
  }

  const meets = overall >= gate;
  console.log(
    `\nGate: ${(gate * 100).toFixed(0)}% — ${meets ? "MET" : "NOT MET"} (${(overall * 100).toFixed(1)}%)\n`
  );
  process.exit(meets && errored.length === 0 ? 0 : 1);
}

void main();
