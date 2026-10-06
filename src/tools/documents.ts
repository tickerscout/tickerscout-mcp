import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { jsonResult, textResult, type ToolResult } from "../respond.ts";
import { findSection, splitSections } from "../markdown.ts";
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

function render(matches: TopicMatch[]): string {
  return matches
    .map((m) => {
      if (m.matched === "section") return `## ${m.heading}\n\n${m.body}`;
      if (m.matched === "subsection") return `### ${m.heading}\n*(within "${m.parent}")*\n\n${m.body}`;
      return `*From "${m.parent}":*\n\n${m.body}`;
    })
    .join("\n\n");
}

async function topicTool(
  c: Company,
  file: "narrative" | "events",
  topic: Topic,
  record: string | undefined,
  alsoEvents?: Topic,
): Promise<ToolResult> {
  const tag = resolveRecordArg(c, record);
  const doc = await loadMarkdown(c, file, tag);
  const matches = topicMatches(doc.md, topic);
  let extra = "";
  if (alsoEvents) {
    const ev = await loadMarkdown(c, "events", tag);
    const evMatches = topicMatches(ev.md, alsoEvents, 8);
    if (evMatches.length) extra = `\n\n---\n\n# From the 8-K events digest\n\n${render(evMatches)}`;
  }
  if (!matches.length && !extra) {
    return jsonResult(
      {
        ticker: c.ticker,
        available: false,
        message: `${c.ticker}'s ${file}.md (record ${doc.tag}) has no section on ${topic.label.toLowerCase()}.`,
        sections: splitSections(doc.md).map((s) => s.heading),
      },
      doc.url,
    );
  }
  const header = `# ${c.company} (${c.ticker}) — ${topic.label}\n*Record ${doc.tag}. ${matches.length} match${matches.length === 1 ? "" : "es"} in ${file}.md.*`;
  return textResult(`${header}\n\n${render(matches)}${extra}`, doc.url);
}

const NARRATIVE_TOOLS: { tool: string; topic: string; title: string; description: string; withEvents?: string }[] = [
  {
    tool: "get_business_overview",
    topic: "business",
    title: "Business description",
    description:
      "What the company does, condensed from Item 1 (Business) of its latest annual report: products and " +
      "services, reportable segments, end markets, customers and concentration, competition, manufacturing " +
      "and supply chain, intellectual property, regulation, seasonality and human capital, as the company " +
      "describes them. States the 10-K and accession it was read from.",
  },
  {
    tool: "get_risk_factors",
    topic: "risk_factors",
    title: "Risk factors",
    description:
      "The company's risk factors, condensed from Item 1A of its annual report and updated from its latest " +
      "quarterly report, grouped by theme (demand, supply chain, competition, regulation, legal, financial, " +
      "macro, cybersecurity), with risks that are new, expanded or removed since the prior filing flagged. " +
      "Read from the filings, not from news.",
  },
  {
    tool: "get_annual_mdna",
    topic: "annual_mdna",
    title: "Management's discussion and analysis (fiscal year)",
    description:
      "Management's discussion and analysis for the latest fiscal year, condensed from Item 7 of the annual " +
      "report: what drove revenue and margins, segment performance, operating expenses, liquidity and " +
      "capital resources, cash flow, debt, capital returns, critical accounting estimates and outlook, in " +
      "management's own terms, with the figures it cites.",
  },
  {
    tool: "get_current_quarter",
    topic: "current_quarter",
    title: "Current quarter (quarterly MD&A)",
    description:
      "The latest quarter, condensed from the MD&A of the most recent quarterly report (10-Q, or 6-K for a " +
      "foreign issuer): results for the three months and year to date, what changed against the prior year, " +
      "segment trends, liquidity, capital returns, guidance and any new developments since the annual report.",
  },
  {
    tool: "get_subsequent_events",
    topic: "subsequent_events",
    title: "Subsequent events",
    description:
      "Material developments after the latest period end: what the company disclosed after the balance-sheet " +
      "date in its latest report and in current reports since (acquisitions, financings, dividends, " +
      "litigation outcomes, leadership changes), each dated and sourced by accession.",
  },
  {
    tool: "get_legal_proceedings",
    topic: "legal_proceedings",
    title: "Legal proceedings and regulatory matters",
    withEvents: "legal_and_regulatory",
    description:
      "Litigation, government investigations, antitrust and regulatory matters: every legal or regulatory " +
      "section, subsection or passage in the 10-K/10-Q narrative (Item 3 and the contingencies note, as " +
      "condensed), followed by any legal or regulatory items in the 8-K events digest. Each passage says " +
      "where in the document it came from.",
  },
];

