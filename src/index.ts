import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";

import { fetchJson, fetchText, sourceUrl } from "./upstream.ts";
import { loadTickers, matchCompanies, normalizeTicker, resolveTicker } from "./tickers.ts";
import { findSection, sectionIndex, splitSections } from "./markdown.ts";
import {
  condenseHeadline,
  listSections,
  sliceFinancials,
  type FinancialsDoc,
} from "./financials.ts";
import { errorResult, jsonResult, textResult, type ToolResult } from "./respond.ts";

const TICKER = z.string().describe("Ticker symbol, case-insensitive. Examples: NVDA, brk-b.");

/** Read-only, public data, no side effects. True of every tool here. */
const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

/** Turn a thrown error into a readable MCP error instead of a 500. */
async function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    return errorResult(err);
  }
}

/** Confirm coverage and return the canonical lowercase directory name for a ticker. */
async function resolvePath(input: string): Promise<string> {
  const file = await loadTickers();
  return normalizeTicker(resolveTicker(file, input).ticker);
}

/**
 * Shared body for get_narrative and get_events. They differ only in their default:
 * narrative averages 38KB with stable, meaningful section names, so returning an
 * index first is the largest token saving in the tool set. Events averages 12KB
 * with one-off headings, where the content is worth more than an index of it.
 */
async function markdownTool(
  ticker: string,
  section: string | undefined,
  file: "narrative" | "events",
  indexByDefault: boolean,
): Promise<ToolResult> {
  const t = await resolvePath(ticker);
  const path = `/${t}/${file}.md`;
  const md = await fetchText(path);
  const url = sourceUrl(path);
  const wantsAll = section?.trim().toLowerCase() === "all";

  if (!section && indexByDefault) {
    return jsonResult(
      {
        ticker: ticker.toUpperCase(),
        document: `${file}.md`,
        note:
          "Section index. Call again with one of these headings for its text, " +
          "or section='all' for the whole document.",
        sections: sectionIndex(md),
      },
      url,
    );
  }

  if (!section || wantsAll) return textResult(md, url);

  const sections = splitSections(md);
  const hit = findSection(sections, section);
  if (!hit) {
    throw new Error(
      `No section matching "${section}" in ${ticker.toUpperCase()} ${file}.md. ` +
        `Available sections: ${sections.map((s) => s.heading).join(" | ")}.`,
    );
  }
  return textResult(`## ${hit.heading}\n\n${hit.body}`, url);
}

