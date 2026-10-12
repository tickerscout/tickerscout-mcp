import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { jsonResult, textResult, type ToolResult } from "../respond.ts";
import { findSection, splitSections, type Section } from "../markdown.ts";
import { loadLatestFinancials, loadMarkdown, loadRecord, resolveCompany, type Company } from "../records.ts";
import { ACCESSION_RE } from "../filings.ts";
import {
  EVENT_TOPICS,
  NARRATIVE_TOPICS,
  outline,
  parseQuery,
  searchPassages,
  searchSections,
  splitPassages,
  splitSubsections,
  topicMatches,
  type Topic,
  type TopicMatch,
} from "../topics.ts";
import { READ_ONLY, RECORD, TICKER, guard, resolveRecordArg } from "./shared.ts";

/**
 * Reading the narrative and events documents by section or by topic, and keyword search
 * across them. get_narrative and get_events (core.ts) take one `section` argument that
 * accepts a heading, a subsection heading or a topic name; this module resolves it.
 */

/** What a caller may type for each topic. Matched whole, after normalizing, never as a substring. */
const NARRATIVE_ALIASES: Record<string, string[]> = {
  business: ["business", "business overview", "business description", "overview", "item 1"],
  risk_factors: ["risk", "risks", "risk factor", "risk factors", "item 1a"],
  annual_mdna: [
    "mda", "md&a", "mdna", "annual mda", "annual md&a", "annual mdna", "item 7",
    "management discussion", "managements discussion", "management discussion and analysis",
    "managements discussion and analysis",
  ],
  current_quarter: [
    "current quarter", "latest quarter", "quarter", "quarterly", "quarterly mda", "quarterly md&a",
    "quarterly report", "10q", "10 q", "interim",
  ],
  subsequent_events: ["subsequent", "subsequent events", "recent developments"],
  legal_proceedings: [
    "legal", "legal proceedings", "litigation", "lawsuits", "item 3", "legal and regulatory",
  ],
};

const EVENT_ALIASES: Record<string, string[]> = {
  earnings: ["earnings", "earnings release", "earnings releases", "results", "guidance"],
  management_changes: [
    "management", "management changes", "leadership", "executives", "executive changes", "board",
    "board changes", "item 5.02",
  ],
  capital_returns: [
    "capital returns", "capital return", "dividend", "dividends", "buyback", "buybacks", "repurchases",
    "share repurchases",
  ],
  debt_and_financing: ["debt", "financing", "debt and financing", "notes offering", "credit facility", "borrowing"],
  mergers_and_acquisitions: [
    "m&a", "mergers", "acquisitions", "mergers and acquisitions", "divestitures", "acquisition",
  ],
  governance: ["governance", "annual meeting", "shareholder votes", "votes", "bylaws", "item 5.07"],
  restructuring: ["restructuring", "layoffs", "impairments", "workforce", "item 2.05"],
  legal_and_regulatory: ["legal", "litigation", "regulatory", "legal and regulatory"],
};

export const NARRATIVE_TOPIC_NAMES = "business, risk factors, md&a, current quarter, subsequent events, legal";
export const EVENT_TOPIC_NAMES =
  "earnings, management changes, capital returns, debt and financing, m&a, governance, restructuring, legal";

function normAlias(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9&.]+/g, " ")
    .trim();
}

function topicFor(query: string, aliases: Record<string, string[]>): string | null {
  const q = normAlias(query);
  for (const [id, words] of Object.entries(aliases)) if (words.some((w) => normAlias(w) === q)) return id;
  return null;
}

function render(matches: TopicMatch[]): string {
  return matches
    .map((m) => {
      if (m.matched === "section") return `## ${m.heading}\n\n${m.body}`;
      if (m.matched === "subsection") return `### ${m.heading}\n*(within "${m.parent}")*\n\n${m.body}`;
      return `*From "${m.parent}":*\n\n${m.body}`;
    })
    .join("\n\n");
}

function topicText(
  c: Company,
  file: string,
  tag: string,
  topic: Topic,
  matches: TopicMatch[],
  extra = "",
): string {
  const header =
    `# ${c.company} (${c.ticker}) — ${topic.label}\n` +
    `*Record ${tag}. ${matches.length} match${matches.length === 1 ? "" : "es"} in ${file}.*`;
  return `${header}\n\n${render(matches)}${extra}`;
}

interface Subsection extends Section {
  parent: string;
}

function subsectionsOf(md: string): Subsection[] {
  return splitSections(md).flatMap((s) =>
    splitSubsections(s.body)
      .filter((x) => x.heading)
      .map((x) => ({ heading: x.heading as string, body: x.body, chars: x.body.length, firstSentence: "", parent: s.heading })),
  );
}

