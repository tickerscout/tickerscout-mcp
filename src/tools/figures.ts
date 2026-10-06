import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { jsonResult } from "../respond.ts";
import { sourceUrl } from "../upstream.ts";
import { loadTickers } from "../tickers.ts";
import type { FinancialsDoc } from "../financials.ts";
import { periodHeader, periodPath, PERIOD_SYNTAX, PeriodNotAvailable, type Period } from "../periods.ts";
import { companyFrom, resolveCompany, selectForCompany, type PeriodSelection } from "../records.ts";
import {
  FIGURES,
  currencyPrefix,
  display,
  figureById,
  figureLink,
  figureRows,
  findStandardFigure,
  flattenPeriod,
  headlineField,
  nameOf,
  normName,
  readPath,
  resolveFigure,
  type FigureDef,
} from "../figures.ts";
import { PERIOD, READ_ONLY, SOURCE_NOTE, TICKER, UNITS_NOTE, UNITS_SHORT, guard, unitsHeader } from "./shared.ts";

/** One tool per line item an investor asks about by name. */
export const FIGURE_TOOLS: { tool: string; title: string; figures: string[]; lead: string }[] = [
  { tool: "get_revenue", title: "Revenue", figures: ["revenue"], lead: "Revenue (net sales, total revenues, or a bank's total net revenue) for a company, by period." },
  { tool: "get_cost_of_revenue", title: "Cost of revenue", figures: ["cost_of_revenue"], lead: "Cost of revenue, cost of sales or cost of goods sold, by period." },
  { tool: "get_gross_profit", title: "Gross profit and gross margin", figures: ["gross_profit", "gross_margin_pct"], lead: "Gross profit and, where the record stores it, gross margin percentage, by period." },
  { tool: "get_research_and_development", title: "Research and development", figures: ["research_and_development"], lead: "Research and development expense, by period." },
  { tool: "get_sga_expense", title: "Selling, general and administrative", figures: ["sga"], lead: "Selling, general and administrative expense (SG&A), by period." },
  { tool: "get_operating_expenses", title: "Operating expenses", figures: ["operating_expenses"], lead: "Total operating expenses (total costs and expenses, or a bank's noninterest expense), by period." },
  { tool: "get_operating_income", title: "Operating income", figures: ["operating_income"], lead: "Operating income (operating profit, income from operations), by period." },
  { tool: "get_interest_expense", title: "Interest expense", figures: ["interest_expense"], lead: "Interest expense, by period, with interest income alongside where the record carries it." },
  { tool: "get_pretax_income", title: "Pretax income", figures: ["pretax_income"], lead: "Income before income taxes, by period." },
  { tool: "get_income_tax", title: "Income tax and effective tax rate", figures: ["income_tax", "effective_tax_rate"], lead: "Income tax expense (provision for income taxes) and, where stored, the effective tax rate, by period." },
  { tool: "get_net_income", title: "Net income", figures: ["net_income"], lead: "Net income (net earnings, or net income attributable to the company), by period." },
  { tool: "get_eps", title: "Earnings per share", figures: ["diluted_eps", "basic_eps"], lead: "Diluted and basic earnings per share, by period." },
  { tool: "get_share_count", title: "Share count", figures: ["diluted_shares", "basic_shares", "shares_outstanding"], lead: "Weighted-average diluted and basic shares, and shares outstanding at period end, by period." },
  { tool: "get_depreciation_and_amortization", title: "Depreciation and amortization", figures: ["depreciation_and_amortization"], lead: "Depreciation and amortization, by period." },
  { tool: "get_stock_based_compensation", title: "Stock-based compensation", figures: ["stock_based_compensation"], lead: "Stock-based (share-based) compensation expense, by period." },
  { tool: "get_net_interest_income", title: "Net interest income", figures: ["net_interest_income", "noninterest_income"], lead: "For banks and lenders: net interest income and noninterest income, by period." },
  { tool: "get_credit_loss_provision", title: "Provision for credit losses", figures: ["provision_for_credit_losses"], lead: "For banks and lenders: provision for credit losses, by period." },
  { tool: "get_cash", title: "Cash and investments", figures: ["cash"], lead: "Cash and cash equivalents at each period end, with marketable securities and short-term investments alongside." },
  { tool: "get_total_assets", title: "Total assets", figures: ["total_assets"], lead: "Total assets at each period end." },
  { tool: "get_total_liabilities", title: "Total liabilities", figures: ["total_liabilities"], lead: "Total liabilities at each period end." },
  { tool: "get_debt", title: "Debt", figures: ["total_debt", "long_term_debt", "short_term_debt"], lead: "Total debt, long-term debt, and short-term debt with the current portion of long-term debt, at each period end." },
  { tool: "get_shareholders_equity", title: "Shareholders' equity", figures: ["shareholders_equity"], lead: "Shareholders' equity (book value) at each period end, with total equity including noncontrolling interests alongside." },
  { tool: "get_working_capital", title: "Working capital", figures: ["current_assets", "current_liabilities"], lead: "Total current assets and total current liabilities at each period end, with working capital (current assets less current liabilities) calculated from them and labeled as calculated." },
  { tool: "get_goodwill_and_intangibles", title: "Goodwill and intangibles", figures: ["goodwill", "intangible_assets"], lead: "Goodwill and intangible assets at each period end." },
  { tool: "get_inventories", title: "Inventories", figures: ["inventories"], lead: "Inventories at each period end." },
  { tool: "get_accounts_receivable", title: "Accounts receivable", figures: ["accounts_receivable"], lead: "Accounts receivable at each period end." },
  { tool: "get_accounts_payable", title: "Accounts payable", figures: ["accounts_payable"], lead: "Accounts payable at each period end." },
  { tool: "get_property_and_equipment", title: "Property, plant and equipment", figures: ["property_and_equipment"], lead: "Property, plant and equipment, net, at each period end." },
  { tool: "get_operating_cash_flow", title: "Operating cash flow", figures: ["operating_cash_flow"], lead: "Net cash provided by operating activities, by period." },
  { tool: "get_capital_expenditures", title: "Capital expenditures", figures: ["capital_expenditures"], lead: "Capital expenditures (purchases of property and equipment), by period." },
  { tool: "get_free_cash_flow", title: "Free cash flow", figures: ["free_cash_flow"], lead: "Free cash flow, by period." },
  { tool: "get_investing_and_financing_cash_flow", title: "Investing and financing cash flow", figures: ["investing_cash_flow", "financing_cash_flow"], lead: "Net cash from investing activities and net cash from financing activities, by period." },
  { tool: "get_dividends", title: "Dividends", figures: ["dividends_paid", "dividends_per_share"], lead: "Cash dividends paid and dividends per share, by period." },
  { tool: "get_share_repurchases", title: "Share repurchases", figures: ["share_repurchases"], lead: "Cash spent on share repurchases (buybacks), by period." },
  { tool: "get_acquisitions", title: "Acquisitions", figures: ["acquisitions"], lead: "Cash paid for acquisitions, net of cash acquired, by period." },
  { tool: "get_retained_earnings", title: "Retained earnings", figures: ["retained_earnings"], lead: "Retained earnings (or accumulated deficit) at each period end." },
];

