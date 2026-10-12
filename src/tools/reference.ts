import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { jsonResult } from "../respond.ts";
import { sourceUrl } from "../upstream.ts";
import { loadTickers } from "../tickers.ts";
import { metaHeader } from "../financials.ts";
import { periodsOf, PERIOD_SYNTAX } from "../periods.ts";
import {
  loadLatestFinancials,
  loadManifest,
  loadMarkdown,
  loadRecord,
  resolveCompany,
  type Company,
} from "../records.ts";
import { AccessionIndex, normalizeAccession, passagesCiting } from "../filings.ts";
import { FIGURES, headlineField, resolveFigure } from "../figures.ts";
import { KIND_WORDS } from "./figures.ts";
import { TOOL_MAP } from "./core.ts";
import { READ_ONLY, RECORD, TICKER, UNITS_NOTE, guard, resolveRecordArg } from "./shared.ts";

async function recordDoc(c: Company, record: string | undefined) {
  const tag = resolveRecordArg(c, record);
  return tag ? loadRecord(c, tag) : loadLatestFinancials(c);
}

function obj(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function fyeWords(mmdd: unknown): string | null {
  if (typeof mmdd !== "string" || !/^\d{4}$/.test(mmdd)) return null;
  return `${MONTH_NAMES[Number(mmdd.slice(0, 2)) - 1]} ${Number(mmdd.slice(2))}`;
}

export function registerReferenceTools(server: McpServer) {
  server.registerTool(
    "get_filings",
    {
      title: "SEC filings and accession numbers",
      description:
        "The SEC filings behind a company's data. Without `accession`: every accession number the record " +
        "cites across the financial statements, the 10-K/10-Q narrative and the 8-K events digest, newest " +
        "first, each with its form (10-K, 10-Q, 8-K, 20-F, 6-K, DEF 14A...), filing date where stated, " +
        "EDGAR index URL, document URL where known and every use (which periods' figures came from it, " +
        "which narrative or events sections cite it); plus the annual and quarterly report the record is " +
        "built from. With `accession` (dashes optional): everything about that one filing, including the " +
        "full text of every narrative and events passage that cites it, e.g. what an 8-K announced; every " +
        "published record is searched unless `record` is given. An accession number (0001045810-26-000075 " +
        "= filer CIK 0001045810, year 2026, sequence 75) is the SEC's permanent ID for a filing, the " +
        "thing to cite. For the sec.gov line behind one figure, use get_figure.",
      inputSchema: z.object({
        ticker: TICKER,
        accession: z.string().optional().describe("One SEC accession number, e.g. 0001045810-26-000073. Omit to list them all."),
        record: RECORD,
      }),
      annotations: READ_ONLY,
    },
    async ({ ticker, accession, record }) =>
      guard(async () => {
        const c = await resolveCompany(ticker);
        if (!accession?.trim()) {
          const tag = resolveRecordArg(c, record);
          const [r, m, narr, ev] = await Promise.all([
            tag ? loadRecord(c, tag) : loadLatestFinancials(c),
            loadManifest(c, tag),
            loadMarkdown(c, "narrative", tag),
            loadMarkdown(c, "events", tag),
          ]);
          const idx = new AccessionIndex(String(m.doc.cik ?? r.doc.cik));
          idx.addSourceFilings(m.doc.source_filings);
          idx.addFinancials(r.doc, r.tag);
          idx.addMarkdown(narr.md, "narrative.md");
          idx.addMarkdown(ev.md, "events.md");
          const list = idx.list();
          return jsonResult(
            {
              ticker: c.ticker,
              company: c.company,
              cik: m.doc.cik,
              record: r.tag,
              source_filings: m.doc.source_filings ?? r.doc.source_filings ?? null,
              count: list.length,
              accessions: list,
            },
            m.url,
          );
        }

        const acc = normalizeAccession(accession);
        if (!acc) throw new Error(`"${accession}" is not an SEC accession number. The form is 0001045810-26-000073 (10 digits, 2, 6).`);
        const tag = resolveRecordArg(c, record);
        const tags = tag ? [tag] : (c.entry.periods ?? [c.entry.latest_period ?? ""]);
        const latest = c.entry.latest_period ?? tags[0];
        const results = await Promise.all(
          tags.map(async (t) => {
            const useTag = t === latest ? undefined : t;
            const [r, narr, ev] = await Promise.all([
              useTag ? loadRecord(c, useTag) : loadLatestFinancials(c),
              loadMarkdown(c, "narrative", useTag),
              loadMarkdown(c, "events", useTag),
            ]);
            return { r, narr, ev };
          }),
        );
        const idx = new AccessionIndex(String(c.entry.cik ?? ""));
        const passages: { document: string; section: string; text: string; record: string }[] = [];
        const periods: Record<string, unknown>[] = [];
        for (const { r, narr, ev } of results) {
          idx.addFinancials(r.doc, r.tag);
          idx.addMarkdown(narr.md, "narrative.md");
          idx.addMarkdown(ev.md, "events.md");
          for (const x of [...passagesCiting(narr.md, acc, "narrative.md"), ...passagesCiting(ev.md, acc, "events.md")]) {
            if (!passages.some((y) => y.text === x.text)) passages.push({ ...x, record: r.tag });
          }
          for (const p of periodsOf(r.doc, r.tag)) {
            const cites = Object.entries(p.data).filter(([k, v]) => /accession/.test(k) && String(Array.isArray(v) ? v.join(" ") : v).includes(acc));
            if (cites.length) periods.push({ period: p.name, period_end: p.period_end, record: r.tag, cited_as: cites.map(([k]) => k) });
          }
        }
        const found = idx.find(acc);
        if (!found && !passages.length) {
          return jsonResult(
            {
              ticker: c.ticker,
              accession: acc,
              available: false,
              message: `${acc} is not cited anywhere in ${c.ticker}'s published records (${tags.join(", ")}). get_filings without an accession lists every one that is.`,
            },
            sourceUrl(`/${c.dir}/index.json`),
          );
        }
        return jsonResult(
          { ticker: c.ticker, company: c.company, ...(found ?? { accession: acc }), periods_sourced_from_it: periods, passages_citing_it: passages },
          sourceUrl(`/${c.dir}/index.json`),
        );
      }),
  );

  server.registerTool(
    "get_reporting_conventions",
    {
      title: "Units, currency, ADR, splits and fiscal calendar",
      description:
        "How to read a company's numbers before comparing or converting them: the units statement (actual " +
        "dollars, not millions), reporting currency and, for a foreign issuer such as TSMC, the conversion " +
        "policy and each period's exact exchange rate with its source (average rate for income and cash " +
        "flow, closing rate for the balance sheet, stated as foreign currency per US dollar); the ADR ratio " +
        "and per-share basis (per ADS for a foreign issuer that has one); stock splits adjusted for and any " +
        "as-reported pre-split values; the fiscal year end and convention; the business type and statement " +
        "template; the accounting basis (US GAAP, IFRS); and any definitions the record gives for its own " +
        `line items and segments. ${UNITS_NOTE} Every period's dates are in list_periods.`,
      inputSchema: z.object({ ticker: TICKER, record: RECORD }),
      annotations: READ_ONLY,
    },
    async ({ ticker, record }) =>
      guard(async () => {
        const c = await resolveCompany(ticker);
        const r = await recordDoc(c, record);
        const doc = r.doc;
        const ps = periodsOf(doc, r.tag);
        const meta = metaHeader(doc);
        delete meta.company_details;
        delete meta.next_filing;
        delete meta.fiscal_period;
        const adj = obj(doc.adjustments);
        const fp = obj(doc.fiscal_period);

        const converted = doc.converted_to_usd === true;
        const rates = ps
          .filter((p) => p.data.conversion)
          .map((p) => ({ period: p.name, period_start: p.period_start, period_end: p.period_end, conversion: p.data.conversion }));

        const ratio = adj.adr_ratio ?? null;
        const adsByPeriod = ps
          .map((p) => ({ period: p.name, ads_ratio: obj(p.data.conversion).ads_ratio ?? p.data.ads_ratio ?? null }))
          .filter((x) => x.ads_ratio !== null);

        const splits = Array.isArray(adj.splits_applied) ? adj.splits_applied : [];
        const preSplit: Record<string, unknown>[] = [];
        for (const p of ps) {
          for (const [b, v] of Object.entries(p.data)) {
            for (const [k, x] of Object.entries(obj(v))) if (/pre_split|as_reported/.test(k)) preSplit.push({ period: p.name, field: `${b}.${k}`, value: x });
          }
        }
        const splitNotes = (Array.isArray(doc.notes) ? doc.notes : []).filter((n) => /split/i.test(String(n)));

        const bases = new Set<string>();
        for (const p of ps) {
          for (const k of ["accounting_basis", "basis", "presentation_basis"]) {
            if (typeof p.data[k] === "string") bases.add(`${p.name}: ${p.data[k]}`);
          }
        }
        // The record's own adjustments block, whole: the FX policy, ADR ratio, splits applied and
        // the notes that explain them, in the record's words.
        const defs: Record<string, unknown> = {};
        for (const k of ["adjustments", "definitions", "line_item_definitions", "segment_definitions"]) if (doc[k]) defs[k] = doc[k];

        return jsonResult(
          {
            ticker: c.ticker,
            company: c.company,
            record: r.tag,
            ...meta,
            currency: {
              reporting_currency: doc.reporting_currency,
              converted_to_usd: converted,
              summary: converted
                ? `${c.company} reports in ${doc.reporting_currency}. Every money figure Ticker Scout publishes for it is converted to US dollars at the rate recorded for its period.`
                : `${c.company} reports in ${doc.reporting_currency}. No currency conversion is applied.`,
              ...(rates.length ? { rates_by_period: rates } : {}),
            },
            adr: ratio
              ? { meaning: `One American Depositary Share represents ${ratio} ordinary shares.`, ratio_by_period: adsByPeriod }
              : `${c.ticker} has no ADR ratio in its record: per-share figures are per ordinary share as filed.`,
            splits: {
              summary: splits.length
                ? `${splits.length} split(s) applied; per-share figures and share counts are adjusted, so periods before and after compare directly.`
                : "No stock split falls within the periods held, so no split adjustment was needed.",
              ...(doc.pro_forma_split_adjusted ? { pro_forma_split_adjusted: doc.pro_forma_split_adjusted } : {}),
              ...(preSplit.length ? { as_reported_pre_split_values: preSplit } : {}),
              ...(splitNotes.length ? { notes_mentioning_splits: splitNotes } : {}),
            },
            fiscal_calendar: {
              fiscal_year_end: fp.fiscal_year_end ?? null,
              fiscal_year_end_words: fyeWords(fp.fiscal_year_end),
            },
            accounting_basis_by_period: [...bases],
            ...defs,
          },
          r.url,
        );
      }),
  );

  server.registerTool(
    "get_data_notes",
    {
      title: "Sourcing notes and what is not disclosed",
      description:
        "The record's explanation of itself, to read before relying on an unusual figure or concluding " +
        "one is missing: its sourcing notes (how the statement template was chosen, which filing each " +
        "statement was read from, how a discrete quarter was derived, what was reclassified or restated), " +
        "period-level notes on coverage, its list of uncertainties (figures the filings do not disclose, " +
        "periods presented only year to date, items that could not be reconciled), and which standard " +
        "figures are absent from the latest fiscal year and quarter. Where a filing does not disclose a " +
        "figure it is omitted and the omission explained, never zeroed.",
      inputSchema: z.object({ ticker: TICKER, record: RECORD }),
      annotations: READ_ONLY,
    },
    async ({ ticker, record }) =>
      guard(async () => {
        const c = await resolveCompany(ticker);
        const r = await recordDoc(c, record);
        const ps = periodsOf(r.doc, r.tag);
        const periodNotes = ps
          .map((p) => ({
            period: p.name,
            ...Object.fromEntries(
              Object.entries(p.data).filter(
                ([k, v]) => typeof v === "string" && /note|derivation|basis|source_description|coverage|not_reported|availability/.test(k),
              ),
            ),
          }))
          .filter((x) => Object.keys(x).length > 1);
        const latest = [ps.find((p) => p.kind === "annual"), ps.find((p) => p.kind === "quarter")].filter(Boolean) as typeof ps;
        const missing = latest.map((p) => ({
          period: p.name,
          standard_figures_not_reported: FIGURES.filter((f) => !resolveFigure(p, f, headlineField(r.doc, f)).primary).map((f) => f.id),
          statements_not_recorded: ["income_statement", "balance_sheet", "cash_flow"].filter((b) => !p.data[b]),
        }));
        return jsonResult(
          {
            ticker: c.ticker,
            record: r.tag,
            notes: r.doc.notes ?? [],
            uncertainties: r.doc.uncertainties ?? [],
            period_notes: periodNotes,
            latest_periods: missing,
            note: "A standard figure listed as not reported may exist under a company-specific name; list_company_figures(query) searches for it.",
          },
          r.url,
        );
      }),
  );

  server.registerTool(
    "list_upcoming_filings",
    {
      title: "Upcoming SEC filings across coverage",
      description:
        "Every covered company expected to file a 10-Q or 10-K (or 6-K / 20-F) within the next N days, " +
        "soonest first, with the predicted date and form and the period currently held. Use it to see " +
        "whose data refreshes soon. Dates are predictions from each company's filing history, not " +
        "announced dates, and a filing date is not an earnings date: most companies release earnings on " +
        "an 8-K days or weeks before the 10-Q or 10-K. One company's next filing is in get_company.",
      inputSchema: z.object({
        days: z.number().int().min(1).max(366).optional().describe("Window in days from today. Default 30."),
        form: z.string().optional().describe("Only this form, e.g. 10-K or 10-Q."),
      }),
      annotations: READ_ONLY,
    },
    async ({ days, form }) =>
      guard(async () => {
        const file = await loadTickers();
        const today = new Date().toISOString().slice(0, 10);
        const end = new Date(Date.now() + (days ?? 30) * 86_400_000).toISOString().slice(0, 10);
        const rows = file.tickers
          .filter((e) => e.next_expected_filing && e.next_expected_filing.date >= today && e.next_expected_filing.date <= end)
          .filter((e) => !form || e.next_expected_filing!.type.toUpperCase() === form.trim().toUpperCase())
          .sort((a, b) => a.next_expected_filing!.date.localeCompare(b.next_expected_filing!.date))
          .map((e) => ({ ticker: e.ticker, company: e.company, expected: e.next_expected_filing!.date, form: e.next_expected_filing!.type, latest_period_held: e.latest_period }));
        return jsonResult({ from: today, to: end, count: rows.length, filings: rows }, sourceUrl("/tickers.json"));
      }),
  );

  server.registerTool(
    "guide",
    {
      title: "How to use these tools",
      description:
        "Start here if unsure. How Ticker Scout's tools fit together: what a record is versus a period, " +
        "the period syntax every period argument accepts, units and currency, how figures are cited and " +
        "linked to sec.gov, which tool answers common questions, and the standard figures (with the " +
        "words get_figure and compare_companies accept for each). No arguments.",
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    async () =>
      guard(async () =>
        jsonResult(
          {
            what_this_is:
              "Ticker Scout is an agent-native data layer for SEC filings: each company's income statement, balance " +
              "sheet and cash flow already assembled from its 10-K, 10-Q and 8-K (20-F and 6-K for a foreign issuer), " +
              "and the filings themselves read and synthesized. Nothing is estimated; every figure cites the SEC " +
              "accession it came from.",
            records_and_periods:
              "A RECORD is the snapshot built when a company filed one 10-Q or 10-K (tag FY27Q2, FY26). Each record " +
              "holds several PERIODS: up to three fiscal years, the latest quarter and its prior-year comparative, " +
              "year to date and trailing twelve months. Tools that take `period` search every record automatically; " +
              "tools that take `record` read one snapshot (the latest by default).",
            period_syntax: PERIOD_SYNTAX,
            out_of_range:
              "Asking for a period earlier than anything held returns a plain answer that the data does not go back " +
              "that far, with the list of periods held; a period not yet reported says so with the next expected filing.",
            units: UNITS_NOTE,
            names:
              "Companies name line items differently. Every figure comes back under the exact name its record uses " +
              "(Apple's revenue is total_net_sales), with its JSON path, and any such name can be passed to get_figure " +
              "as written. A standard figure name below resolves to the field this company uses for it.",
            citations:
              "Every value carries its source accession; get_figure gives a sec.gov link that opens the filing at the " +
              "line printing the number. Cite the dated URL (e.g. https://tickerscout.ai/nvda/fy27q2/financials.json), " +
              "which never changes.",
            common_questions: {
              "How did X do last quarter?": "get_key_figures",
              "One figure, or several": "get_figure(ticker, 'net income') or get_figure(ticker, ['revenue', 'eps', 'fcf'])",
              "A figure's trend": "get_figure(ticker, figure, period='all')",
              "A statement for a specific year or quarter": "get_statements(ticker, statement='income_statement', period='FY2025')",
              "TTM or year to date": "get_statements(ticker, period='ttm') or get_figure(ticker, figure, period='ttm')",
              "How far back does the data go?": "list_periods",
              "Compare companies": "compare_companies(tickers, figure)",
              "Segment, product or regional revenue": "get_segments",
              "KPIs, non-GAAP, bank or insurance metrics": "get_company_metrics",
              "Margins": "get_margins_and_ratios",
              "A company-specific metric": "list_company_figures(ticker, query='data center') then get_figure",
              "Risks, strategy, management discussion": "get_narrative(ticker, section='risk factors' | 'business' | 'md&a' | 'current quarter')",
              "What did the company announce?": "get_events, or get_events(ticker, section='earnings' | 'm&a' | 'management changes' ...)",
              "Find a topic in the filings": "search_text",
              "Which filing did this come from?": "get_figure (sec_link per value) or get_filings(ticker, accession)",
              "Foreign issuer currency, ADRs, splits": "get_reporting_conventions",
            },
            tools: TOOL_MAP,
            standard_figures: FIGURES.map((f) => ({ id: f.id, label: f.label, units: KIND_WORDS[f.kind], accepts: f.synonyms })),
          },
          sourceUrl("/llms.txt"),
        ),
      ),
  );
}
