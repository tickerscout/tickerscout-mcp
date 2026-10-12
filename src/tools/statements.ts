import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { jsonResult } from "../respond.ts";
import type { FinancialsDoc } from "../financials.ts";
import { availability, dedupePeriods, periodHeader, periodsOf, PERIOD_SYNTAX, type Period } from "../periods.ts";
import { loadAllRecords, loadManifest, resolveCompany, selectForCompany } from "../records.ts";
import { currencyPrefix, display, figureById, resolveFigure, headlineField } from "../figures.ts";
import { PERIOD, READ_ONLY, TICKER, UNITS_NOTE, UNITS_SHORT, guard, unitsHeader } from "./shared.ts";

/** Compact header for a period inside a multi-period response. */
function head(p: Period): Record<string, unknown> {
  return periodHeader(p);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The blocks of a period whose names match a family, e.g. every segment table. */
function blocksMatching(p: Period, re: RegExp): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p.data)) {
    if (typeof v !== "object" || v === null) continue;
    if (re.test(k)) out[k] = v;
  }
  return out;
}

/** Top-level structured sections outside the periods that belong to the same family. */
function topLevelMatching(doc: FinancialsDoc, re: RegExp): Record<string, unknown> {
  const skip = new Set(["annual", "quarterly", "year_to_date", "prior_year_to_date", "trailing_twelve_months", "figure_sources", "headline", "units_notes_seen"]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (skip.has(k) || typeof v !== "object" || v === null) continue;
    if (re.test(k)) out[k] = v;
  }
  return out;
}

function blockNames(periods: Period[]): string[] {
  const names = new Set<string>();
  for (const p of periods) for (const [k, v] of Object.entries(p.data)) if (isObj(v) || Array.isArray(v)) names.add(k);
  return [...names];
}

/**
 * Families of company-specific tables, found by block name because no two companies name
 * them alike. Each was its own tool before 3.0; they are now values of one argument.
 */
const FAMILIES: Record<string, { re: RegExp; none: string }> = {
  segments: {
    re: /segment|business_unit|railroad_|utilities_and_energy|manufacturing_service_and_retailing|after_tax_earnings_by_source|other_after_tax_earnings/,
    none: "no segment tables",
  },
  revenue_by_product: {
    re: /(revenue|revenues|sales)_by_|revenue_breakdown|revenue_detail|disaggregated_revenue|revenue_mix|net_revenue_by|segment_revenues|segment_net_revenue|segment_net_sales|product_sales_by|end_market_mix|qct_revenue|subscription_revenue_by/,
    none: "no revenue disaggregation beyond total revenue",
  },
  revenue_by_geography: {
    re: /geograph|region|countr|customer_headquarters|billing_location/,
    none: "no geographic breakdown",
  },
  operating: {
    re: /key_metrics|operating_metrics|key_operating_metrics|operating_statistics|other_measures|lodging_statistics|franchisor_metrics|reit_metrics|selected_operating_metrics|exploration_expense_detail|capital_investment|supplemental$/,
    none: "no operating metrics outside its statements",
  },
  non_gaap: {
    re: /non_gaap|adjusted|funds_from_operations|net_operating_income|core_/,
    none: "no non-GAAP measures",
  },
  bank: {
    re: /bank_metrics|capital_ratios|average_balances|key_ratios|ratios_and_capital|regulatory_capital|capital_structure_ratios|noninterest_(income|expense)_breakdown|credit_quality|^capital$/,
    none: "no bank metrics (it is not reported as a bank)",
  },
  insurance: {
    re: /insurance|underwriting|float|book_value|equity_securities_portfolio|investment_gains_losses|pc_underwriting/,
    none: "no insurance metrics (it is not reported as an insurer)",
  },
};

/** Every period's blocks from the chosen families, or a plain answer that the company reports none. */
async function familyResult(ticker: string, period: string | undefined, kinds: string[]) {
  const c = await resolveCompany(ticker);
  const sel = await selectForCompany(c, period);
  const re = new RegExp(kinds.map((k) => FAMILIES[k].re.source).join("|"));
  const rows = sel.periods
    .map((p) => ({ ...head(p), ...blocksMatching(p, re) }))
    .filter((r) => Object.keys(r).some((k) => isObj((r as Record<string, unknown>)[k])));
  const top = topLevelMatching(sel.primary.doc, re);
  if (!rows.length && !Object.keys(top).length) {
    return jsonResult(
      {
        ticker: c.ticker,
        available: false,
        message: `${c.ticker}'s record carries ${kinds.length === 1 ? FAMILIES[kinds[0]].none : `none of: ${kinds.join(", ")}`}.`,
        blocks_this_company_has: blockNames(sel.periods),
      },
      sel.primary.url,
    );
  }
  return jsonResult(
    {
      ticker: c.ticker,
      company: c.company,
      ...unitsHeader(sel.primary.doc),
      showing: kinds,
      periods: rows,
      ...(Object.keys(top).length ? { record_level_sections: top } : {}),
    },
    sel.primary.url,
  );
}