const KIND_WORDS: Record<string, string> = {
  money: "dollars",
  per_share: "dollars per share",
  shares: "shares",
  percent: "percent",
};

function figureToolDescription(t: (typeof FIGURE_TOOLS)[number]): string {
  const defs = t.figures.map((id) => figureById(id)!);
  const what = defs.map((d) => `${d.label} (${KIND_WORDS[d.kind]}): ${d.definition}`).join(" ");
  const names = defs
    .map((d) => {
      const shown = d.aliases.slice(0, 12).join(", ");
      const more = d.aliases.length > 12 ? `, and ${d.aliases.length - 12} more` : "";
      return `${d.label} is read from ${shown}${more}`;
    })
    .join("; ");
  const caveats = defs.map((d) => d.caveat).filter(Boolean).join(" ");
  return (
    `${t.lead} ${what} ` +
    "Default: every period in the latest record (up to three fiscal years, the latest quarter and its " +
    "prior-year comparative, year to date, trailing twelve months); `period` narrows to one fiscal year or " +
    "quarter, searching older records, and period='all' returns the full history. Each value carries its " +
    "exact amount, the field it was read from, its dates, accession and form, and a sec.gov link to the line " +
    `printing it. Field names differ by company: ${names}. The company's own headline field is tried first, ` +
    "then these names in order; nothing is estimated or summed. Look-alike fields come back under `related`; " +
    "if none match, the response says so and lists similar fields. " +
    `${UNITS_SHORT}${caveats ? ` ${caveats}` : ""}`
  );
}

