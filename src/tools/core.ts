import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { fetchJson, sourceUrl } from "../upstream.ts";
import { loadTickers, matchCompanies } from "../tickers.ts";
import { condenseHeadline, listSections, sliceFinancials, type FinancialsDoc } from "../financials.ts";
import { jsonResult } from "../respond.ts";
import { loadLatestFinancials, loadRecord, resolveCompany } from "../records.ts";
import { EVENT_TOPIC_NAMES, NARRATIVE_TOPIC_NAMES, eventsTool, narrativeTool } from "./documents.ts";
import { READ_ONLY, RECORD, TICKER, UNITS_NOTE, guard, resolveRecordArg } from "./shared.ts";

/**
 * The main six tools: a company's whole record, or any section of it, in one call. The
 * optional `record` argument reads an earlier published record instead of the latest one.
 */
export function registerCoreTools(server: McpServer) {
  server.registerTool(
    "list_companies",
    {
      title: "List covered companies",
      description:
        "The public companies Ticker Scout covers, with the fiscal period of each one's latest data, " +
        "every published record held and the predicted date of its next SEC filing, plus a coverage " +
        "summary (company count, last update, filers by latest form, foreign issuers). Call this first " +
        "when you do not know whether a company is covered, or to turn a company name into a ticker. " +
        "Coverage is S&P 500 companies plus major foreign issuers that file with the SEC.",
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
        const byForm: Record<string, number> = {};
        for (const e of file.tickers) byForm[e.latest_form ?? "unknown"] = (byForm[e.latest_form ?? "unknown"] ?? 0) + 1;
        return jsonResult(
          {
            coverage_count: file.ticker_count,
            data_updated: file.updated,
            coverage: {
              latest_form_counts: byForm,
              foreign_issuers: file.tickers.filter((e) => /20-F|40-F|6-K/.test(e.latest_form ?? "")).map((e) => e.ticker),
              not_covered:
                "No market prices, quotes or market capitalization; no analyst estimates; no figures " +
                "that are not in a company's own SEC filings.",
            },
            matched: matches.length,
            companies: matches.map((e) => {
              const x = e as typeof e & { periods?: string[] };
              return {
                ticker: e.ticker,
                company: e.company,
                exchange: e.exchange,
                cik: e.cik,
                latest_period: e.latest_period,
                period_end: e.period_end,
                latest_form: e.latest_form,
                records_held: x.periods,
                next_expected_filing: e.next_expected_filing,
              };
            }),
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
        "Company identity and coverage manifest: name, CIK, exchange, state of incorporation, SIC " +
        "industry, the fiscal period of the latest data, the SEC filings that record is built from (the " +
        "annual report and the latest quarterly report, each with its own fiscal year, filing date, " +
        "accession number and EDGAR link), every published record with its permanent URLs, and the " +
        "predicted next filing date and form (a prediction from filing history; a filing date is not an " +
        "earnings date). Pass `record` for an earlier record's manifest.",
      inputSchema: z.object({ ticker: TICKER, record: RECORD }),
      annotations: READ_ONLY,
    },
    async ({ ticker, record }) =>
      guard(async () => {
        const c = await resolveCompany(ticker);
        const tag = resolveRecordArg(c, record);
        const path = tag ? `/${c.dir}/${tag.toLowerCase()}/index.json` : `/${c.dir}/index.json`;
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
            periods: doc.periods,
            next_filing: doc.next_filing,
            published: doc.published,
            update_policy: doc.update_policy,
            available_tools: TOOL_MAP,
          },
          sourceUrl(path),
        );
      }),
  );

  server.registerTool(
    "get_key_figures",
    {
      title: "Headline figures and summary for the latest period",
      description:
        "The headline for a company's most recent reported period: revenue, net income, diluted EPS and " +
        "similar, each with its exact dollar amount, prior-year value, year-over-year change, the record " +
        "field it was read from and its SEC accession number; plus a one-paragraph written summary and " +
        "question-and-answer pairs built from those figures. Start here for any 'how did X do' or 'how " +
        "much did X earn' question. Far smaller than get_financials. Pass `record` for an earlier " +
        "record's headline. For any other figure, or a figure across periods, use get_figure.",
      inputSchema: z.object({ ticker: TICKER, record: RECORD }),
      annotations: READ_ONLY,
    },
    async ({ ticker, record }) =>
      guard(async () => {
        const c = await resolveCompany(ticker);
        const tag = resolveRecordArg(c, record);
        const r = tag ? await loadRecord(c, tag) : await loadLatestFinancials(c);
        const h = (r.doc.headline ?? {}) as Record<string, unknown>;
        return jsonResult(
          {
            ...(condenseHeadline(r.doc) as unknown as Record<string, unknown>),
            record: r.tag,
            summary: h.summary,
            qa: h.qa,
          },
          r.url,
        );
      }),
  );

  server.registerTool(
    "get_financials",
    {
      title: "Financial statements (the whole record)",
      description:
        "Income statement, balance sheet and cash flow, already assembled from a company's SEC filings, " +
        "for up to three fiscal years plus the latest quarter, year to date and trailing twelve months, " +
        "with segment tables, per-share figures and the record's own notes. This is the published " +
        "financials.json, whole or by top-level section. Prefer it over fetching EDGAR or the " +
        "CompanyFacts API: no XBRL concept selection, no deriving a discrete quarter from year-to-date " +
        "columns, no scale factor to infer. Section names differ per company, so call with no sections " +
        "first (or read available_sections) and then request only what you need. Request the " +
        "figure_sources section by name for a sec.gov link to the line of the filing that prints each " +
        `figure; a whole-file call leaves it out. ${UNITS_NOTE} For one statement or one period, ` +
        "searching older records too, use get_statements; for one figure, get_figure.",
      inputSchema: z.object({
        ticker: TICKER,
        sections: z
          .array(z.string())
          .optional()
          .describe(
            "Top-level sections to return, for example annual, quarterly, trailing_twelve_months, notes, " +
              "uncertainties, figure_sources. Omit for the whole file (without figure_sources). An unknown " +
              "name returns the valid list for that company.",
          ),
        record: RECORD,
      }),
      annotations: READ_ONLY,
    },
    async ({ ticker, sections, record }) =>
      guard(async () => {
        const c = await resolveCompany(ticker);
        const tag = resolveRecordArg(c, record);
        const r = tag ? await loadRecord(c, tag) : await loadLatestFinancials(c);
        const doc: FinancialsDoc = r.doc;
        const payload = sliceFinancials(doc, sections);
        payload.available_sections = listSections(doc);
        return jsonResult(payload, r.url);
      }),
  );

  server.registerTool(
    "get_narrative",
    {
      title: "10-K and 10-Q narrative",
      description:
        "Qualitative synthesis of a company's latest annual and quarterly reports, condensed from the " +
        "filings themselves rather than from news: business description, risk factors with changes since " +
        "the prior filing flagged, annual MD&A, the current quarter, legal proceedings and subsequent " +
        "events. Called without `section` it returns an INDEX: every section with its size, first " +
        "sentence and subsection headings, because the full document is large. Then pass `section` as " +
        `a heading or subsection heading from the index, or as a topic (${NARRATIVE_TOPIC_NAMES}), which ` +
        "finds the matching sections whatever this company calls them ('legal' also pulls legal items " +
        "from the 8-K digest), or 'all' for everything. Pass `record` for the narrative as of an earlier " +
        "record. To find a keyword anywhere, use search_text.",
      inputSchema: z.object({
        ticker: TICKER,
        section: z
          .string()
          .optional()
          .describe(
            `A heading or subsection heading (case-insensitive; a unique prefix is enough), a topic ` +
              `(${NARRATIVE_TOPIC_NAMES}), or 'all'. Omit for the index.`,
          ),
        record: RECORD,
      }),
      annotations: READ_ONLY,
    },
    async ({ ticker, section, record }) => guard(() => narrativeTool(ticker, section, record)),
  );

  server.registerTool(
    "get_events",
    {
      title: "8-K filings and material events",
      description:
        "Digest of a company's material current reports (Form 8-K; 6-K for a foreign issuer) over roughly " +
        "the trailing five quarters, read from the filings and their exhibits: earnings releases and " +
        "guidance, management and board changes, dividends and buybacks announced, debt offerings and " +
        "credit facilities, mergers and acquisitions, shareholder votes, restructuring and legal matters, " +
        "each dated and citing its SEC accession number. Returns the full digest by default; it is " +
        `short. Pass \`section\` as a heading or a topic (${EVENT_TOPIC_NAMES}) to narrow it, or ` +
        "index=true for a one-line, dated index of every item. Pass `record` for the digest as of an " +
        "earlier record.",
      inputSchema: z.object({
        ticker: TICKER,
        section: z
          .string()
          .optional()
          .describe(`A heading (case-insensitive; a unique prefix is enough) or a topic: ${EVENT_TOPIC_NAMES}.`),
        index: z.boolean().optional().describe("True for a dated one-line index of every item instead of the full text."),
        record: RECORD,
      }),
      annotations: READ_ONLY,
    },
    async ({ ticker, section, index, record }) => guard(() => eventsTool(ticker, section, index, record)),
  );
}