/** The statement blocks, and the per-share or derived blocks that belong with each. */
const STATEMENTS: Record<string, { label: string; extra: RegExp }> = {
  income_statement: { label: "income statement", extra: /^per_share|share_data|derived$/ },
  balance_sheet: { label: "balance sheet", extra: /^shares_outstanding|shares_issued/ },
  cash_flow: { label: "cash flow statement", extra: /^cash_flow_three_month_derived|shareholder_returns|capital_return/ },
};

export function registerStatementTools(server: McpServer) {
  server.registerTool(
    "list_periods",
    {
      title: "Every fiscal period and record held",
      description:
        "How far back the data goes for one company: every fiscal year and every quarter Ticker Scout " +
        "holds, across every published record, with each period's start and end dates, length in days, " +
        "source form and accession, and which records carry it; the year-to-date and trailing-twelve-" +
        "months blocks; the fiscal year end and whether the company runs 52/53-week years; and the list " +
        "of published records (each the snapshot built when one 10-Q or 10-K was filed, with its permanent " +
        "URLs). Fiscal years are the company's own: NVIDIA's FY2027 ends in January 2027, Apple's FY2026 " +
        "in September 2026.",
      inputSchema: z.object({ ticker: TICKER }),
      annotations: READ_ONLY,
    },
    async ({ ticker }) =>
      guard(async () => {
        const c = await resolveCompany(ticker);
        const [manifest, records] = await Promise.all([loadManifest(c), loadAllRecords(c)]);
        const all = records.flatMap((r) => periodsOf(r.doc, r.tag));
        const carriedBy = new Map<string, string[]>();
        const key = (p: Period) =>
          p.kind === "annual" ? `a${p.fiscal_year}` : p.kind === "quarter" ? `q${p.fiscal_year}-${p.fiscal_quarter}` : `${p.kind}${p.period_end}`;
        for (const p of all) carriedBy.set(key(p), [...(carriedBy.get(key(p)) ?? []), p.record]);
        const unique = dedupePeriods(all);
        const row = (p: Period) => {
          const h = head(p);
          const lengthDays = p.period_start && p.period_end
            ? Math.round((Date.parse(p.period_end) - Date.parse(p.period_start)) / 86_400_000) + 1
            : null;
          const weeks = p.data.weeks_in_period ?? p.data.weeks_in_year ?? p.data.fiscal_year_weeks ?? p.data.weeks ?? null;
          return {
            period: p.name,
            fiscal_year: p.fiscal_year,
            ...(p.fiscal_quarter !== null ? { fiscal_quarter: p.fiscal_quarter } : {}),
            period_start: p.period_start,
            period_end: p.period_end,
            length_days: lengthDays,
            ...(weeks ? { weeks } : {}),
            source_form: h.source_form ?? null,
            source_accession: h.source_accession ?? null,
            statements: Object.keys(p.data).filter((k) => isObj(p.data[k])),
            in_records: carriedBy.get(key(p)),
          };
        };
        const byEnd = (a: Period, b: Period) => (a.period_end ?? "").localeCompare(b.period_end ?? "");
        const avail = availability(all);
        const fiscalYears = unique.filter((p) => p.kind === "annual").sort(byEnd).map(row);
        const weekBased = fiscalYears.some((r) => r.length_days === 364 || r.length_days === 371);
        const latest = records[0].doc;
        return jsonResult(
          {
            ticker: c.ticker,
            company: c.company,
            fiscal_year_end: (latest.fiscal_period as Record<string, unknown> | undefined)?.fiscal_year_end ?? null,
            fiscal_year_convention: latest.fiscal_year_convention ?? null,
            ...(typeof latest.fiscal_calendar_note === "string" ? { fiscal_calendar_note: latest.fiscal_calendar_note } : {}),
            week_based_years: weekBased
              ? "Yes: fiscal years of 364 or 371 days indicate a 52/53-week calendar ending on a set weekday."
              : "No 52/53-week year detected in the periods held.",
            earliest_fiscal_year: avail.earliest_fiscal_year,
            latest_fiscal_year: avail.latest_fiscal_year,
            earliest_quarter: avail.earliest_quarter,
            latest_quarter: avail.latest_quarter,
            fiscal_years: fiscalYears,
            quarters: unique.filter((p) => p.kind === "quarter").sort(byEnd).map(row),
            year_to_date_and_trailing: unique.filter((p) => p.kind !== "annual" && p.kind !== "quarter").map(row),
            records: (manifest.doc.periods as unknown[]) ?? c.entry.periods,
            next_expected_filing: c.entry.next_expected_filing ?? null,
            how_to_ask: `Pass any of these to a period argument. ${PERIOD_SYNTAX}`,
          },
          manifest.url,
        );
      }),
  );

  server.registerTool(
    "get_statements",
    {
      title: "Statements for any period",
      description:
        "The income statement, balance sheet or cash flow statement, as the company reports it with line " +
        "items in reported order, for any fiscal year, quarter, year to date or trailing twelve months. " +
        "`statement` picks one (default: every statement and table held for the period, including " +
        "segments and industry metrics). `period` picks the periods (default: every period in the latest " +
        "record: up to three fiscal years, the latest quarter and its prior-year comparative, year to " +
        "date, trailing twelve months) and searches older records when the latest does not hold it; " +
        "'ttm' and 'ytd' return those blocks with their derivation notes. A period earlier than the data " +
        "held returns that the data does not go back that far, and what is held. Each period carries its " +
        `dates, source form and accession. ${UNITS_NOTE} include_sources=true adds the sec.gov link ` +
        "for every figure the filing tags.",
      inputSchema: z.object({
        ticker: TICKER,
        statement: z
          .enum(["income_statement", "balance_sheet", "cash_flow", "all"])
          .optional()
          .describe("Which statement. Default 'all': every statement and table held for each period."),
        period: PERIOD,
        include_sources: z.boolean().optional().describe("Add a sec.gov link per tagged figure. Default false."),
      }),
      annotations: READ_ONLY,
    },
    async ({ ticker, statement, period, include_sources }) =>
      guard(async () => {
        const c = await resolveCompany(ticker);
        const sel = await selectForCompany(c, period);
        const docs = new Map(sel.records.map((r) => [r.tag, r.doc]));
        const only = statement && statement !== "all" ? STATEMENTS[statement] : null;
        return jsonResult(
          {
            ticker: c.ticker,
            company: c.company,
            ...unitsHeader(sel.primary.doc),
            statement: statement ?? "all",
            requested_period: period ?? "every period in the latest record",
            periods: sel.periods.map((p) => {
              const out: Record<string, unknown> = { ...head(p) };
              if (only) {
                const stmt = p.data[statement as string];
                out[statement as string] = stmt ?? null;
                if (!stmt) out.note = `No ${only.label} is recorded for this period.`;
                Object.assign(out, blocksMatching(p, only.extra));
              } else {
                for (const [k, v] of Object.entries(p.data)) if (typeof v === "object" && v !== null) out[k] = v;
              }
              if (include_sources) {
                const d = docs.get(p.record) ?? sel.primary.doc;
                const fs = d.figure_sources as Record<string, unknown> | undefined;
                const node = fs?.[p.array];
                const entry = Array.isArray(node) ? node[p.index ?? -1] : node;
                if (entry) {
                  out.figure_sources = only && isObj(entry) ? { [statement as string]: entry[statement as string] } : entry;
                  out.figure_source_documents = fs?.documents;
                }
              }
              return out;
            }),
          },
          sel.primary.url,
        );
      }),
  );

  server.registerTool(
    "get_segments",
    {
      title: "Segments and revenue breakdowns",
      description:
        "How a company's results split, exactly as it reports them: `segments` (reportable segment " +
        "revenue, operating income or profit, and whatever else it discloses per segment: assets, capex, " +
        "managed-basis results for a bank, business-unit earnings for a conglomerate), " +
        "`revenue_by_product` (revenue by product, service, end market, platform, channel or customer " +
        "type, e.g. NVIDIA's Data Center, Apple's iPhone and Services), and `revenue_by_geography` " +
        "(by country or region, with long-lived assets by geography where held). Default: all three. " +
        "Table names differ by company and are returned as the record names them. Every period in the " +
        `latest record by default, or the periods named by \`period\`. ${UNITS_SHORT} If the company ` +
        "reports none, the response says so and lists the tables it does have.",
      inputSchema: z.object({
        ticker: TICKER,
        breakdown: z
          .enum(["segments", "revenue_by_product", "revenue_by_geography", "all"])
          .optional()
          .describe("Which breakdown. Default 'all'."),
        period: PERIOD,
      }),
      annotations: READ_ONLY,
    },
    async ({ ticker, breakdown, period }) =>
      guard(() =>
        familyResult(ticker, period, !breakdown || breakdown === "all" ? ["segments", "revenue_by_product", "revenue_by_geography"] : [breakdown]),
      ),
  );

  server.registerTool(
    "get_company_metrics",
    {
      title: "KPIs, non-GAAP and industry metrics",
      description:
        "Measures a company reports outside its GAAP statements, as it defines them: `operating` KPIs " +
        "(users, subscribers, paid memberships, bookings, stores, RevPAR, deliveries, backlog, remaining " +
        "performance obligations), `non_gaap` measures (adjusted EPS, adjusted operating income, EBITDA, " +
        "FFO for a REIT, core earnings, with the reconciling figures held), `bank` metrics (CET1 and " +
        "other capital ratios, net interest margin, efficiency ratio, average balances and yields, credit " +
        "quality) and `insurance` metrics (premiums, underwriting results, combined and loss ratios, " +
        "investment income, float, book value). Default: every kind this company reports. These are the " +
        "company's own definitions from its filings or earnings release. Every period in the latest " +
        `record by default, or the periods named by \`period\`. ${UNITS_SHORT}`,
      inputSchema: z.object({
        ticker: TICKER,
        kind: z
          .enum(["operating", "non_gaap", "bank", "insurance", "all"])
          .optional()
          .describe("Which kind. Default 'all'."),
        period: PERIOD,
      }),
      annotations: READ_ONLY,
    },
    async ({ ticker, kind, period }) =>
      guard(() => familyResult(ticker, period, !kind || kind === "all" ? ["operating", "non_gaap", "bank", "insurance"] : [kind])),
  );

  server.registerTool(
    "get_margins_and_ratios",
    {
      title: "Margins and ratios",
      description:
        "Profitability margins and balance-sheet ratios for every period: every margin and rate the record " +
        "itself stores (gross margin %, operating margin %, effective tax rate, segment margins, efficiency " +
        "ratio and the like), plus gross, operating, net and free-cash-flow margin, working capital and " +
        "current ratio calculated here from the period's own figures, each labeled as calculated with its " +
        "formula and the exact fields used, so it can be checked. A ratio is calculated only when both " +
        "figures are in the same period of the same record; nothing is estimated. Every period in the " +
        "latest record by default, or the periods named by `period`.",
      inputSchema: z.object({ ticker: TICKER, period: PERIOD }),
      annotations: READ_ONLY,
    },
    async ({ ticker, period }) =>
      guard(async () => {
        const c = await resolveCompany(ticker);
        const sel = await selectForCompany(c, period);
        const docs = new Map(sel.records.map((r) => [r.tag, r.doc]));
        const pairs: [string, string, string][] = [
          ["gross_margin", "gross_profit", "revenue"],
          ["operating_margin", "operating_income", "revenue"],
          ["net_margin", "net_income", "revenue"],
          ["free_cash_flow_margin", "free_cash_flow", "revenue"],
        ];
        const rows = sel.periods.map((p) => {
          const d = docs.get(p.record) ?? sel.primary.doc;
          const stored: Record<string, number> = {};
          for (const [b, v] of Object.entries(p.data)) {
            if (!isObj(v)) continue;
            for (const [k, x] of Object.entries(v)) {
              if (typeof x === "number" && /(margin|_rate|ratio).*(pct|percent)|(pct|percent)$/.test(k) && /margin|rate|ratio|yield|return/.test(k)) {
                stored[`${b}.${k}`] = x;
              }
            }
          }
          const calculated: Record<string, unknown> = {};
          const pick = (id: string) => {
            const def = figureById(id)!;
            return resolveFigure(p, def, headlineField(d, def)).primary;
          };
          for (const [name, num, den] of pairs) {
            const n = pick(num);
            const q = pick(den);
            if (n && q && q.value !== 0) {
              calculated[name] = {
                value_pct: Math.round((n.value / q.value) * 1000) / 10,
                formula: `${n.field} / ${q.field}`,
                numerator: n.value,
                denominator: q.value,
                calculated: true,
              };
            }
          }
          const a = pick("current_assets");
          const l = pick("current_liabilities");
          if (a && l) {
            const v = a.value - l.value;
            calculated.working_capital = {
              value: v,
              display: display(v, "money", currencyPrefix(d)),
              formula: `${a.field} - ${l.field}`,
              calculated: true,
            };
            if (l.value !== 0) {
              calculated.current_ratio = {
                value: Math.round((a.value / l.value) * 100) / 100,
                formula: `${a.field} / ${l.field}`,
                calculated: true,
              };
            }
          }
          return {
            period: p.name,
            kind: p.kind,
            period_end: p.period_end,
            stored_in_record: stored,
            calculated_here: calculated,
          };
        });
        return jsonResult(
          {
            ticker: c.ticker,
            company: c.company,
            note:
              "stored_in_record values are the record's own; calculated_here values use the formula shown, " +
              "from the same period, margins rounded to one decimal. A bank's revenue is net of interest " +
              "expense and its balance sheet is unclassified, so its margins are not comparable with an " +
              "industrial company's and it has no working capital.",
            periods: rows,
          },
          sel.primary.url,
        );
      }),
  );
}