const EVENT_TOOLS: { tool: string; topic: string; title: string; description: string }[] = [
  {
    tool: "get_earnings_releases",
    topic: "earnings",
    title: "Earnings releases and guidance",
    description:
      "Each quarterly earnings release over roughly the trailing five quarters, as furnished on Form 8-K: " +
      "reported revenue, margins and EPS (GAAP and non-GAAP as the company states them), segment highlights, " +
      "capital returns announced with results, and forward guidance, each dated and cited by accession.",
  },
  {
    tool: "get_management_changes",
    topic: "management_changes",
    title: "Board and management changes",
    description:
      "Executive and board changes reported on Form 8-K (Item 5.02 and related): appointments, departures, " +
      "retirements and successions of the CEO, CFO and other officers, directors elected or leaving, and " +
      "compensation arrangements disclosed with them, each dated and cited by accession.",
  },
  {
    tool: "get_capital_return_events",
    topic: "capital_returns",
    title: "Dividend and buyback announcements",
    description:
      "Dividend declarations and changes, share repurchase authorizations, accelerated share repurchases and " +
      "other capital-return actions announced in current reports, with amounts, dates and accessions. For the " +
      "cash actually paid, use get_dividends and get_share_repurchases.",
  },
  {
    tool: "get_debt_and_financing_events",
    topic: "debt_and_financing",
    title: "Debt offerings and financing",
    description:
      "Debt offerings, notes issued and their coupons and maturities, credit facilities and revolvers entered " +
      "or amended, term loans, commercial paper programs and other financing actions from current reports " +
      "(Items 1.01 and 2.03 and exhibits), each dated and cited by accession.",
  },
  {
    tool: "get_mergers_and_acquisitions",
    topic: "mergers_and_acquisitions",
    title: "Mergers, acquisitions and divestitures",
    description:
      "Acquisitions, mergers, divestitures and spin-offs announced, agreed or completed, as reported in current " +
      "reports and their exhibits: counterparties, consideration, financing and expected timing, each dated and " +
      "cited by accession.",
  },
  {
    tool: "get_governance_events",
    topic: "governance",
    title: "Governance and shareholder votes",
    description:
      "Annual meeting results and shareholder votes (Item 5.07), bylaw and charter amendments, and other " +
      "governance actions reported in current reports, each dated and cited by accession.",
  },
  {
    tool: "get_restructuring_events",
    topic: "restructuring",
    title: "Restructuring and impairments",
    description:
      "Restructuring plans, workforce reductions, exit costs and impairments announced in current reports " +
      "(Item 2.05 and related), with the charges and timing stated, each dated and cited by accession.",
  },
];

const DOCS = z
  .array(z.enum(["narrative", "events", "notes"]))
  .optional()
  .describe("Which documents to search: narrative (10-K/10-Q synthesis), events (8-K digest), notes (the financial record's sourcing notes and uncertainties). Default all three.");

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

const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December";
const DATE_RE = new RegExp(`\\b(?:${MONTHS})\\s+\\d{1,2},\\s+\\d{4}\\b`);

