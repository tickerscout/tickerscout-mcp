import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { jsonResult } from "../respond.ts";
import type { FinancialsDoc } from "../financials.ts";
import { availability, dedupePeriods, periodHeader, periodsOf, PERIOD_SYNTAX, type Period } from "../periods.ts";
import {
  loadAllRecords,
  loadLatestFinancials,
  loadManifest,
  loadRecord,
  resolveCompany,
  selectForCompany,
} from "../records.ts";
import { figureById, resolveFigure, headlineField } from "../figures.ts";
import { PERIOD, READ_ONLY, RECORD, TICKER, UNITS_NOTE, UNITS_SHORT, guard, resolveRecordArg, unitsHeader } from "./shared.ts";

/** Compact header for a period inside a multi-period response. */
function head(p: Period): Record<string, unknown> {
  return periodHeader(p);
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The blocks of a period whose names match a family, e.g. every segment table. */
function blocksMatching(p: Period, re: RegExp, exclude?: RegExp): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p.data)) {
    if (typeof v !== "object" || v === null) continue;
    if (re.test(k) && !(exclude && exclude.test(k))) out[k] = v;
  }
  return out;
}

/** Top-level structured sections outside the periods that belong to the same family. */
function topLevelMatching(doc: FinancialsDoc, re: RegExp, exclude?: RegExp): Record<string, unknown> {
  const skip = new Set(["annual", "quarterly", "year_to_date", "prior_year_to_date", "trailing_twelve_months", "figure_sources", "headline", "units_notes_seen"]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(doc)) {
    if (skip.has(k) || typeof v !== "object" || v === null) continue;
    if (re.test(k) && !(exclude && exclude.test(k))) out[k] = v;
  }
  return out;
}

function blockNames(periods: Period[]): string[] {
  const names = new Set<string>();
  for (const p of periods) for (const [k, v] of Object.entries(p.data)) if (isObj(v) || Array.isArray(v)) names.add(k);
  return [...names];
}

interface Family {
  tool: string;
  title: string;
  description: string;
  re: RegExp;
  exclude?: RegExp;
  none: string;
}

const FAMILIES: Family[] = [
  {
    tool: "get_segments",
    title: "Segment results",
    description:
      "Results by reportable segment, exactly as the company reports them in the segment note of its " +
      "10-K or 10-Q: segment revenue, segment operating income or profit, and whatever else the company " +
      "discloses per segment (assets, capital expenditures, depreciation, headcount, managed-basis " +
      "results for banks, business-unit earnings for a conglomerate). Every block whose name says " +
      "segment or business unit, for every period, with the period's dates, form and accession.",
    re: /segment|business_unit|railroad_|utilities_and_energy|manufacturing_service_and_retailing|after_tax_earnings_by_source|other_after_tax_earnings/,
    none: "This company's record carries no segment tables.",
  },
  {
    tool: "get_revenue_breakdown",
    title: "Revenue by product, service, end market or channel",
    description:
      "Revenue disaggregation: revenue or net sales by product, product line, service, end market, " +
      "platform, customer type, channel, franchise or category, as the company itself disaggregates it " +
      "(for example NVIDIA's Data Center and Gaming, Apple's iPhone and Services, Eli Lilly's sales by " +
      "product). Every revenue_by_*, net_sales_by_*, product_sales_by_* and similar block for every period.",
    re: /(revenue|revenues|sales)_by_|revenue_breakdown|revenue_detail|disaggregated_revenue|revenue_mix|net_revenue_by|segment_revenues|segment_net_revenue|segment_net_sales|product_sales_by|end_market_mix|qct_revenue|subscription_revenue_by/,
    none: "This company's record carries no revenue disaggregation beyond total revenue.",
  },
  {
    tool: "get_geographic_revenue",
    title: "Revenue by geography",
    description:
      "Revenue by country or region, as the company reports it: by customer location, billing location, " +
      "customer headquarters or geographic segment (for example United States, China, Taiwan, EMEA). " +
      "Also returns long-lived assets and operating income by geography where the record carries them.",
    re: /geograph|region|countr|customer_headquarters|billing_location/,
    none: "This company's record carries no geographic breakdown.",
  },
  {
    tool: "get_non_gaap_measures",
    title: "Non-GAAP and adjusted measures",
    description:
      "Non-GAAP and company-defined measures as the company reports them, such as adjusted EPS, adjusted " +
      "operating income, adjusted EBITDA, funds from operations for a REIT, and core or operating " +
      "earnings, with the reconciliation figures the record holds. These are the company's own " +
      "definitions from its filings or earnings release, not Ticker Scout's.",
    re: /non_gaap|adjusted|funds_from_operations|net_operating_income|core_/,
    none: "This company's record carries no non-GAAP measures.",
  },
  {
    tool: "get_operating_metrics",
    title: "Operating metrics and KPIs",
    description:
      "Key performance indicators the company reports outside its financial statements: users, " +
      "subscribers, paid memberships, gross bookings, stores, room nights, RevPAR, deliveries, production " +
      "volumes, backlog, remaining performance obligations, and other company-specific operating " +
      "statistics, from every key_metrics, operating_metrics and statistics block in the record.",
    re: /key_metrics|operating_metrics|key_operating_metrics|operating_statistics|other_measures|lodging_statistics|franchisor_metrics|reit_metrics|selected_operating_metrics|exploration_expense_detail|capital_investment|supplemental$/,
    none: "This company's record carries no operating metrics outside its statements.",
  },
  {
    tool: "get_bank_metrics",
    title: "Bank capital, credit and balance metrics",
    description:
      "Bank-specific measures: CET1 and other regulatory capital ratios, net interest margin, efficiency " +
      "ratio, average balances and yields, credit quality, noninterest income and expense breakdowns, " +
      "return on equity and tangible equity, for the banks and broker-dealers in coverage (JPM, BAC, WFC, " +
      "C, GS, MS, USB, PNC, COF, BNY, SCHW and others).",
    re: /bank_metrics|capital_ratios|average_balances|key_ratios|ratios_and_capital|regulatory_capital|capital_structure_ratios|noninterest_(income|expense)_breakdown|credit_quality|^capital$/,
    none: "This company's record carries no bank metrics. It is not reported as a bank.",
  },
  {
    tool: "get_insurance_metrics",
    title: "Insurance underwriting and investment metrics",
    description:
      "Insurance-specific measures: premiums written and earned, losses, underwriting results, combined, " +
      "loss and expense ratios, insurance investment income, investment gains and losses, float and " +
      "book value, for the insurers in coverage (BRK-B, CB, PGR and others).",
    re: /insurance|underwriting|float|book_value|equity_securities_portfolio|investment_gains_losses|pc_underwriting/,
    none: "This company's record carries no insurance metrics. It is not reported as an insurer.",
  },
];