function docsOf(sel: PeriodSelection): Map<string, FinancialsDoc> {
  return new Map(sel.records.map((r) => [r.tag, r.doc]));
}

function figureBlock(sel: PeriodSelection, def: FigureDef) {
  const { values, missing } = figureRows(sel.primary.doc, sel.periods, def, docsOf(sel));
  const names = [...new Set(values.map((v) => v.name_in_record as string))];
  return {
    standard_figure: def.id,
    // What this company's record actually calls it. Pass any of these names to
    // get_figure or get_figure_history to ask for exactly that field.
    reported_as: names,
    definition: def.definition,
    values,
    ...(missing.length ? { not_reported_in: missing } : {}),
    ...(def.caveat ? { caveat: def.caveat } : {}),
  };
}

function envelope(c: { ticker: string; company: string }, sel: PeriodSelection, period: string | undefined) {
  return {
    ticker: c.ticker,
    company: c.company,
    ...unitsHeader(sel.primary.doc),
    requested_period: period ?? "every period in the latest record",
    records_read: sel.records.map((r) => r.tag),
  };
}

/** "annual[0].income_statement.revenue" and "income_statement.revenue" name the same field. */
function stripPeriodPrefix(q: string): string {
  return q.replace(/^(annual|quarterly|year_to_date|prior_year_to_date|trailing_twelve_months)(\[\d+\])?\./, "");
}

/**
 * Fields in the record that a request names exactly: a path ("income_statement.total_net_sales",
 * "revenue_by_market_platform.Data Center"), or a field's own name ("total_net_sales",
 * "Data Center"), compared without case or punctuation. Exact names win over the standard
 * figure list, so asking for the name a company uses returns that field and nothing else.
 */
function exactFields(periods: Period[], query: string): { mode: string; paths: string[] } {
  const q = stripPeriodPrefix(query.trim());
  if (periods.some((p) => readPath(p, q) !== null)) return { mode: "exact path in the record", paths: [q] };
  const all = [...new Set(periods.flatMap((p) => flattenPeriod(p).map((f) => f.path)))];
  const nq = normName(q);
  const byPath = all.filter((path) => normName(path) === nq);
  if (byPath.length) return { mode: "exact path in the record", paths: byPath };
  const byName = all.filter((path) => normName(nameOf(path)) === nq);
  return { mode: "exact name in the record", paths: byName };
}

/** Fields whose path contains every word of the query. */
function fieldsWithWords(periods: Period[], query: string): string[] {
  const all = [...new Set(periods.flatMap((p) => flattenPeriod(p).map((f) => f.path)))];
  const tokens = normName(query).split("_").filter((t) => t.length > 1);
  if (!tokens.length) return [];
  return all.filter((path) => {
    const lp = normName(path);
    return tokens.every((t) => lp.includes(t));
  });
}

