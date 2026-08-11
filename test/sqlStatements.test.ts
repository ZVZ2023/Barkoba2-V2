import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { splitSqlStatements } from "../lib/corpus/sqlStatements";

// ---------------------------------------------------------------------------
// Regression cover for the 2.2.0.0 live-migration failure.
//
// TWO DEFECTS, ONE INCIDENT:
//
//   1. The runner called sql(body) — a conventional call the driver forbids.
//      Fixed by using sql.query(), and permanently guarded by making the runner
//      TypeScript so `tsc` sees the tagged-template-only call signature.
//
//   2. Even with the right API, Neon's HTTP transport takes ONE statement per
//      request, so the file has to be split. Splitting SQL is where a runner
//      quietly corrupts a migration, and 0001 is exactly the hard case: two
//      plpgsql function bodies containing semicolons inside $$ quotes.
//
// These tests run against the REAL migration file, not a toy fixture, because
// the only thing that matters is that 0001 splits correctly.
// ---------------------------------------------------------------------------

const MIGRATION = readFileSync("migrations/0001_corpus_foundation.sql", "utf8");

// --- the hard case: dollar-quoted bodies ------------------------------------

test("a semicolon inside a dollar-quoted body does not split the statement", () => {
  const sql = `
    CREATE FUNCTION f() RETURNS trigger AS $$
    BEGIN
      RAISE EXCEPTION 'nope';
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `;
  const out = splitSqlStatements(sql);
  assert.equal(out.length, 1, "the whole function is one statement");
  assert.match(out[0]!, /RAISE EXCEPTION/);
  assert.match(out[0]!, /LANGUAGE plpgsql$/);
});

test("tagged dollar quotes are matched by their own tag", () => {
  const sql = `
    CREATE FUNCTION g() RETURNS text AS $body$
      SELECT 'a; b';
    $body$ LANGUAGE sql;
    SELECT 1;
  `;
  const out = splitSqlStatements(sql);
  assert.equal(out.length, 2);
  assert.match(out[0]!, /\$body\$/);
  assert.equal(out[1], "SELECT 1");
});

test("a $1 placeholder is not mistaken for a dollar quote", () => {
  const out = splitSqlStatements("SELECT * FROM t WHERE id = $1; SELECT 2;");
  assert.equal(out.length, 2);
  assert.equal(out[0], "SELECT * FROM t WHERE id = $1");
});

// --- strings and comments ---------------------------------------------------

test("a semicolon inside a string literal does not split the statement", () => {
  const out = splitSqlStatements("INSERT INTO t VALUES ('a;b'); SELECT 1;");
  assert.equal(out.length, 2);
  assert.equal(out[0], "INSERT INTO t VALUES ('a;b')");
});

test("an escaped quote inside a string is handled", () => {
  const out = splitSqlStatements("SELECT 'it''s; fine'; SELECT 2;");
  assert.equal(out.length, 2);
  assert.equal(out[0], "SELECT 'it''s; fine'");
});

test("a semicolon inside a line comment does not split the statement", () => {
  const out = splitSqlStatements("SELECT 1 -- trailing ; comment\n; SELECT 2;");
  assert.equal(out.length, 2);
  assert.match(out[0]!, /SELECT 1/);
});

test("comment-only fragments are never emitted as statements", () => {
  const out = splitSqlStatements(`
    -- a banner
    -- spanning lines
    SELECT 1;
    -- trailing banner with no statement after it
  `);
  // One statement: the trailing banner is dropped because it contains no SQL.
  assert.equal(out.length, 1);
  assert.match(out[0]!, /SELECT 1/);
});

test("banner comments BEFORE the first line of SQL are dropped", () => {
  // Purely diagnostic: without this, every statement in a failure message
  // begins with eighty characters of banner and the failing SQL is invisible.
  // Safe because nothing before the first SQL token can be inside a $$ body.
  const out = splitSqlStatements("-- why this table exists\nCREATE TABLE t (id int);");
  assert.equal(out.length, 1);
  assert.equal(out[0], "CREATE TABLE t (id int)");
});

test("every statement from 0001 begins with SQL, not a banner", () => {
  for (const s of splitSqlStatements(MIGRATION)) {
    assert.ok(
      !s.startsWith("--"),
      `statement still starts with a banner, hiding the SQL: ${s.slice(0, 60)}`
    );
  }
});

test("a comment line inside a plpgsql body is preserved, not stripped", () => {
  const sql = `
    CREATE FUNCTION h() RETURNS trigger AS $$
    BEGIN
      -- this comment must survive
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `;
  const out = splitSqlStatements(sql);
  assert.equal(out.length, 1);
  assert.match(out[0]!, /-- this comment must survive/);
});

