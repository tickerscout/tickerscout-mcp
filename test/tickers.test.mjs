import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeTicker, matchCompanies, nearMatches, resolveTicker } from "../src/tickers.ts";

const ENTRIES = [
  { ticker: "AAPL", company: "Apple Inc." },
  { ticker: "NVDA", company: "NVIDIA Corporation" },
  { ticker: "BRK-B", company: "Berkshire Hathaway Inc." },
  { ticker: "C", company: "Citigroup Inc." },
];

const FILE = { ticker_count: 4, updated: "2026-08-10", tickers: ENTRIES };

test("normalizeTicker lowercases and converts dots to hyphens", () => {
  assert.equal(normalizeTicker("NVDA"), "nvda");
  assert.equal(normalizeTicker("  aapl "), "aapl");
  assert.equal(normalizeTicker("BRK.B"), "brk-b");
  assert.equal(normalizeTicker("brk-b"), "brk-b");
});

test("matchCompanies with no query returns everything", () => {
  assert.equal(matchCompanies(ENTRIES).length, 4);
  assert.equal(matchCompanies(ENTRIES, "   ").length, 4);
});

test("matchCompanies matches ticker and company name case-insensitively", () => {
  assert.deepEqual(
    matchCompanies(ENTRIES, "nvidia").map((e) => e.ticker),
    ["NVDA"],
  );
  assert.deepEqual(
    matchCompanies(ENTRIES, "NVDA").map((e) => e.ticker),
    ["NVDA"],
  );
  assert.deepEqual(
    matchCompanies(ENTRIES, "berkshire").map((e) => e.ticker),
    ["BRK-B"],
  );
});

test("nearMatches suggests by company substring when the ticker is wrong", () => {
  assert.ok(nearMatches(ENTRIES, "apple").includes("AAPL"));
});

test("nearMatches falls back to same first letter", () => {
  assert.ok(nearMatches(ENTRIES, "NVDIA").includes("NVDA"));
});

test("nearMatches never returns more than the limit", () => {
  assert.ok(nearMatches(ENTRIES, "zzzz", 2).length <= 2);
});

test("resolveTicker finds a covered company regardless of case or dot form", () => {
  assert.equal(resolveTicker(FILE, "nvda").ticker, "NVDA");
  assert.equal(resolveTicker(FILE, "BRK.B").ticker, "BRK-B");
});

test("resolveTicker throws with coverage count and a pointer to list_companies", () => {
  assert.throws(() => resolveTicker(FILE, "ZZZZ"), /not covered/);
  assert.throws(() => resolveTicker(FILE, "ZZZZ"), /list_companies/);
  assert.throws(() => resolveTicker(FILE, "ZZZZ"), /4 companies/);
});