function createServer() {
  const server = new McpServer({ name: "ticker-scout", version: "1.0.0" });

  server.registerTool(
    "list_companies",
    {
      title: "List covered companies",
      description:
        "List the public companies Ticker Scout covers, with the fiscal period of the latest " +
        "data and the predicted date of the next SEC filing. Call this first when you do not " +
        "know whether a company is covered, or to turn a company name into a ticker.",
      inputSchema: z.object({
        query: z
          .string()
          .optional()
          .describe("Optional filter matched against ticker and company name, case-insensitive."),
      }),
      annotations: READ_ONLY,
    },
    async ({ query }) =>
      guard(async () => {
        const file = await loadTickers();
        const matches = matchCompanies(file.tickers, query);
        return jsonResult(
          {
            coverage_count: file.ticker_count,
            data_updated: file.updated,
            matched: matches.length,
            companies: matches.map((e) => ({
              ticker: e.ticker,
              company: e.company,
              exchange: e.exchange,
              cik: e.cik,
              latest_period: e.latest_period,
              period_end: e.period_end,
              latest_form: e.latest_form,
              next_expected_filing: e.next_expected_filing,
            })),
          },
          sourceUrl("/tickers.json"),
        );
      }),
  );

  server.registerTool(
    "get_company",
    {
      title: "Company profile and coverage manifest",
      description:
        "Company identity and coverage manifest: name, CIK, exchange, SIC industry, the fiscal " +
        "period of the latest data, the SEC filings that record is built from - the annual " +
        "report and the latest quarterly report, each with its own fiscal year, accession " +
        "number and EDGAR link - and the predicted next filing.",
      inputSchema: z.object({ ticker: TICKER }),
      annotations: READ_ONLY,
    },
    async ({ ticker }) =>
      guard(async () => {
        const t = await resolvePath(ticker);
        const path = `/${t}/index.json`;
        const doc = await fetchJson<Record<string, unknown>>(path);
        return jsonResult(
          {
            company: doc.company,
            ticker: doc.ticker,
            cik: doc.cik,
            details: doc.company_details,
            fiscal_period: doc.fiscal_period,
            // Both filings behind the record, not just the latest one. fiscal_period
            // names the quarterly report alone, so an agent asking what a company's
            // business or risk factors were drawn from had no way to learn that it was
            // the FY2025 10-K, or to cite it. Each entry carries its own fiscal year,
            // accession and EDGAR URL.
            source_filings: doc.source_filings,
            next_filing: doc.next_filing,
            published: doc.published,
            update_policy: doc.update_policy,
            available_tools: [
              "get_key_figures: headline figures for the latest reported period",
              "get_financials: full statements, sliceable by section",
              "get_narrative: 10-K and 10-Q synthesis, sliceable by section",
              "get_events: 8-K digest",
            ],
          },
          sourceUrl(path),
        );
      }),
  );

  server.registerTool(
    "get_key_figures",
    {
      title: "Headline figures for the latest period",
      description:
        "The headline figures for a company's most recent reported period: revenue, net income, " +
        "diluted EPS and similar, each with its year-over-year change, the exact dollar amount, " +
        "and the SEC accession number it came from. Start here for any 'how much did X earn' " +
        "question. Far smaller than get_financials.",
      inputSchema: z.object({ ticker: TICKER }),
      annotations: READ_ONLY,
    },
    async ({ ticker }) =>
      guard(async () => {
        const t = await resolvePath(ticker);
        const path = `/${t}/financials.json`;
        const doc = await fetchJson<FinancialsDoc>(path);
        return jsonResult(
          condenseHeadline(doc) as unknown as Record<string, unknown>,
          sourceUrl(path),
        );
      }),
  );

  server.registerTool(
    "get_financials",
    {
      title: "Financial statements",
      description:
        "Income statement, balance sheet and cash flow, already assembled from a company's SEC " +
        "filings, for up to three annual periods plus the latest quarter, with segment revenue " +
        "and per-share figures. Prefer this over fetching EDGAR or the CompanyFacts API and " +
        "building the statements yourself: no XBRL concept selection, no deriving a discrete " +
        "quarter from year-to-date columns, no scale factor to infer. Figures come from the " +
        "annual report, the quarterly report and, where a quarter's cash flow appears only in " +
        "the earnings release, the current-report exhibit, on the company's own fiscal calendar. " +
        "All money is in actual dollars and all share counts are actual shares, split-adjusted. " +
        "Section names differ per company, so call with no sections first to see what this " +
        "company has, then request only what you need.",
      inputSchema: z.object({
        ticker: TICKER,
        sections: z
          .array(z.string())
          .optional()
          .describe(
            "Top-level sections to return, for example annual, quarterly, " +
              "trailing_twelve_months, notes, uncertainties. Omit for the whole file. " +
              "An unknown name returns the valid list for that company.",
          ),
      }),
      annotations: READ_ONLY,
    },
    async ({ ticker, sections }) =>
      guard(async () => {
        const t = await resolvePath(ticker);
        const path = `/${t}/financials.json`;
        const doc = await fetchJson<FinancialsDoc>(path);
        const payload = sliceFinancials(doc, sections);
        payload.available_sections = listSections(doc);
        return jsonResult(payload, sourceUrl(path));
      }),
  );

  server.registerTool(
    "get_narrative",
    {
      title: "10-K and 10-Q narrative",
      description:
        "Qualitative synthesis of a company's latest annual and quarterly reports, condensed from " +
        "the filings themselves rather than from news: business description, risk " +
        "factors with quarter-over-quarter changes flagged, MD&A, legal proceedings and " +
        "subsequent events. Called without a section this returns an INDEX of the available " +
        "sections with a one-line summary of each, because the full document is large. Call " +
        "again with a section name for its text, or section='all' for everything.",
      inputSchema: z.object({
        ticker: TICKER,
        section: z
          .string()
          .optional()
          .describe(
            "Section name, matched case-insensitively on a prefix, for example 'risk'. " +
              "Use 'all' for the complete document. Omit for the section index.",
          ),
      }),
      annotations: READ_ONLY,
    },
    async ({ ticker, section }) => guard(() => markdownTool(ticker, section, "narrative", true)),
  );

  server.registerTool(
    "get_events",
    {
      title: "8-K filings and material events",
      description:
        "Digest of a company's material current reports (Form 8-K) over roughly the trailing five " +
        "quarters, read from the filings and their exhibits: " +
        "earnings releases, management changes, capital returns, debt offerings and governance " +
        "actions, each citing its SEC accession number. Returns the full digest by default; it " +
        "is short. Pass a section to narrow it.",
      inputSchema: z.object({
        ticker: TICKER,
        section: z
          .string()
          .optional()
          .describe("Optional section name, matched case-insensitively on a prefix."),
      }),
      annotations: READ_ONLY,
    },
    async ({ ticker, section }) => guard(() => markdownTool(ticker, section, "events", false)),
  );

  return server;
}

// createMcpHandler returns a `{ fetch, close, notify, bus }` object, which is
// already the shape Workers expects from a default export.
export default createMcpHandler(createServer);