/**
 * The narrative index, or one part of it. `section` is tried as: 'all'; a topic name
 * (business, risk factors, md&a, current quarter, subsequent events, legal), matched by
 * heading pattern because headings differ per company; a section heading (exact, then unique
 * prefix, then unique substring); a subsection heading the same way.
 */
export async function narrativeTool(ticker: string, section: string | undefined, record: string | undefined): Promise<ToolResult> {
  const c = await resolveCompany(ticker);
  const tag = resolveRecordArg(c, record);
  const doc = await loadMarkdown(c, "narrative", tag);

  if (!section?.trim()) {
    return jsonResult(
      {
        ticker: c.ticker,
        document: "narrative.md",
        record: doc.tag,
        note:
          "Section index. Call again with `section` set to a heading or subsection heading below, " +
          `or to a topic (${NARRATIVE_TOPIC_NAMES}), or to 'all' for the whole document.`,
        // Same keys as the 2.0 index (heading, chars, first_sentence), plus each section's subsections.
        sections: outline(doc.md).map((o) => ({ heading: o.section, chars: o.chars, first_sentence: o.first_sentence, subsections: o.subsections })),
      },
      doc.url,
    );
  }
  if (section.trim().toLowerCase() === "all") return textResult(doc.md, doc.url);

  const topicId = topicFor(section, NARRATIVE_ALIASES);
  if (topicId) {
    const topic = NARRATIVE_TOPICS[topicId];
    const matches = topicMatches(doc.md, topic);
    let extra = "";
    if (topicId === "legal_proceedings") {
      const ev = await loadMarkdown(c, "events", tag);
      const evMatches = topicMatches(ev.md, EVENT_TOPICS.legal_and_regulatory, 8);
      if (evMatches.length) extra = `\n\n---\n\n# From the 8-K events digest\n\n${render(evMatches)}`;
    }
    if (matches.length || extra) return textResult(topicText(c, "narrative.md", doc.tag, topic, matches, extra), doc.url);
  }

  const sections = splitSections(doc.md);
  const hit = findSection(sections, section);
  if (hit) return textResult(`## ${hit.heading}\n\n${hit.body}`, doc.url);

  const sub = findSection(subsectionsOf(doc.md), section) as Subsection | null;
  if (sub) return textResult(`### ${sub.heading}\n*(within "${sub.parent}")*\n\n${sub.body}`, doc.url);

  if (topicId) {
    // A topic this company's narrative does not cover is an answer, not a failure.
    return jsonResult(
      {
        ticker: c.ticker,
        available: false,
        message: `${c.ticker}'s narrative.md (record ${doc.tag}) has no section on ${NARRATIVE_TOPICS[topicId].label.toLowerCase()}.`,
        sections: sections.map((s) => s.heading),
      },
      doc.url,
    );
  }
  throw new Error(
    `No section matching "${section}" in ${c.ticker} narrative.md. ` +
      `Available sections: ${sections.map((s) => s.heading).join(" | ")}. ` +
      `Topics: ${NARRATIVE_TOPIC_NAMES}. Call with no section for the full index with subsections.`,
  );
}

const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December";
const DATE_RE = new RegExp(`\\b(?:${MONTHS})\\s+\\d{1,2},\\s+\\d{4}\\b`);

/**
 * The events digest in full (the default: it is short), a dated index of its items, or one
 * part of it: a topic (earnings, management changes, capital returns, debt and financing,
 * m&a, governance, restructuring, legal) or a section heading.
 */
export async function eventsTool(
  ticker: string,
  section: string | undefined,
  index: boolean | undefined,
  record: string | undefined,
): Promise<ToolResult> {
  const c = await resolveCompany(ticker);
  const doc = await loadMarkdown(c, "events", resolveRecordArg(c, record));

  if (index) {
    const sections = splitSections(doc.md).map((s) => ({
      section: s.heading,
      items: splitPassages(s.body)
        .filter((p) => !p.startsWith("|"))
        .map((p) => {
          const flat = p.replace(/^\s*[-*+]\s+/, "").replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
          const first = /^(.{20,}?[.!?])(\s|$)/.exec(flat)?.[1] ?? flat;
          return {
            date: DATE_RE.exec(flat)?.[0] ?? null,
            accessions: [...new Set([...flat.matchAll(ACCESSION_RE)].map((m) => m[1]))],
            summary: first.length > 320 ? `${first.slice(0, 317)}...` : first,
          };
        }),
    }));
    return jsonResult(
      {
        ticker: c.ticker,
        record: doc.tag,
        note: `Item index. Read in full with get_events(section) using a heading or topic (${EVENT_TOPIC_NAMES}), or look up an accession with get_filings.`,
        sections,
      },
      doc.url,
    );
  }

  if (!section?.trim() || section.trim().toLowerCase() === "all") return textResult(doc.md, doc.url);

  const topicId = topicFor(section, EVENT_ALIASES);
  if (topicId) {
    const topic = EVENT_TOPICS[topicId];
    const matches = topicMatches(doc.md, topic);
    if (matches.length) return textResult(topicText(c, "events.md", doc.tag, topic, matches), doc.url);
  }

  const sections = splitSections(doc.md);
  const hit = findSection(sections, section);
  if (hit) return textResult(`## ${hit.heading}\n\n${hit.body}`, doc.url);
  if (topicId) {
    return jsonResult(
      {
        ticker: c.ticker,
        available: false,
        message: `${c.ticker}'s events.md (record ${doc.tag}) has nothing on ${EVENT_TOPICS[topicId].label.toLowerCase()}.`,
        sections: sections.map((s) => s.heading),
      },
      doc.url,
    );
  }
  throw new Error(
    `No section matching "${section}" in ${c.ticker} events.md. ` +
      `Available sections: ${sections.map((s) => s.heading).join(" | ")}. Topics: ${EVENT_TOPIC_NAMES}.`,
  );
}