function pathRows(sel: PeriodSelection, path: string): Record<string, unknown>[] {
  const docs = docsOf(sel);
  const rows: Record<string, unknown>[] = [];
  for (const p of sel.periods) {
    const v = readPath(p, path);
    if (v === null) continue;
    const d = docs.get(p.record) ?? sel.primary.doc;
    const h = periodHeader(p);
    rows.push({
      name_in_record: nameOf(path),
      field: path,
      json_path: `${periodPath(p)}.${path}`,
      period: p.name,
      kind: p.kind,
      period_start: p.period_start,
      period_end: p.period_end,
      value: v,
      source_accession: h.source_accession ?? null,
      sec_link: figureLink(d, p, path) ?? "none: calculated in the record, or from an untagged earnings release",
      ...(sel.records.length > 1 ? { record: p.record } : {}),
    });
  }
  return rows;
}

function fieldBlocks(sel: PeriodSelection, paths: string[]) {
  return paths.map((path) => ({ name_in_record: nameOf(path), field: path, values: pathRows(sel, path) }));
}

/**
 * Resolve any figure request: an exact path or name from the record first, then a standard
 * figure by its name or synonym, then fields containing the words.
 */
function answerFigure(sel: PeriodSelection, figure: string): Record<string, unknown> {
  const exact = exactFields(sel.periods, figure);
  if (exact.paths.length) return { matched_as: exact.mode, figures: fieldBlocks(sel, exact.paths) };
  const std = findStandardFigure(figure);
  if (std) return { matched_as: "standard figure", ...figureBlock(sel, std) };
  const paths = fieldsWithWords(sel.periods, figure);
  if (!paths.length) {
    const all = [...new Set(sel.periods.flatMap((p) => flattenPeriod(p).map((f) => f.path)))];
    const words = normName(figure).split("_").filter((w) => w.length > 2);
    const near = all.filter((p) => words.some((w) => normName(p).includes(w))).slice(0, 25);
    throw new Error(
      `No figure matching "${figure}" in this company's record. ` +
        (near.length ? `Fields containing some of those words: ${near.join(", ")}. ` : "") +
        "list_company_figures lists every field this company reports, by the name its record uses; " +
        "list_standard_figures shows the figures every company is searched for.",
    );
  }
  const capped = paths.slice(0, 15);
  return {
    matched_as: "words in field names",
    ...(paths.length > capped.length ? { note: `${paths.length} fields matched; the first 15 are shown. Narrow the query or use an exact name.` } : {}),
    figures: fieldBlocks(sel, capped),
  };
}

