import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { fetchJson, sourceUrl } from "../upstream.ts";
import { loadTickers, matchCompanies } from "../tickers.ts";
import { findSection, sectionIndex, splitSections } from "../markdown.ts";
import { condenseHeadline, listSections, sliceFinancials, type FinancialsDoc } from "../financials.ts";
import { jsonResult, textResult, type ToolResult } from "../respond.ts";
import { loadLatestFinancials, loadMarkdown, loadRecord, resolveCompany } from "../records.ts";
import { READ_ONLY, RECORD, TICKER, guard, resolveRecordArg } from "./shared.ts";

/**
 * The main six tools: a company's whole record, or any section of it, in one call. The
 * optional `record` argument reads an earlier published record instead of the latest one.
 */

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
  record: string | undefined,
): Promise<ToolResult> {
  const c = await resolveCompany(ticker);
  const { md, url, tag } = await loadMarkdown(c, file, resolveRecordArg(c, record));
  const wantsAll = section?.trim().toLowerCase() === "all";

  if (!section && indexByDefault) {
    return jsonResult(
      {
        ticker: c.ticker,
        document: `${file}.md`,
        record: tag,
        note:
          "Section index. Call again with one of these headings for its text, " +
          "or section='all' for the whole document. The dedicated tools get_business_overview, " +
          "get_risk_factors, get_annual_mdna, get_current_quarter, get_subsequent_events and " +
          "get_legal_proceedings return one section each; search_text finds a passage by keyword.",
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
      `No section matching "${section}" in ${c.ticker} ${file}.md. ` +
        `Available sections: ${sections.map((s) => s.heading).join(" | ")}.`,
    );
  }
  return textResult(`## ${hit.heading}\n\n${hit.body}`, url);
}

export function registerCoreTools(server: McpServer) {
  server.registerTool(
    "list_companies",
    {
      title: "List covered companies",
      description:
        "List the public companies Ticker Scout covers, with the fiscal period of the latest " +
        "data, every published record held for each (its periods), and the predicted date of the " +
        "next SEC filing. Call this first when you do not know whether a company is covered, or " +
        "to turn a company name into a ticker. Coverage is S&P 500 companies plus major foreign " +
        "issuers that file with the SEC. For a site-wide summary (how many companies, forms, " +
        "foreign issuers, upcoming filings) use get_coverage_summary.",
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
        "industry, the fiscal period of the latest data, the SEC filings that record is built from - " +
        "the annual report and the latest quarterly report, each with its own fiscal year, accession " +
        "number and EDGAR link - every published record (period) with its permanent URLs, and the " +
        "predicted next filing. Pass `record` for an earlier record's manifest. The response ends " +
        "with a map of every other tool, grouped by what it answers.",
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
      title: "Headline figures for the latest period",
      description:
        "The headline figures for a company's most recent reported period: revenue, net income, " +
        "diluted EPS and similar, each with its year-over-year change, the exact dollar amount, " +
        "and the SEC accession number it came from. Start here for any 'how much did X earn' " +
        "question. Far smaller than get_financials. Pass `record` for an earlier record's headline. " +
        "For one figure across every period use the figure tools (get_revenue, get_net_income, " +
        "get_eps and the rest), and for the written summary and Q&A use get_headline_summary.",
      inputSchema: z.object({ ticker: TICKER, record: RECORD }),
      annotations: READ_ONLY,
    },
    async ({ ticker, record }) =>
      guard(async () => {
        const c = await resolveCompany(ticker);
        const tag = resolveRecordArg(c, record);
        const r = tag ? await loadRecord(c, tag) : await loadLatestFinancials(c);
        return jsonResult(condenseHeadline(r.doc) as unknown as Record<string, unknown>, r.url);
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
        "company has, then request only what you need. To trace a figure to its source, " +
        "request the figure_sources section: it mirrors the figures' paths, and each entry " +
        "joins with figure_sources.documents into a sec.gov link that opens the filing at the " +
        "line printing that number. It is never included unless requested by name. Pass `record` " +
        "for an earlier published record. Narrower tools: get_income_statement, get_balance_sheet, " +
        "get_cash_flow_statement, get_period (one fiscal year or quarter), and one tool per line item.",
      inputSchema: z.object({
        ticker: TICKER,
        sections: z
          .array(z.string())
          .optional()
          .describe(
            "Top-level sections to return, for example annual, quarterly, " +
              "trailing_twelve_months, notes, uncertainties, figure_sources. Omit for the " +
              "whole file, which leaves out figure_sources. " +
              "An unknown name returns the valid list for that company.",
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
        "Qualitative synthesis of a company's latest annual and quarterly reports, condensed from " +
        "the filings themselves rather than from news: business description, risk " +
        "factors with quarter-over-quarter changes flagged, MD&A, legal proceedings and " +
        "subsequent events. Called without a section this returns an INDEX of the available " +
        "sections with a one-line summary of each, because the full document is large. Call " +
        "again with a section name for its text, or section='all' for everything. Pass `record` " +
        "for the narrative as of an earlier published record.",
      inputSchema: z.object({
        ticker: TICKER,
        section: z
          .string()
          .optional()
          .describe(
            "Section name, matched case-insensitively on a prefix, for example 'risk'. " +
              "Use 'all' for the complete document. Omit for the section index.",
          ),
        record: RECORD,
      }),
      annotations: READ_ONLY,
    },
    async ({ ticker, section, record }) =>
      guard(() => markdownTool(ticker, section, "narrative", true, record)),
  );

  server.registerTool(
    "get_events",
    {
      title: "8-K filings and material events",
      description:
        "Digest of a company's material current reports (Form 8-K; 6-K for a foreign issuer) over " +
        "roughly the trailing five quarters, read from the filings and their exhibits: " +
        "earnings releases, management changes, capital returns, debt offerings and governance " +
        "actions, each citing its SEC accession number. Returns the full digest by default; it " +
        "is short. Pass a section to narrow it, or `record` for the digest as of an earlier " +
        "record. Topic tools (get_earnings_releases, get_management_changes, get_capital_return_events, " +
        "get_debt_and_financing_events, get_mergers_and_acquisitions, get_governance_events, " +
        "get_restructuring_events) pull one kind of event.",
      inputSchema: z.object({
        ticker: TICKER,
        section: z
          .string()
          .optional()
          .describe("Optional section name, matched case-insensitively on a prefix."),
        record: RECORD,
      }),
      annotations: READ_ONLY,
    },
    async ({ ticker, section, record }) =>
      guard(() => markdownTool(ticker, section, "events", false, record)),
  );
}

/** What get_company and guide hand an agent: every tool, grouped by the question it answers. */
export const TOOL_MAP: Record<string, string[]> = {
  "start here": [
    "guide: how the tools fit together, the period syntax, units",
    "list_companies, get_company, get_coverage_summary",
    "get_key_figures: headline figures for the latest period",
  ],
  "periods and history": [
    "list_periods: every fiscal year, quarter and published record held",
    "get_period: every statement for one fiscal year or quarter",
    "get_trailing_twelve_months, get_year_to_date",
    "get_figure_history: one figure across every period held",
  ],
  statements: [
    "get_financials (whole file, sliceable)",
    "get_income_statement, get_balance_sheet, get_cash_flow_statement",
    "get_segments, get_revenue_breakdown, get_geographic_revenue",
    "get_non_gaap_measures, get_operating_metrics, get_bank_metrics, get_insurance_metrics, get_margins",
  ],
  "one line item, every period": [
    "income: get_revenue, get_cost_of_revenue, get_gross_profit, get_research_and_development, get_sga_expense, get_operating_expenses, get_operating_income, get_interest_expense, get_pretax_income, get_income_tax, get_net_income, get_eps, get_share_count, get_depreciation_and_amortization, get_stock_based_compensation",
    "banks: get_net_interest_income, get_credit_loss_provision",
    "balance sheet: get_cash, get_total_assets, get_total_liabilities, get_debt, get_shareholders_equity, get_working_capital, get_goodwill_and_intangibles, get_inventories, get_accounts_receivable, get_accounts_payable, get_property_and_equipment",
    "cash flow: get_operating_cash_flow, get_capital_expenditures, get_free_cash_flow, get_investing_and_financing_cash_flow, get_dividends, get_share_repurchases, get_acquisitions",
    "equity: get_retained_earnings",
  ],
  "any figure": [
    "list_standard_figures, list_company_figures, find_figures, get_figure, compare_companies",
  ],
  "sources and filings": [
    "get_source_filings, get_accession_numbers, get_filing, get_figure_source",
  ],
  "units, currency and conventions": [
    "get_reporting_conventions, get_fiscal_calendar, get_currency_conversion, get_adr_details, get_stock_splits, get_data_notes, get_data_gaps, get_headline_summary",
  ],
  "filing schedule": ["get_next_filing, list_upcoming_filings"],
  "10-K and 10-Q narrative": [
    "get_narrative (index or any section), get_narrative_outline, get_narrative_subsection",
    "get_business_overview, get_risk_factors, get_annual_mdna, get_current_quarter, get_subsequent_events, get_legal_proceedings",
  ],
  "8-K events": [
    "get_events (whole digest), list_events",
    "get_earnings_releases, get_management_changes, get_capital_return_events, get_debt_and_financing_events, get_mergers_and_acquisitions, get_governance_events, get_restructuring_events",
  ],
  search: ["search_sections: which sections discuss a keyword", "search_text: the passages that say it"],
};