const STATEMENTS: { tool: string; title: string; block: string; extra: RegExp; description: string }[] = [
  {
    tool: "get_income_statement",
    title: "Income statement",
    block: "income_statement",
    extra: /^per_share|share_data|derived$/,
    description:
      "The income statement as the company reports it, line items in reported order: revenue, cost of " +
      "revenue, gross profit, operating expenses, operating income, interest and other income, pretax " +
      "income, income tax, net income, basic and diluted EPS and weighted-average shares (a bank's " +
      "statement has net interest income, noninterest income, provision for credit losses and " +
      "noninterest expense instead). Per-share blocks ride along where the company reports them " +
      "separately.",
  },
  {
    tool: "get_balance_sheet",
    title: "Balance sheet",
    block: "balance_sheet",
    extra: /^shares_outstanding|shares_issued/,
    description:
      "The balance sheet at each period end: cash and investments, receivables, inventories, current " +
      "assets, property and equipment, goodwill and intangibles, total assets, payables, current " +
      "liabilities, short- and long-term debt, total liabilities, shareholders' equity and " +
      "noncontrolling interests, in the company's own line items (a bank's has loans, deposits and " +
      "trading assets; an insurer's has investments and reserves).",
  },
  {
    tool: "get_cash_flow_statement",
    title: "Cash flow statement",
    block: "cash_flow",
    extra: /^cash_flow_three_month_derived|shareholder_returns|capital_return/,
    description:
      "The cash flow statement: operating cash flow and its main adjustments (depreciation and " +
      "amortization, stock-based compensation), capital expenditures, acquisitions, investing and " +
      "financing totals, dividends paid, share repurchases, debt issued and repaid, plus free cash flow. " +
      "Where a 10-Q presents cash flow only year to date, the discrete quarter comes from the earnings " +
      "release when the company published one; the period's own note says which.",
  },
];