export function registerFigureTools(server: McpServer) {
  for (const t of FIGURE_TOOLS) {
    server.registerTool(
      t.tool,
      {
        title: t.title,
        description: figureToolDescription(t),
        inputSchema: z.object({ ticker: TICKER, period: PERIOD }),
        annotations: READ_ONLY,
      },
      async ({ ticker, period }) =>
        guard(async () => {
          const c = await resolveCompany(ticker);
          const sel = await selectForCompany(c, period);
          const figures = t.figures.map((id) => figureBlock(sel, figureById(id)!));
          const out: Record<string, unknown> = { ...envelope(c, sel, period), figures };
          if (t.tool === "get_working_capital") {
            const docs = docsOf(sel);
            const ca = figureById("current_assets")!;
            const cl = figureById("current_liabilities")!;
            out.working_capital_calculated = sel.periods.flatMap((p) => {
              const d = docs.get(p.record) ?? sel.primary.doc;
              const a = resolveFigure(p, ca, null).primary;
              const l = resolveFigure(p, cl, null).primary;
              if (!a || !l) return [];
              const v = a.value - l.value;
              return [{
                period: p.name,
                period_end: p.period_end,
                value: v,
                display: display(v, "money", currencyPrefix(d)),
                formula: `${a.field} - ${l.field}`,
                current_ratio: Math.round((a.value / l.value) * 100) / 100,
                calculated: true,
              }];
            });
          }
          return jsonResult(out, sel.primary.url);
        }),
    );
  }

  server.registerTool(
    "list_standard_figures",
    {
      title: "Standard figures catalog",
      description:
        "The catalog of standard financial figures Ticker Scout looks for in every company's record - " +
        "revenue, cost of revenue, gross profit, R&D, SG&A, operating expenses, operating income, interest " +
        "expense, pretax income, income tax, net income, EPS, share counts, D&A, stock-based compensation, " +
        "bank net interest income and credit provisions, cash, assets, liabilities, debt, equity, working " +
        "capital, goodwill, intangibles, inventories, receivables, payables, PP&E, retained earnings, " +
        "operating cash flow, capex, free cash flow, investing and financing cash flow, dividends, buybacks " +
        "and acquisitions - with each one's definition, units, the dedicated tool that returns it, the words " +
        "get_figure accepts for it, and every record field name it is read from. No ticker needed.",
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    async () =>
      guard(async () => {
        const toolFor = new Map<string, string>();
        for (const t of FIGURE_TOOLS) for (const f of t.figures) toolFor.set(f, t.tool);
        return jsonResult(
          {
            count: FIGURES.length,
            note:
              "Ask for any of these with its dedicated tool or with get_figure(ticker, figure). Company-specific " +
              "figures outside this list (segment results, KPIs, bank ratios) are listed per company by " +
              "list_company_figures and searchable with find_figures.",
            figures: FIGURES.map((f) => ({
              id: f.id,
              label: f.label,
              units: KIND_WORDS[f.kind],
              tool: toolFor.get(f.id) ?? "get_figure",
              definition: f.definition,
              accepts: f.synonyms,
              statement_blocks: f.blocks.map((b) => (b === "." ? "(period level)" : b)),
              field_names: f.aliases,
            })),
          },
          sourceUrl("/tickers.json"),
        );
      }),
  );

  server.registerTool(
    "list_company_figures",
    {
      title: "Every figure this company reports, by its own names",
      description:
        "Dumps every numeric figure in a company's record under the exact name its financials.json (and its " +
        "page on tickerscout.ai) uses, with the value in each period. Two parts: standard_figures maps each " +
        "standard figure (revenue, net income, EPS, cash, debt and the rest) to the name THIS company's " +
        "record gives it - Apple's revenue is total_net_sales, JPMorgan's is total_net_revenue - and " +
        "other_figures holds every remaining figure, grouped by its statement or table (income statement " +
        "lines beyond the standard ones, segments, revenue_by_* breakdowns, key metrics, bank and insurance " +
        "tables, non-GAAP measures), keyed by its path. Every name and path here can be passed exactly as " +
        "written to get_figure or get_figure_history. Pass `block` to list one table only. Defaults to the " +
        "latest fiscal year and latest quarter; pass `period` for others (period='all' for every period held).",
      inputSchema: z.object({
        ticker: TICKER,
        period: PERIOD,
        block: z.string().optional().describe("Only this table, e.g. income_statement, reportable_segments, key_metrics."),
      }),
      annotations: READ_ONLY,
    },
    async ({ ticker, period, block }) =>
      guard(async () => {
        const c = await resolveCompany(ticker);
        const sel = await selectForCompany(c, period);
        if (!period) {
          // Default to the latest fiscal year and the latest quarter: every name a company uses
          // appears in one of them, at a fraction of the size of every period.
          const q = sel.periods.find((p) => p.kind === "quarter");
          const a = sel.periods.find((p) => p.kind === "annual");
          sel.periods = [q, a].filter((p): p is (typeof sel.periods)[number] => Boolean(p));
        }
        const docs = docsOf(sel);

        // Which field answers each standard figure, period by period.
        const standard: Record<string, { name_in_record: string; field: string; values: Record<string, number> }[]> = {};
        const standardFields = new Set<string>();
        for (const p of sel.periods) {
          const d = docs.get(p.record) ?? sel.primary.doc;
          for (const def of FIGURES) {
            const r = resolveFigure(p, def, headlineField(d, def)).primary;
            if (!r) continue;
            if (block && !r.field.startsWith(`${block}.`)) continue;
            standardFields.add(r.field);
            const list = (standard[def.id] ??= []);
            let slot = list.find((x) => x.field === r.field);
            if (!slot) list.push((slot = { name_in_record: nameOf(r.field), field: r.field, values: {} }));
            slot.values[p.name] = r.value;
          }
        }

        const other: Record<string, Record<string, Record<string, number>>> = {};
        for (const p of sel.periods) {
          for (const f of flattenPeriod(p)) {
            const b = f.block === "." ? "period_level" : f.block;
            if (block && b !== block) continue;
            if (standardFields.has(f.path)) continue;
            ((other[b] ??= {})[f.path] ??= {})[p.name] = f.value;
          }
        }
        if (block && !other[block] && !Object.keys(standard).length) {
          const names = [...new Set(sel.periods.flatMap((p) => flattenPeriod(p).map((f) => (f.block === "." ? "period_level" : f.block))))];
          throw new Error(`${c.ticker} has no table named "${block}" in these periods. Tables: ${names.join(", ")}.`);
        }
        const otherCount = Object.values(other).reduce((n, b) => n + Object.keys(b).length, 0);
        return jsonResult(
          {
            ...envelope(c, sel, period ?? "latest fiscal year and latest quarter"),
            periods: sel.periods.map((p) => p.name),
            how_to_call:
              "Pass any name_in_record, field or other_figures key to get_figure or get_figure_history exactly as " +
              "written, e.g. get_figure(ticker, 'total_net_sales') or get_figure(ticker, " +
              "'revenue_by_market_platform.Data Center').",
            standard_figures: standard,
            other_figure_count: otherCount,
            other_figures: other,
          },
          sel.primary.url,
        );
      }),
  );

  server.registerTool(
    "find_figures",
    {
      title: "Search figure names",
      description:
        "Find figures in a company's record by words in their names, for figures that are not on the " +
        "standard list or whose exact name you do not know: 'data center', 'cet1', 'comparable sales', " +
        "'backlog', 'china', 'subscribers', 'free cash flow'. Every word must appear in the field's path " +
        "(case-insensitive; spaces and underscores are interchangeable). Returns each matching field under " +
        "the exact name its record uses, with its value in every period, its accession and sec.gov link. A " +
        "standard name or synonym (revenue, EPS, capex) also returns the field this company uses for it.",
      inputSchema: z.object({
        ticker: TICKER,
        query: z.string().describe("Words to find in field names, e.g. 'data center revenue'."),
        period: PERIOD,
      }),
      annotations: READ_ONLY,
    },
    async ({ ticker, query, period }) =>
      guard(async () => {
        const c = await resolveCompany(ticker);
        const sel = await selectForCompany(c, period);
        const std = findStandardFigure(query);
        const exact = exactFields(sel.periods, query).paths;
        const paths = [...new Set([...exact, ...fieldsWithWords(sel.periods, query)])];
        return jsonResult(
          {
            ...envelope(c, sel, period),
            query,
            ...(std ? { standard_figure: figureBlock(sel, std) } : {}),
            matched_fields: paths.length,
            // Compact on purpose: name, path and value per period. get_figure on any of these
            // names returns the full rows with accession and sec.gov link.
            fields: paths.slice(0, 40).map((path) => ({
              name_in_record: nameOf(path),
              field: path,
              values: Object.fromEntries(
                sel.periods.flatMap((p) => {
                  const v = readPath(p, path);
                  return v === null ? [] : [[p.name, v]];
                }),
              ),
            })),
            ...(paths.length > 40 ? { note: `${paths.length} fields matched; the first 40 are shown.` } : {}),
          },
          sel.primary.url,
        );
      }),
  );

  server.registerTool(
    "get_figure",
    {
      title: "Any figure by name",
      description:
        "Get any figure for a company in one call, by the name its own record uses or by a standard name. " +
        "An exact name or path from the record is answered with exactly that field: 'total_net_sales', " +
        "'net_income_attributable_to_walmart', 'Data Center', 'reportable_segments.Compute & Networking.revenue', " +
        "'bank_metrics.cet1_ratio_pct' (case, spaces and underscores do not matter). A standard name or synonym " +
        "that is not itself a field in the record ('revenue', 'EPS', 'capex', 'book value') returns the field " +
        "this company uses for it, named. Otherwise fields containing all the words are returned. Every value " +
        "carries its name_in_record and json_path, so what is returned is never relabeled. " +
        `${SOURCE_NOTE} Returns every period in the latest record by default, or the periods named by ` +
        `\`period\`. ${UNITS_NOTE} When nothing matches, the error names the fields that come closest.`,
      inputSchema: z.object({
        ticker: TICKER,
        figure: z.string().describe("Standard figure name or synonym, a field path, a field name, or words."),
        period: PERIOD,
      }),
      annotations: READ_ONLY,
    },
    async ({ ticker, figure, period }) =>
      guard(async () => {
        const c = await resolveCompany(ticker);
        const sel = await selectForCompany(c, period);
        return jsonResult({ ...envelope(c, sel, period), requested_figure: figure, ...answerFigure(sel, figure) }, sel.primary.url);
      }),
  );

  server.registerTool(
    "get_figure_history",
    {
      title: "One figure across every period held",
      description:
        "The full history Ticker Scout holds for one figure: every fiscal year and every quarter across every " +
        "published record, oldest first, in separate annual and quarterly series, with the record each value " +
        "was read from. When two records hold the same period (a quarter and the next year's prior-year " +
        "comparative), the newer record's value is used because it carries any restatement. Accepts the same " +
        `figure names as get_figure. ${UNITS_NOTE} Coverage began in 2026, so most companies have three fiscal ` +
        "years and two to four quarters; list_periods shows exactly what is held.",
      inputSchema: z.object({
        ticker: TICKER,
        figure: z.string().describe("Standard figure name or synonym, a field path, a field name, or words."),
      }),
      annotations: READ_ONLY,
    },
    async ({ ticker, figure }) =>
      guard(async () => {
        const c = await resolveCompany(ticker);
        const sel = await selectForCompany(c, "all");
        const answer = answerFigure(sel, figure);
        const split = (rows: Record<string, unknown>[]) => {
          const asc = [...rows].sort((a, b) => String(a.period_end).localeCompare(String(b.period_end)));
          return {
            annual: asc.filter((r) => r.kind === "annual"),
            quarterly: asc.filter((r) => r.kind === "quarter"),
            year_to_date_and_trailing: asc.filter((r) => r.kind !== "annual" && r.kind !== "quarter"),
          };
        };
        const body: Record<string, unknown> = { ...envelope(c, sel, "all"), requested_figure: figure, matched_as: answer.matched_as };
        if (Array.isArray(answer.values)) {
          Object.assign(body, {
            standard_figure: answer.standard_figure,
            reported_as: answer.reported_as,
            history: split(answer.values as Record<string, unknown>[]),
          });
          if (answer.not_reported_in) body.not_reported_in = answer.not_reported_in;
        } else {
          body.figures = (answer.figures as { name_in_record: string; field: string; values: Record<string, unknown>[] }[]).map((f) => ({
            name_in_record: f.name_in_record,
            field: f.field,
            history: split(f.values),
          }));
        }
        return jsonResult(body, sel.primary.url);
      }),
  );

  server.registerTool(
    "compare_companies",
    {
      title: "Compare a figure across companies",
      description:
        "One standard figure for two to ten companies side by side: revenue, net income, EPS, operating " +
        "income, free cash flow, debt, cash, equity or any other figure on the standard list. Defaults to " +
        "each company's latest discrete period (its latest quarter, or its latest fiscal year if that is " +
        "newer); pass period='latest annual', 'ttm', 'latest quarter' or a fiscal year. Fiscal calendars " +
        "differ between companies, so each row states its own period and dates; a company that does not " +
        `report the figure, or the period, gets a row saying so rather than failing the call. ${UNITS_NOTE}`,
      inputSchema: z.object({
        tickers: z.array(z.string()).min(2).max(10).describe("Two to ten tickers."),
        figure: z.string().describe("A standard figure name or synonym, e.g. revenue, net income, diluted eps, fcf."),
        period: z.string().optional().describe(`Default 'latest'. ${PERIOD_SYNTAX}`),
      }),
      annotations: READ_ONLY,
    },
    async ({ tickers, figure, period }) =>
      guard(async () => {
        const def = findStandardFigure(figure);
        if (!def) {
          throw new Error(
            `"${figure}" is not a standard figure, so it cannot be compared across companies whose records ` +
              `name things differently. list_standard_figures shows the ${FIGURES.length} that can be.`,
          );
        }
        const file = await loadTickers();
        const rows = await Promise.all(
          tickers.map(async (t) => {
            try {
              const c = companyFrom(file, t);
              const sel = await selectForCompany(c, period ?? "latest");
              const p = sel.periods[0];
              const d = sel.records.find((r) => r.tag === p.record)?.doc ?? sel.primary.doc;
              const r = resolveFigure(p, def, headlineField(d, def));
              const h = periodHeader(p);
              if (!r.primary) {
                return { ticker: c.ticker, company: c.company, period: p.name, period_end: p.period_end, value: null, note: `${c.ticker} reports no ${def.label.toLowerCase()} under a standard name in this period.` };
              }
              return {
                ticker: c.ticker,
                company: c.company,
                name_in_record: nameOf(r.primary.field),
                field: r.primary.field,
                period: p.name,
                period_start: p.period_start,
                period_end: p.period_end,
                value: r.primary.value,
                display: display(r.primary.value, def.kind, currencyPrefix(d)),
                source_accession: h.source_accession ?? null,
              };
            } catch (err) {
              return { ticker: t.toUpperCase(), value: null, note: err instanceof PeriodNotAvailable || err instanceof Error ? err.message : String(err) };
            }
          }),
        );
        return jsonResult(
          {
            standard_figure: def.id,
            definition: def.definition,
            requested_period: period ?? "latest",
            units: UNITS_NOTE,
            companies: rows,
          },
          sourceUrl("/tickers.json"),
        );
      }),
  );

  server.registerTool(
    "get_figure_source",
    {
      title: "Where a figure is printed in the SEC filing",
      description:
        "Trace a figure to the filing: for each period, the SEC accession number and form it came from, the " +
        "filing document, and a sec.gov link that opens that document at the exact line printing the number " +
        "(built from the record's figure_sources block, matched by exact value and period). A figure with no " +
        "link was calculated in the record (margins, free cash flow, trailing twelve months, a quarter " +
        "derived by subtraction) or comes from an earnings release, which the SEC does not tag; the response " +
        "says which applies. Accepts the same figure names as get_figure.",
      inputSchema: z.object({
        ticker: TICKER,
        figure: z.string().describe("Standard figure name or synonym, a field path, a field name, or words."),
        period: PERIOD,
      }),
      annotations: READ_ONLY,
    },
    async ({ ticker, figure, period }) =>
      guard(async () => {
        const c = await resolveCompany(ticker);
        const sel = await selectForCompany(c, period);
        const answer = answerFigure(sel, figure);
        const fs = sel.primary.doc.figure_sources as Record<string, unknown> | undefined;
        const strip = (rows: Record<string, unknown>[]) =>
          rows.map((r) => ({
            name_in_record: r.name_in_record,
            json_path: r.json_path,
            period: r.period,
            period_end: r.period_end,
            value: r.value,
            field: r.field,
            source_accession: r.source_accession,
            source_form: r.source_form,
            sec_link: r.sec_link,
          }));
        const body: Record<string, unknown> = {
          ...envelope(c, sel, period),
          requested_figure: figure,
          how_links_work: fs?.about ?? null,
        };
        if (Array.isArray(answer.values)) body.sources = strip(answer.values as Record<string, unknown>[]);
        else body.sources = (answer.figures as { name_in_record: string; field: string; values: Record<string, unknown>[] }[]).map((f) => ({ name_in_record: f.name_in_record, field: f.field, periods: strip(f.values) }));
        return jsonResult(body, sel.primary.url);
      }),
  );
}
