import { test } from "node:test";
import assert from "node:assert/strict";
import { condenseHeadline, listSections, sliceFinancials } from "../src/financials.ts";

const DOC = {
  ticker: "NVDA",
  company: "NVIDIA Corporation",
  units: "actual dollars",
  reporting_currency: "USD",
  business_type: "semiconductors",
  fiscal_period: { tag: "FY27Q1", period_end: "2026-04-26", form: "10-Q" },
  annual: [{ period: "FY2026" }],
  quarterly: [{ period: "Q1 FY2027" }],
  notes: ["a note"],
  headline: {
    period: "Q1 FY2027",
    period_end_words: "April 26, 2026",
    metrics: [
      {
        label: "Revenue",
        value: 81615000000,
        text: "$81.61 billion",
        exact: "$81,615,000,000",
        prior: "$44.06 billion",
        yoy: "up 85.2%",
        source: { source_accession: "0001045810-26-000052", period_label: "Q1 FY2027" },
      },
    ],
  },
};

test("condenseHeadline keeps figures and the accession, drops the source noise", () => {
  const h = condenseHeadline(DOC);
  assert.equal(h.period, "Q1 FY2027");
  assert.equal(h.metrics[0].label, "Revenue");
  assert.equal(h.metrics[0].exact, "$81,615,000,000");
  assert.equal(h.metrics[0].value, 81615000000);
  assert.equal(h.metrics[0].yoy, "up 85.2%");
  assert.equal(h.metrics[0].accession, "0001045810-26-000052");
  assert.equal(h.metrics[0].source, undefined);
});

test("condenseHeadline throws a useful error when there is no headline block", () => {
  const wmt = { ticker: "WMT", company: "Walmart Inc." };
  assert.throws(() => condenseHeadline(wmt), /WMT/);
  assert.throws(() => condenseHeadline(wmt), /get_financials/);
});

test("listSections returns data keys and excludes the meta header keys", () => {
  const s = listSections(DOC);
  assert.ok(s.includes("annual"));
  assert.ok(s.includes("quarterly"));
  assert.ok(s.includes("notes"));
  assert.ok(!s.includes("units"));
  assert.ok(!s.includes("company"));
});

test("a top-level scalar is a meta caveat, not a sliceable section", () => {
  const doc = { ...DOC, fiscal_calendar_note: "52/53 week year ending late January." };
  assert.ok(!listSections(doc).includes("fiscal_calendar_note"));
  // It must ride along with every slice: it is the file's own warning about
  // how to read the periods, and a caller should never have to ask for it.
  const out = sliceFinancials(doc, ["annual"]);
  assert.equal(out.meta.fiscal_calendar_note, "52/53 week year ending late January.");
});

test("sliceFinancials with no sections returns every data key", () => {
  const out = sliceFinancials(DOC);
  assert.ok(out.annual);
  assert.ok(out.quarterly);
  assert.ok(out.notes);
});

test("sliceFinancials always includes the units header, even for one section", () => {
  const out = sliceFinancials(DOC, ["annual"]);
  assert.equal(out.meta.units, "actual dollars");
  assert.equal(out.meta.reporting_currency, "USD");
  assert.equal(out.meta.company, "NVIDIA Corporation");
  assert.deepEqual(out.meta.fiscal_period, DOC.fiscal_period);
  assert.ok(out.annual);
  assert.equal(out.quarterly, undefined);
});

test("sliceFinancials rejects an unknown section and names the valid ones", () => {
  assert.throws(() => sliceFinancials(DOC, ["income_statement"]), /income_statement/);
  assert.throws(() => sliceFinancials(DOC, ["income_statement"]), /annual/);
});
