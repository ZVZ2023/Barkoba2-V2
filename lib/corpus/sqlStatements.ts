// ---------------------------------------------------------------------------
// Splitting a .sql migration file into individual statements.
//
// WHY THIS EXISTS: Neon's SQL-over-HTTP transport sends ONE statement per
// request. The README is explicit — "you can only send one query at a time this
// way". A migration file is many statements, so something has to split it, and
// splitting SQL on a naive `.split(";")` is wrong the moment a statement
// contains a semicolon inside a string or a dollar-quoted function body:
//
//     CREATE FUNCTION f() RETURNS trigger AS $$
//     BEGIN
//       RAISE EXCEPTION 'nope';   <-- naive split breaks the file here
//     END;
//     $$ LANGUAGE plpgsql;
//
// 0001 contains exactly that, twice. So the splitter is dollar-quote aware,
// string aware and comment aware.
//
// This is a pure function with no I/O precisely so it can be tested without a
// database — which is what the first version of the runner lacked.
// ---------------------------------------------------------------------------

/**
 * Split SQL into executable statements.
 *
 * Understands: single-quoted strings (including '' escapes), double-quoted
 * identifiers, dollar-quoted bodies with or without a tag ($$ ... $$,
 * $body$ ... $body$), line comments (--) and block comments.
 *
 * Statements are returned trimmed, with empty and comment-only fragments
 * dropped. Terminating semicolons are removed; everything else is preserved
 * byte for byte, because rewriting a migration's SQL is not this function's job.
 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";

  let inSingle = false;
  let inDouble = false;
  let inLineComment = false;
  let inBlockComment = false;
  let dollarTag: string | null = null;

  let i = 0;
  while (i < sql.length) {
    const ch = sql[i] as string;
    const next = sql[i + 1];

    // --- inside a dollar-quoted body: only its matching tag can close it ----
    if (dollarTag !== null) {
      if (ch === "$" && sql.startsWith(dollarTag, i)) {
        current += dollarTag;
        i += dollarTag.length;
        dollarTag = null;
        continue;
      }
      current += ch;
      i += 1;
      continue;
    }

    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      current += ch;
      i += 1;
      continue;
    }

    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        current += "*/";
        i += 2;
        inBlockComment = false;
        continue;
      }
      current += ch;
      i += 1;
      continue;
    }

    if (inSingle) {
      current += ch;
      i += 1;
      // '' is an escaped quote, not a terminator.
      if (ch === "'") {
        if (sql[i] === "'") {
          current += "'";
          i += 1;
        } else {
          inSingle = false;
        }
      }
      continue;
    }

    if (inDouble) {
      current += ch;
      i += 1;
      if (ch === '"') inDouble = false;
      continue;
    }

    // --- not inside anything: look for openers and the statement terminator -
    if (ch === "-" && next === "-") {
      inLineComment = true;
      current += "--";
      i += 2;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      current += "/*";
      i += 2;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      current += ch;
      i += 1;
      continue;
    }
    if (ch === "$") {
      const tag = matchDollarTag(sql, i);
      if (tag) {
        dollarTag = tag;
        current += tag;
        i += tag.length;
        continue;
      }
    }
    if (ch === ";") {
      statements.push(current);
      current = "";
      i += 1;
      continue;
    }

    current += ch;
    i += 1;
  }

  statements.push(current);

  return statements.map(stripToStatement).filter((s) => s.length > 0);
}

/**
 * A dollar quote opener at `index`: `$$` or `$tag$`, where tag is an SQL
 * identifier. Returns the full opener (which is also its own terminator), or
 * null when this `$` is something else — a `$1` placeholder, for instance.
 */
function matchDollarTag(sql: string, index: number): string | null {
  const match = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(index));
  return match ? match[0] : null;
}

/**
 * Trim a fragment, drop it if it is only commentary, and remove the banner
 * comments that precede its first line of SQL.
 *
 * TWO RULES, AND THE DIFFERENCE BETWEEN THEM MATTERS:
 *
 *  1. A fragment that is only comments and whitespace — the long banner headers
 *     this project writes above every table — is not a statement and must never
 *     be sent to the server as one.
 *
 *  2. Comment lines BEFORE the first line of SQL are dropped; every comment
 *     from that line onwards is kept verbatim. Leading banners are safe to
 *     remove because nothing before the first SQL token can be inside a
 *     dollar-quoted body. Comments after it are NOT safe to touch: a `-- ...`
 *     line inside a plpgsql `$$ ... $$` body would be destroyed, silently
 *     changing what the function does.
 *
 * The payoff is diagnostic. Without this, every statement in an error message
 * begins with eighty characters of banner and the actual failing SQL is
 * invisible — which is precisely what made the first live migration failure
 * harder to read than it needed to be.
 */
function stripToStatement(fragment: string): string {
  const trimmed = fragment.trim();
  if (trimmed.length === 0) return "";

  const lines = trimmed.split("\n");
  const firstSql = lines.findIndex((line) => {
    const l = line.trim();
    return l.length > 0 && !l.startsWith("--");
  });

  // No line contains SQL: commentary only.
  if (firstSql === -1) return "";

  return lines.slice(firstSql).join("\n").trim();
}