export function registerStatementTools(server: McpServer) {
  server.registerTool(
    "list_periods",
    {
      title: "Every fiscal period and record held",
      description:
        "History and coverage for one company: every fiscal year and every quarter Ticker Scout holds, " +
        "across every published record, with each period's start and end dates, length, source form " +
        "and accession, and which records carry it; plus the year-to-date and trailing-twelve-months " +
        "blocks, and the list of published records (each the snapshot built when one 10-Q or 10-K was " +
        "filed, with its permanent URLs). Call this to see how far back the data goes before asking for " +
        "a specific year or quarter. Fiscal years are the company's own: NVIDIA's FY2027 ends in January " +
        "2027, Apple's FY2026 ends in September 2026.",
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
          return {
            period: p.name,
            fiscal_year: p.fiscal_year,
            ...(p.fiscal_quarter !== null ? { fiscal_quarter: p.fiscal_quarter } : {}),
            period_start: p.period_start,
            period_end: p.period_end,
            length_days: lengthDays,
            source_form: h.source_form ?? null,
            source_accession: h.source_accession ?? null,
            statements: Object.keys(p.data).filter((k) => isObj(p.data[k])),
            in_records: carriedBy.get(key(p)),
          };
        };
        const byEnd = (a: Period, b: Period) => (a.period_end ?? "").localeCompare(b.period_end ?? "");
        const avail = availability(all);
        return jsonResult(
          {
            ticker: c.ticker,
            company: c.company,
            fiscal_year_end: (records[0].doc.fiscal_period as Record<string, unknown> | undefined)?.fiscal_year_end ?? null,
            earliest_fiscal_year: avail.earliest_fiscal_year,
            latest_fiscal_year: avail.latest_fiscal_year,
            earliest_quarter: avail.earliest_quarter,
            latest_quarter: avail.latest_quarter,
            fiscal_years: unique.filter((p) => p.kind === "annual").sort(byEnd).map(row),
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
    "get_period",
    {
      title: "Everything for one fiscal year or quarter",
      description:
        "Every statement and table Ticker Scout holds for one fiscal period: income statement, balance " +
        "sheet, cash flow, segments, revenue breakdowns, per-share data and any industry metrics, with the " +
        "period's dates, source form, accession and sourcing notes. Searches every published record, so an " +
        "older quarter that only an earlier record carries is still found. If the period is earlier than " +
        "anything held, the response says plainly that the data does not go back that far and lists what " +
        `is held; if it has not been reported yet, it says that and gives the next expected filing. ${UNITS_NOTE} ` +
        "Pass include_sources=true to add the sec.gov link for every figure the filing tags.",
      inputSchema: z.object({
        ticker: TICKER,
        period: z.string().describe(`The fiscal period. ${PERIOD_SYNTAX}`),
        include_sources: z.boolean().optional().describe("Add a sec.gov link per tagged figure. Default false."),
      }),
      annotations: READ_ONLY,
    },
    async ({ ticker, period, include_sources }) =>
      guard(async () => {
        const c = await resolveCompany(ticker);
        const sel = await selectForCompany(c, period);
        const docs = new Map(sel.records.map((r) => [r.tag, r.doc]));
        return jsonResult(
          {
            ticker: c.ticker,
            company: c.company,
            ...unitsHeader(sel.primary.doc),
            requested: period,
            periods: sel.periods.map((p) => {
              const out: Record<string, unknown> = { ...head(p) };
              for (const [k, v] of Object.entries(p.data)) if (typeof v === "object" && v !== null) out[k] = v;
              if (include_sources) {
                const d = docs.get(p.record) ?? sel.primary.doc;
                const fs = d.figure_sources as Record<string, unknown> | undefined;
                const node = fs?.[p.array];
                const entry = Array.isArray(node) ? node[p.index ?? -1] : node;
                if (entry) {
                  out.figure_sources = entry;
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

  for (const [tool, kind, title, desc] of [
    [
      "get_trailing_twelve_months",
      "trailing_twelve_months",
      "Trailing twelve months",
      "The trailing-twelve-months block: income statement and cash flow summed over the last four reported " +
        "quarters, with its own derivation note saying exactly which fiscal year and year-to-date columns " +
        "it was built from (for example 'FY2026 plus first half FY2027 less first half FY2026'). TTM " +
        "figures are calculated in the record from filed figures, so they have no sec.gov line of their own.",
    ],
    [
      "get_year_to_date",
      "year_to_date",
      "Year to date and prior year to date",
      "The year-to-date block (six or nine months, as the latest 10-Q reports it) and, where the record " +
        "has one, the prior-year year-to-date comparative from the same 10-Q: income statement, cash flow " +
        "and segment data for the fiscal year so far. Year-to-date cash flow is what a 10-Q actually prints.",
    ],
  ] as const) {
    server.registerTool(
      tool,
      {
        title,
        description: `${desc} ${UNITS_SHORT} Pass \`record\` for an earlier published record.`,
        inputSchema: z.object({ ticker: TICKER, record: RECORD }),
        annotations: READ_ONLY,
      },
      async ({ ticker, record }) =>
        guard(async () => {
          const c = await resolveCompany(ticker);
          const tag = resolveRecordArg(c, record);
          const r = tag ? await loadRecord(c, tag) : await loadLatestFinancials(c);
          const ps = periodsOf(r.doc, r.tag).filter((p) =>
            kind === "year_to_date" ? p.kind === "year_to_date" || p.kind === "prior_year_to_date" : p.kind === kind,
          );
          if (!ps.length) {
            return jsonResult(
              {
                ticker: c.ticker,
                available: false,
                message: `${c.ticker}'s record ${r.tag} has no ${title.toLowerCase()} block. A record built from a 10-K has no year-to-date block, and a few companies' records carry no TTM.`,
              },
              r.url,
            );
          }
          return jsonResult(
            {
              ticker: c.ticker,
              company: c.company,
              record: r.tag,
              ...unitsHeader(r.doc),
              periods: ps.map((p) => ({ ...head(p), ...Object.fromEntries(Object.entries(p.data).filter(([, v]) => typeof v === "object" && v !== null)) })),
            },
            r.url,
          );
        }),
    );
  }

  for (const s of STATEMENTS) {
    server.registerTool(
      s.tool,
      {
        title: s.title,
        description:
          `${s.description} Returns every period in the latest record by default (up to three fiscal years, ` +
          "the latest quarter and its prior-year comparative, year to date, trailing twelve months), or the " +
          `periods you name with \`period\`, searching older records when needed. ${UNITS_SHORT} Each period ` +
          "carries its dates, source form and accession; ask get_figure_source for the sec.gov line of any figure.",
        inputSchema: z.object({ ticker: TICKER, period: PERIOD }),
        annotations: READ_ONLY,
      },
      async ({ ticker, period }) =>
        guard(async () => {
          const c = await resolveCompany(ticker);
          const sel = await selectForCompany(c, period);
          const rows = sel.periods.map((p) => {
            const out: Record<string, unknown> = { ...head(p) };
            const stmt = p.data[s.block];
            out[s.block] = stmt ?? null;
            if (!stmt) out.note = `No ${s.title.toLowerCase()} is recorded for this period.`;
            Object.assign(out, blocksMatching(p, s.extra));
            return out;
          });
          return jsonResult(
            { ticker: c.ticker, company: c.company, ...unitsHeader(sel.primary.doc), statement: s.title, periods: rows },
            sel.primary.url,
          );
        }),
    );
  }

  for (const f of FAMILIES) {
    server.registerTool(
      f.tool,
      {
        title: f.title,
        description:
          `${f.description} Block names differ by company and are returned as the record names them. ` +
          "Returns every period in the latest record by default, or the periods you name with `period`. " +
          `${UNITS_SHORT} If the company reports none, the response says so and lists the blocks it does have.`,
        inputSchema: z.object({ ticker: TICKER, period: PERIOD }),
        annotations: READ_ONLY,
      },
      async ({ ticker, period }) =>
        guard(async () => {
          const c = await resolveCompany(ticker);
          const sel = await selectForCompany(c, period);
          const rows = sel.periods
            .map((p) => ({ ...head(p), ...blocksMatching(p, f.re, f.exclude) }))
            .filter((r) => Object.keys(r).some((k) => isObj((r as Record<string, unknown>)[k])));
          const top = topLevelMatching(sel.primary.doc, f.re, f.exclude);
          if (!rows.length && !Object.keys(top).length) {
            return jsonResult(
              {
                ticker: c.ticker,
                available: false,
                message: f.none,
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
              periods: rows,
              ...(Object.keys(top).length ? { record_level_sections: top } : {}),
            },
            sel.primary.url,
          );
        }),
    );
  }

  server.registerTool(
    "get_margins",
    {
      title: "Margins and rates",
      description:
        "Profitability margins for every period: every margin and rate the record itself stores (gross " +
        "margin %, operating margin %, net margin %, effective tax rate, segment margins, efficiency ratio " +
        "and the like), plus gross, operating, net and free-cash-flow margin calculated here from the " +
        "period's own revenue and profit figures, each labeled as calculated and showing its formula and " +
        "the exact fields used, so it can be checked. A margin is calculated only when both figures are in " +
        "the same period of the same record; nothing is estimated. Returns every period in the latest " +
        "record by default, or the periods you name with `period`.",
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
          for (const [name, num, den] of pairs) {
            const nd = figureById(num)!;
            const dd = figureById(den)!;
            const n = resolveFigure(p, nd, headlineField(d, nd)).primary;
            const q = resolveFigure(p, dd, headlineField(d, dd)).primary;
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
              "stored_in_record values are the record's own; calculated_here values are numerator / " +
              "denominator from the same period, rounded to one decimal. A bank's revenue is net of " +
              "interest expense, so its margins are not comparable with an industrial company's.",
            periods: rows,
          },
          sel.primary.url,
        );
      }),
  );
}

