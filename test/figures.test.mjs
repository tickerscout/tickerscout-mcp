import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FIGURES,
  display,
  figureById,
  figureLink,
  figureRows,
  findStandardFigure,
  flattenPeriod,
  headlineField,
  nameOf,
  normName,
  resolveFigure,
} from "../src/figures.ts";
import { periodsOf } from "../src/periods.ts";

// Shaped like Walmart's record: net income lives under a company-specific name, and the
// headline says which field the company itself reports as net income.
const WMT = {
  ticker: "WMT",
  reporting_currency: "USD",
  annual: [
    {
      fiscal_year: 2026,
      period_start: "2025-02-01",
      period_end: "2026-01-31",
      source_accession: "0000104169-26-000010",
      income_statement: {
        total_revenues: 700000000000,
        consolidated_net_income: 20000000000,
        net_income_attributable_to_walmart: 19400000000,
        diluted_eps: 2.41,
      },
      balance_sheet: { total_equity: 100000000000, total_walmart_shareholders_equity: 95000000000 },
    },
  ],
  headline: {
    metrics: [
      { label: "Net income", source: { field: "income_statement.net_income_attributable_to_walmart" } },
      { label: "Revenue", source: { field: "income_statement.total_revenues" } },
    ],
  },
  figure_sources: {
    documents: { d1: "https://www.sec.gov/Archives/edgar/data/104169/000010416926000010/wmt-20260131.htm" },
    annual: [{ period_end: "2026-01-31", income_statement: { total_revenues: "d1#f-12" } }],
  },
};
const [FY26] = periodsOf(WMT, "FY26");

test("the company's own headline field is primary, and the other net income is shown as related", () => {
  const def = figureById("net_income");
  const r = resolveFigure(FY26, def, headlineField(WMT, def));
  assert.equal(r.primary.field, "income_statement.net_income_attributable_to_walmart");
  assert.equal(r.matched_by, "company headline field");
  assert.ok(r.related.some((x) => x.field === "income_statement.consolidated_net_income"));
});

test("a company-named equity line beats total equity, which includes noncontrolling interests", () => {
  const r = resolveFigure(FY26, figureById("shareholders_equity"), null);
  assert.equal(r.primary.field, "balance_sheet.total_walmart_shareholders_equity");
  assert.equal(r.matched_by, "unique name pattern");
});

test("nothing is guessed: a figure the record does not carry has no primary", () => {
  const r = resolveFigure(FY26, figureById("inventories"), null);
  assert.equal(r.primary, null);
});

test("nested breakdowns resolve by path: revenue.total_revenues", () => {
  const [p] = periodsOf({ annual: [{ fiscal_year: 2025, income_statement: { revenue: { automotive: 1, total_revenues: 97690000000 } } }] }, "x");
  const r = resolveFigure(p, figureById("revenue"), null);
  assert.equal(r.primary.field, "income_statement.revenue.total_revenues");
  assert.equal(r.primary.value, 97690000000);
});

test("every row leads with the record's own name and its exact JSON path", () => {
  const { values } = figureRows(WMT, [FY26], figureById("revenue"), new Map());
  assert.equal(values[0].name_in_record, "total_revenues");
  assert.equal(values[0].json_path, "annual[0].income_statement.total_revenues");
  assert.equal(values[0].sec_link, "https://www.sec.gov/Archives/edgar/data/104169/000010416926000010/wmt-20260131.htm#f-12");
});

test("figureLink returns null for a figure the filing does not tag", () => {
  assert.equal(figureLink(WMT, FY26, "income_statement.diluted_eps"), null);
});

test("standard figures are found by id, label, synonym or one of their field names", () => {
  assert.equal(findStandardFigure("revenue").id, "revenue");
  assert.equal(findStandardFigure("Net sales").id, "revenue");
  assert.equal(findStandardFigure("EPS").id, "diluted_eps");
  assert.equal(findStandardFigure("capex").id, "capital_expenditures");
  assert.equal(findStandardFigure("total_net_sales").id, "revenue");
  assert.equal(findStandardFigure("comparable sales"), undefined);
});

test("every standard figure has a unique id, a definition and at least one field name", () => {
  const ids = new Set();
  for (const f of FIGURES) {
    assert.ok(!ids.has(f.id), f.id);
    ids.add(f.id);
    assert.ok(f.definition.length > 10, f.id);
    assert.ok(f.aliases.length > 0, f.id);
  }
});

test("names compare without case or punctuation, and a path's name is its last key", () => {
  assert.equal(normName("Data Center"), "data_center");
  assert.equal(normName("revenue_by_market_platform.Data Center"), "revenue_by_market_platform_data_center");
  assert.equal(nameOf("reportable_segments.Compute & Networking.revenue"), "revenue");
});

test("flattenPeriod lists every number as a dotted path", () => {
  const paths = flattenPeriod(FY26).map((f) => f.path);
  assert.ok(paths.includes("income_statement.total_revenues"));
  assert.ok(paths.includes("balance_sheet.total_walmart_shareholders_equity"));
});

test("display writes money, per-share, share and percent figures readably", () => {
  assert.equal(display(96221000000, "money"), "$96.22 billion ($96,221,000,000)");
  assert.equal(display(-5855000000, "money"), "-$5.86 billion (-$5,855,000,000)");
  assert.equal(display(2.46, "per_share"), "$2.46");
  assert.equal(display(24285000000, "shares"), "24.29 billion shares");
  assert.equal(display(75, "percent"), "75%");
});