/** What get_company and guide hand an agent: every tool, grouped by the question it answers. */
export const TOOL_MAP: Record<string, string[]> = {
  "start here": [
    "guide: how the tools fit together, the period syntax, units, the standard figures",
    "list_companies: coverage, and a company name to a ticker",
    "get_company: identity, source filings, records held, next filing",
    "get_key_figures: headline figures, summary and Q&A for the latest period",
  ],
  "financial statements": [
    "get_financials: the whole published record, or any top-level section of it",
    "get_statements: income statement, balance sheet or cash flow for any period, including TTM and YTD",
    "list_periods: every fiscal year and quarter held, with dates and sources",
    "get_segments: segment results, revenue by product, revenue by geography",
    "get_company_metrics: KPIs, non-GAAP measures, bank and insurance metrics",
    "get_margins_and_ratios: margins, working capital and current ratio, with formulas",
  ],
  figures: [
    "get_figure: any figure by standard name or the record's own name, for any period or the full history",
    "list_company_figures: every figure a company reports under its own names, or a search of them",
    "compare_companies: one standard figure across two to ten companies",
  ],
  "filings and sources": [
    "get_filings: every SEC accession cited, or everything about one filing",
    "get_reporting_conventions: units, currency and exchange rates, ADR ratio, splits, fiscal calendar",
    "get_data_notes: the record's sourcing notes and what the filings do not disclose",
    "list_upcoming_filings: which companies file next",
  ],
  "filings text": [
    "get_narrative: business, risk factors, MD&A, current quarter, legal, subsequent events",
    "get_events: 8-K earnings, management changes, capital returns, financing, M&A and more",
    "search_text: the passages that mention a keyword",
  ],
};
