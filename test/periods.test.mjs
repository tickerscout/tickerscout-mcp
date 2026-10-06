import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseLabel,
  parsePeriodSpec,
  periodsOf,
  selectPeriods,
  PeriodNotAvailable,
  PeriodSpecError,
} from "../src/periods.ts";

// Shaped like NVDA's record: fiscal years end in late January, so FY2027 is mostly 2026.
const DOC = {
  ticker: "NVDA",
  annual: [
    { label: "FY2026", fiscal_year: 2026, period_start: "2025-01-27", period_end: "2026-01-25", source_accession: "a-26" },
    { label: "FY2025", fiscal_year: 2025, period_start: "2024-01-29", period_end: "2025-01-26", source_accession: "a-26" },
  ],
  quarterly: [
    { label: "Q2 FY2027", fiscal_year: 2027, fiscal_quarter: 2, period_start: "2026-04-27", period_end: "2026-07-26" },
    // A comparative column whose file states neither fiscal year nor quarter.
    { period_start: "2025-04-28", period_end: "2025-07-27" },
  ],
  year_to_date: { label: "First half FY2027", period_start: "2026-01-26", period_end: "2026-07-26" },
  trailing_twelve_months: { period_start: "2025-07-28", period_end: "2026-07-26" },
};
const ctx = { ticker: "NVDA", nextFiling: "2026-11-18 (10-Q)" };

test("parsePeriodSpec reads every documented form", () => {
  assert.deepEqual(parsePeriodSpec("FY2025"), { type: "fiscal_year", fy: 2025 });
  assert.deepEqual(parsePeriodSpec("fy25"), { type: "fiscal_year", fy: 2025 });
  assert.deepEqual(parsePeriodSpec("fiscal 2025"), { type: "fiscal_year", fy: 2025 });
  assert.deepEqual(parsePeriodSpec("2025"), { type: "fiscal_year", fy: 2025 });
  for (const q of ["Q2 FY2027", "Q2 2027", "FY27Q2", "fy27 q2", "2027Q2", "2Q27", "second quarter 2027", "Q2-2027"]) {
    assert.deepEqual(parsePeriodSpec(q), { type: "quarter", fy: 2027, q: 2 }, q);
  }
  assert.deepEqual(parsePeriodSpec("Q3"), { type: "quarter", fy: null, q: 3 });
  assert.deepEqual(parsePeriodSpec("ttm"), { type: "kind", kind: "trailing_twelve_months" });
  assert.deepEqual(parsePeriodSpec("year to date"), { type: "kind", kind: "year_to_date" });
  assert.deepEqual(parsePeriodSpec("2026-07-26"), { type: "date", date: "2026-07-26" });
  assert.equal(parsePeriodSpec(undefined).type, "every");
  assert.equal(parsePeriodSpec("all").type, "history");
  assert.equal(parsePeriodSpec("latest quarter").type, "latest_quarter");
  assert.equal(parsePeriodSpec("latest annual").type, "latest_annual");
  assert.throws(() => parsePeriodSpec("next tuesday"), PeriodSpecError);
});

test("parseLabel reads the fiscal year and quarter a label states", () => {
  assert.deepEqual(parseLabel("Q2 FY2027"), { fy: 2027, q: 2 });
  assert.deepEqual(parseLabel("FY2026 Q2 (three months ended July 31, 2026)"), { fy: 2026, q: 2 });
  assert.deepEqual(parseLabel("Three months ended March 31, 2026 (fiscal 2026 third quarter)"), { fy: 2026, q: 3 });
  assert.deepEqual(parseLabel("Second Quarter 2026"), { fy: 2026, q: 2 });
});

test("a quarter with no stated fiscal year or quarter is placed by the record's own fiscal years", () => {
  const ps = periodsOf(DOC, "FY27Q2");
  const comparative = ps.find((p) => p.period_end === "2025-07-27");
  assert.equal(comparative.fiscal_year, 2026);
  assert.equal(comparative.fiscal_quarter, 2);
  assert.equal(comparative.name, "Q2 FY2026");
});

test("periodsOf returns annual, quarterly and the single blocks, each with its path", () => {
  const ps = periodsOf(DOC, "FY27Q2");
  assert.deepEqual(ps.map((p) => p.kind), ["annual", "annual", "quarter", "quarter", "year_to_date", "trailing_twelve_months"]);
  assert.equal(ps[2].array, "quarterly");
  assert.equal(ps[2].index, 0);
  assert.equal(ps[5].index, null);
});

test("selectPeriods answers a named year, a quarter and the latest", () => {
  const ps = periodsOf(DOC, "FY27Q2");
  assert.equal(selectPeriods(ps, parsePeriodSpec("FY2025"), ctx)[0].period_end, "2025-01-26");
  assert.equal(selectPeriods(ps, parsePeriodSpec("Q2 FY2026"), ctx)[0].period_end, "2025-07-27");
  assert.equal(selectPeriods(ps, parsePeriodSpec("latest"), ctx)[0].name, "Q2 FY2027");
  assert.equal(selectPeriods(ps, parsePeriodSpec("latest annual"), ctx)[0].name, "FY2026");
  assert.equal(selectPeriods(ps, parsePeriodSpec("2026-07-27"), ctx).length, 3);
});

test("a period before the data says the data does not go back that far", () => {
  const ps = periodsOf(DOC, "FY27Q2");
  assert.throws(() => selectPeriods(ps, parsePeriodSpec("FY2019"), ctx), (e) =>
    e instanceof PeriodNotAvailable && /don't have data going back that far/.test(e.message) && /FY2025/.test(e.message));
});

test("a period after the data says it is not reported yet and names the next filing", () => {
  const ps = periodsOf(DOC, "FY27Q2");
  assert.throws(() => selectPeriods(ps, parsePeriodSpec("Q3 FY2027"), ctx), (e) =>
    e instanceof PeriodNotAvailable && /not in Ticker Scout's records/.test(e.message) && /2026-11-18/.test(e.message));
});

test("when two records hold the same quarter, the newer record's copy wins", () => {
  const older = periodsOf({ quarterly: [{ fiscal_year: 2026, fiscal_quarter: 2, period_start: "2025-04-28", period_end: "2025-07-27", v: "old" }] }, "FY26Q2");
  const newer = periodsOf(DOC, "FY27Q2");
  const hits = selectPeriods([...newer, ...older], parsePeriodSpec("Q2 FY2026"), ctx);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].record, "FY27Q2");
});
