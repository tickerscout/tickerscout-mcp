import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EVENT_TOPICS,
  NARRATIVE_TOPICS,
  outline,
  parseQuery,
  searchPassages,
  searchSections,
  splitPassages,
  topicMatches,
} from "../src/topics.ts";
import { AccessionIndex, edgarIndexUrl, normalizeAccession, passagesCiting } from "../src/filings.ts";

const NARRATIVE = `# Example Corp (EXM)

## Business

Example makes widgets.

## Risk factors

**Export controls.** New rules restrict sales to China.

**Antitrust and regulatory.**

- *US Search.* A court ruled against the company; it appealed.
- *EU.* A fine was annulled.

**Supply.** One foundry makes every chip.

## Management's discussion — fiscal 2025

Revenue rose 10%.

### Liquidity

Cash was $5 billion.

## The second quarter of 2026

Revenue rose 12% in the quarter.

## Subsequent events

None.
`;

const EVENTS = `# Example Corp — Recent Events

## Earnings and guidance

- **Form 8-K, accession 0000000001-26-000010, filed August 1, 2026** — second-quarter results.

## Board and management changes

- **July 1, 2026:** The CFO resigned; a successor was appointed. (Source: Form 8-K, accession 0000000001-26-000009.)
`;

test("each narrative topic finds its section whatever the heading's suffix", () => {
  const name = (t) => topicMatches(NARRATIVE, NARRATIVE_TOPICS[t]).map((m) => m.heading);
  assert.deepEqual(name("business"), ["Business"]);
  assert.deepEqual(name("risk_factors"), ["Risk factors"]);
  assert.deepEqual(name("annual_mdna"), ["Management's discussion — fiscal 2025"]);
  assert.deepEqual(name("current_quarter"), ["The second quarter of 2026"]);
  assert.deepEqual(name("subsequent_events"), ["Subsequent events"]);
});

test("a bold run-in head on its own line carries the passages under it, up to the next head", () => {
  const legal = topicMatches(NARRATIVE, NARRATIVE_TOPICS.legal_proceedings);
  const antitrust = legal.find((m) => /Antitrust/.test(m.heading));
  assert.ok(antitrust);
  assert.match(antitrust.body, /US Search/);
  assert.match(antitrust.body, /EU\./);
  assert.doesNotMatch(antitrust.body, /foundry/);
});

test("event topics match by heading and by keyword", () => {
  const mgmt = topicMatches(EVENTS, EVENT_TOPICS.management_changes);
  assert.equal(mgmt[0].heading, "Board and management changes");
  const earnings = topicMatches(EVENTS, EVENT_TOPICS.earnings);
  assert.equal(earnings[0].heading, "Earnings and guidance");
});

test("search requires every word, honors quoted phrases, and ranks by hits", () => {
  const q = parseQuery('china "export controls"');
  assert.deepEqual(q.phrases, ["export controls"]);
  assert.deepEqual(q.terms, ["china"]);
  const passages = searchPassages("narrative.md", NARRATIVE, q);
  assert.equal(passages.length, 1);
  assert.match(passages[0].text, /New rules restrict/);
  const sections = searchSections("narrative.md", NARRATIVE, parseQuery("revenue rose"));
  assert.equal(sections.length, 2);
  assert.equal(searchPassages("narrative.md", NARRATIVE, parseQuery("revenue unicorn")).length, 0);
});

test("outline lists sections with their subsections", () => {
  const o = outline(NARRATIVE);
  const mdna = o.find((s) => s.section.startsWith("Management"));
  assert.deepEqual(mdna.subsections, ["Liquidity"]);
});

test("list items are separate passages", () => {
  assert.equal(splitPassages("- one\n- two\n  continued\n\npara").length, 3);
});

test("accession numbers are normalized and linked to their EDGAR index", () => {
  assert.equal(normalizeAccession("000104581026000075"), "0001045810-26-000075");
  assert.equal(normalizeAccession("0001045810-26-000075"), "0001045810-26-000075");
  assert.equal(normalizeAccession("12345"), null);
  assert.equal(
    edgarIndexUrl("0001045810", "0001045810-26-000075"),
    "https://www.sec.gov/Archives/edgar/data/1045810/000104581026000075/0001045810-26-000075-index.htm",
  );
});

test("the accession index reads form and filing date from the prose that cites it", () => {
  const idx = new AccessionIndex("0000000001");
  idx.addMarkdown(EVENTS, "events.md");
  const r = idx.find("0000000001-26-000010");
  assert.equal(r.form, "8-K");
  assert.equal(r.filed, "2026-08-01");
  assert.deepEqual(r.uses, ['events.md: "Earnings and guidance"']);
  assert.equal(passagesCiting(EVENTS, "0000000001-26-000009", "events.md").length, 1);
});

test("the accession index records which periods' figures came from a filing", () => {
  const idx = new AccessionIndex("1");
  idx.addFinancials({ quarterly: [{ label: "Q2 FY2026", source_accession: "0000000001-26-000020", source_form: "10-Q" }] }, "FY26Q2");
  const r = idx.find("0000000001-26-000020");
  assert.equal(r.form, "10-Q");
  assert.match(r.uses[0], /quarterly\[0\]\.source_accession \(Q2 FY2026\)/);
});