const DOCS = z
  .array(z.enum(["narrative", "events", "notes"]))
  .optional()
  .describe(
    "Which documents to search: narrative (10-K/10-Q synthesis), events (8-K digest), notes (the " +
      "financial record's sourcing notes and uncertainties). Default all three.",
  );

async function loadDocs(c: Company, docs: string[] | undefined, record: string | undefined) {
  const tag = resolveRecordArg(c, record);
  const want = new Set(docs?.length ? docs : ["narrative", "events", "notes"]);
  const out: { name: string; md: string; url: string }[] = [];
  if (want.has("narrative")) {
    const d = await loadMarkdown(c, "narrative", tag);
    out.push({ name: "narrative.md", md: d.md, url: d.url });
  }
  if (want.has("events")) {
    const d = await loadMarkdown(c, "events", tag);
    out.push({ name: "events.md", md: d.md, url: d.url });
  }
  if (want.has("notes")) {
    const r = tag ? await loadRecord(c, tag) : await loadLatestFinancials(c);
    const list = (k: string) => (Array.isArray(r.doc[k]) ? (r.doc[k] as unknown[]).map((x) => `- ${String(x)}`).join("\n") : "");
    out.push({ name: "financials.json notes", md: `## Notes\n\n${list("notes")}\n\n## Uncertainties\n\n${list("uncertainties")}\n`, url: r.url });
  }
  return out;
}

export function registerDocumentTools(server: McpServer) {
  server.registerTool(
    "search_text",
    {
      title: "Keyword search across the filings synthesis",
      description:
        "Find what a company's filings say about a keyword. Searches the 10-K/10-Q narrative, the 8-K " +
        "events digest and the financial record's sourcing notes, and returns the paragraphs and list " +
        "items that contain every word of the query, best first, each in full with its section and " +
        "subsection, plus a ranked list of the sections that mention it most (to read one whole with " +
        "get_narrative or get_events). Case-insensitive; double quotes match an exact phrase. Examples: " +
        "'buyback authorization', '\"remaining performance obligations\"', 'China export', 'credit " +
        "facility', 'goodwill impairment', 'CEO'.",
      inputSchema: z.object({
        ticker: TICKER,
        query: z.string().describe("Words or \"quoted phrases\" to find."),
        documents: DOCS,
        limit: z.number().int().min(1).max(40).optional().describe("Most passages to return. Default 12."),
        record: RECORD,
      }),
      annotations: READ_ONLY,
    },
    async ({ ticker, query, documents, limit, record }) =>
      guard(async () => {
        const c = await resolveCompany(ticker);
        const q = parseQuery(query);
        if (!q.terms.length && !q.phrases.length) throw new Error("The query has no searchable words.");
        const docs = await loadDocs(c, documents, record);
        const passages = docs.flatMap((d) => searchPassages(d.name, d.md, q)).sort((a, b) => b.score - a.score);
        const sections = docs.flatMap((d) => searchSections(d.name, d.md, q)).sort((a, b) => b.hits - a.hits);
        return jsonResult(
          {
            ticker: c.ticker,
            query,
            searched: docs.map((d) => d.name),
            matches: passages.length,
            passages: passages.slice(0, limit ?? 12),
            // Where the topic is discussed most, compactly: read one whole with get_narrative
            // or get_events(section).
            sections_ranked: sections.slice(0, 15).map((s) => ({
              document: s.document,
              section: s.section,
              subsection: s.subsection,
              hits: s.hits,
              chars: s.chars,
            })),
            ...(passages.length ? {} : { note: "No passage contains every word. Try fewer or broader words." }),
          },
          docs[0]?.url ?? "",
        );
      }),
  );
}