export function registerDocumentTools(server: McpServer) {
  for (const t of NARRATIVE_TOOLS) {
    server.registerTool(
      t.tool,
      {
        title: t.title,
        description:
          `${t.description} Returns the section's full text as markdown. Headings differ by company and ` +
          "carry the fiscal period, so the section is found by pattern; if this company's narrative has none, " +
          "the response says so and lists its sections. Pass `record` for the narrative as of an earlier record.",
        inputSchema: z.object({ ticker: TICKER, record: RECORD }),
        annotations: READ_ONLY,
      },
      async ({ ticker, record }) =>
        guard(async () => {
          const c = await resolveCompany(ticker);
          return topicTool(c, "narrative", NARRATIVE_TOPICS[t.topic], record, t.withEvents ? EVENT_TOPICS[t.withEvents] : undefined);
        }),
    );
  }

  server.registerTool(
    "get_narrative_outline",
    {
      title: "Outline of the narrative and events documents",
      description:
        "The full heading tree of a company's narrative (10-K/10-Q synthesis) and events (8-K digest): every " +
        "section with its size and first sentence, and every subsection under it. Use it to see what is " +
        "covered and pick exactly what to read with get_narrative, get_events or get_narrative_subsection.",
      inputSchema: z.object({ ticker: TICKER, record: RECORD }),
      annotations: READ_ONLY,
    },
    async ({ ticker, record }) =>
      guard(async () => {
        const c = await resolveCompany(ticker);
        const tag = resolveRecordArg(c, record);
        const [n, e] = await Promise.all([loadMarkdown(c, "narrative", tag), loadMarkdown(c, "events", tag)]);
        return jsonResult({ ticker: c.ticker, record: n.tag, narrative: outline(n.md), events: outline(e.md) }, n.url);
      }),
  );

  server.registerTool(
    "get_narrative_subsection",
    {
      title: "One subsection of the narrative",
      description:
        "One subsection of a company's narrative by its heading - for example 'Liquidity', 'Segments', " +
        "'Guidance', 'Competition', 'Critical accounting estimates', 'Credit' - matched case-insensitively on " +
        "the exact heading, then a unique prefix, then a unique substring, across every section. Smaller than " +
        "a whole section. get_narrative_outline lists every subsection heading.",
      inputSchema: z.object({
        ticker: TICKER,
        heading: z.string().describe("Subsection heading or a distinctive part of it."),
        record: RECORD,
      }),
      annotations: READ_ONLY,
    },
    async ({ ticker, heading, record }) =>
      guard(async () => {
        const c = await resolveCompany(ticker);
        const tag = resolveRecordArg(c, record);
        const doc = await loadMarkdown(c, "narrative", tag);
        const subs = splitSections(doc.md).flatMap((s) =>
          splitSubsections(s.body)
            .filter((x) => x.heading)
            .map((x) => ({ heading: x.heading as string, body: x.body, chars: x.body.length, firstSentence: "", parent: s.heading })),
        );
        const hit = findSection(subs, heading) as (typeof subs)[number] | null;
        if (!hit) {
          const h2 = findSection(splitSections(doc.md), heading);
          if (h2) return textResult(`## ${h2.heading}\n\n${h2.body}`, doc.url);
          throw new Error(
            `No subsection matching "${heading}" in ${c.ticker}'s narrative. Subsections: ` +
              `${subs.map((s) => `${s.heading} (in ${s.parent})`).join(" | ") || "none"}.`,
          );
        }
        return textResult(`### ${hit.heading}\n*(within "${hit.parent}")*\n\n${hit.body}`, doc.url);
      }),
  );

  server.registerTool(
    "list_events",
    {
      title: "Index of material events",
      description:
        "An index of every item in a company's 8-K events digest, grouped by its section: for each item, the " +
        "first date it states, every accession number it cites with the form, and its first sentence. Much " +
        "smaller than get_events; use it to scan what happened and when, then read an item in full with " +
        "get_events(section), a topic tool, or get_filing(accession).",
      inputSchema: z.object({ ticker: TICKER, record: RECORD }),
      annotations: READ_ONLY,
    },
    async ({ ticker, record }) =>
      guard(async () => {
        const c = await resolveCompany(ticker);
        const doc = await loadMarkdown(c, "events", resolveRecordArg(c, record));
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
        return jsonResult({ ticker: c.ticker, record: doc.tag, sections }, doc.url);
      }),
  );

  for (const t of EVENT_TOOLS) {
    server.registerTool(
      t.tool,
      {
        title: t.title,
        description:
          `${t.description} Returns matching sections of the events digest in full, then individual items from ` +
          "other sections that mention the topic, each labeled with where it came from. If there are none, the " +
          "response says so and lists the digest's sections. Pass `record` for the digest as of an earlier record.",
        inputSchema: z.object({ ticker: TICKER, record: RECORD }),
        annotations: READ_ONLY,
      },
      async ({ ticker, record }) =>
        guard(async () => {
          const c = await resolveCompany(ticker);
          return topicTool(c, "events", EVENT_TOPICS[t.topic], record);
        }),
    );
  }

  server.registerTool(
    "search_sections",
    {
      title: "Find which sections discuss a topic",
      description:
        "Keyword search over a company's filings synthesis that answers WHERE: every section and subsection of " +
        "the 10-K/10-Q narrative, the 8-K events digest and the financial record's sourcing notes that mentions " +
        "the query, ranked by how often, with a snippet and the section's size. All words must appear " +
        "(case-insensitive); put a phrase in double quotes to match it exactly, e.g. '\"export controls\" " +
        "China'. Then read a hit with get_narrative(section), get_narrative_subsection or search_text.",
      inputSchema: z.object({
        ticker: TICKER,
        query: z.string().describe("Words or \"quoted phrases\" to find."),
        documents: DOCS,
        record: RECORD,
      }),
      annotations: READ_ONLY,
    },
    async ({ ticker, query, documents, record }) =>
      guard(async () => {
        const c = await resolveCompany(ticker);
        const q = parseQuery(query);
        if (!q.terms.length && !q.phrases.length) throw new Error("The query has no searchable words.");
        const docs = await loadDocs(c, documents, record);
        const hits = docs.flatMap((d) => searchSections(d.name, d.md, q)).sort((a, b) => b.hits - a.hits);
        return jsonResult(
          {
            ticker: c.ticker,
            query,
            searched: docs.map((d) => d.name),
            matches: hits.length,
            sections: hits.slice(0, 30),
            ...(hits.length ? {} : { note: "No section mentions every word. Try fewer or broader words." }),
          },
          docs[0]?.url ?? "",
        );
      }),
  );

  server.registerTool(
    "search_text",
    {
      title: "Find the passages that say it",
      description:
        "Keyword search that answers WHAT IT SAYS: the individual paragraphs and list items in a company's " +
        "10-K/10-Q narrative, 8-K events digest and financial-record notes that contain every word of the " +
        "query, best first, each in full with its section and subsection. Case-insensitive; double quotes match " +
        "an exact phrase. Examples: 'buyback authorization', '\"remaining performance obligations\"', 'China " +
        "export', 'credit facility', 'goodwill impairment', 'CEO'.",
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
        const hits = docs.flatMap((d) => searchPassages(d.name, d.md, q)).sort((a, b) => b.score - a.score);
        return jsonResult(
          {
            ticker: c.ticker,
            query,
            searched: docs.map((d) => d.name),
            matches: hits.length,
            passages: hits.slice(0, limit ?? 12),
            ...(hits.length ? {} : { note: "No passage contains every word. Try fewer or broader words, or search_sections." }),
          },
          docs[0]?.url ?? "",
        );
      }),
  );
}
