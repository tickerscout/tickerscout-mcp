import { test } from "node:test";
import assert from "node:assert/strict";
import { splitSections, findSection, sectionIndex } from "../src/markdown.ts";

const DOC = `# NVIDIA Corporation

Intro line that belongs to no section.

## Business

NVIDIA is a computing infrastructure company. It designs GPUs.

### Segments

The Compute segment is the larger of the two.

## Risk factors

| Risk | Change |
| --- | --- |
| Supply | Increased |

Demand for our products may not meet expectations. That would hurt revenue.

## Management's discussion and analysis, fiscal 2026

Revenue grew.
`;

test("splitSections finds only h2 headings", () => {
  const s = splitSections(DOC);
  assert.deepEqual(
    s.map((x) => x.heading),
    ["Business", "Risk factors", "Management's discussion and analysis, fiscal 2026"],
  );
});

test("an h3 stays inside its parent section and does not split it", () => {
  const business = splitSections(DOC).find((s) => s.heading === "Business");
  assert.match(business.body, /### Segments/);
  assert.match(business.body, /Compute segment/);
});

test("firstSentence skips pipe-table rows", () => {
  const risk = splitSections(DOC).find((s) => s.heading === "Risk factors");
  assert.equal(risk.firstSentence, "Demand for our products may not meet expectations.");
});

test("findSection matches case-insensitively on a prefix", () => {
  assert.equal(findSection(splitSections(DOC), "risk").heading, "Risk factors");
  assert.equal(findSection(splitSections(DOC), "RISK FACTORS").heading, "Risk factors");
});

test("findSection matches a variable-suffix heading by its stable prefix", () => {
  const hit = findSection(splitSections(DOC), "management's discussion");
  assert.match(hit.heading, /^Management's discussion/);
});

test("findSection returns null for no match", () => {
  assert.equal(findSection(splitSections(DOC), "cash flow"), null);
});

test("sectionIndex reports heading, size and first sentence", () => {
  const idx = sectionIndex(DOC);
  assert.equal(idx.length, 3);
  assert.equal(idx[0].heading, "Business");
  assert.ok(idx[0].chars > 0);
  assert.equal(idx[0].first_sentence, "NVIDIA is a computing infrastructure company.");
});