test("a block comment containing a semicolon is not a split point", () => {
  const out = splitSqlStatements("/* one; two */ SELECT 1; SELECT 2;");
  assert.equal(out.length, 2);
});

test("empty input yields no statements", () => {
  assert.deepEqual(splitSqlStatements(""), []);
  assert.deepEqual(splitSqlStatements("   \n\n  "), []);
  assert.deepEqual(splitSqlStatements(";;;"), []);
});

test("a final statement without a trailing semicolon is still returned", () => {
  assert.deepEqual(splitSqlStatements("SELECT 1"), ["SELECT 1"]);
});

// --- against the real migration ---------------------------------------------

test("0001 splits into a plausible number of executable statements", () => {
  const out = splitSqlStatements(MIGRATION);
  assert.ok(out.length >= 20, `expected many statements, got ${out.length}`);
  // Nothing may be emitted that is only a comment banner.
  for (const s of out) {
    assert.notEqual(s.trim(), "");
    assert.ok(
      !/^(--|\/\*)/.test(s.trim()) || /[A-Za-z]+\s/.test(s.replace(/^\s*--.*$/gm, "").trim()),
      `comment-only fragment leaked into the statement list: ${s.slice(0, 60)}`
    );
  }
});

test("0001's two plpgsql functions each survive as ONE statement", () => {
  const out = splitSqlStatements(MIGRATION);
  const fns = out.filter((s) => /CREATE OR REPLACE FUNCTION/.test(s));
  assert.equal(fns.length, 2, "0001 defines exactly two trigger functions");
  for (const fn of fns) {
    // If dollar-quoting were mishandled these would be truncated at the first
    // internal semicolon and would not contain their own terminator.
    assert.match(fn, /LANGUAGE plpgsql$/);
    assert.match(fn, /RAISE EXCEPTION/);
    assert.match(fn, /RETURN NEW/);
  }
});

test("0001's structural guarantees each survive as their own statement", () => {
  const out = splitSqlStatements(MIGRATION);
  const has = (re: RegExp) => out.some((s) => re.test(s));

  assert.ok(has(/CREATE SCHEMA IF NOT EXISTS corpus/), "corpus schema");
  assert.ok(has(/CREATE SCHEMA IF NOT EXISTS derived/), "derived schema");
  assert.ok(has(/CREATE TABLE IF NOT EXISTS corpus\.games/), "games table");
  assert.ok(has(/CREATE TABLE IF NOT EXISTS corpus\.game_turns/), "turns table");
  assert.ok(has(/CREATE TABLE IF NOT EXISTS corpus\.game_targets/), "targets table");
  assert.ok(has(/CREATE TABLE IF NOT EXISTS corpus\.game_resolutions/), "resolutions table");
  assert.ok(has(/CREATE UNIQUE INDEX IF NOT EXISTS game_turns_main_sequence/), "chronology index");
  assert.ok(has(/CREATE TRIGGER games_immutable_once_finalized/), "games immutability");
  assert.ok(has(/CREATE TRIGGER turns_immutable_once_finalized/), "turns immutability");
});

test("no statement still carries a trailing semicolon", () => {
  // Each fragment is submitted as its own query; a stray terminator would make
  // it a multi-statement string, which is what the HTTP transport rejects.
  for (const s of splitSqlStatements(MIGRATION)) {
    assert.ok(!s.trimEnd().endsWith(";"), `statement still ends with ';': ${s.slice(0, 70)}`);
  }
});

test("splitting is lossless — no SQL is dropped, duplicated or reordered", () => {
  // Compare the concatenated statements against the source with the SAME
  // normalization applied to both sides: drop whole-line comments, drop
  // statement terminators, ignore whitespace. Anything the splitter lost or
  // invented shows up as a length mismatch.
  // Whole-line comments are dropped on BOTH sides, because leading banners are
  // intentionally removed from statements and comments inside plpgsql bodies
  // are intentionally kept. Normalizing both the same way isolates the SQL.
  const normalize = (s: string) =>
    s
      .split("\n")
      .map((l) => l.replace(/^\s*--.*$/, ""))
      .join("\n")
      .replace(/;/g, "")
      .replace(/\s+/g, "");

  const rejoined = normalize(splitSqlStatements(MIGRATION).join("\n"));
  const source = normalize(MIGRATION);

  assert.ok(rejoined.length > 0);
  assert.equal(rejoined, source, "the statements sent must be exactly the migration's SQL");
});
