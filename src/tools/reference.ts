import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { jsonResult } from "../respond.ts";
import { sourceUrl } from "../upstream.ts";
import { loadTickers } from "../tickers.ts";
import { metaHeader } from "../financials.ts";
import { periodsOf, PERIOD_SYNTAX } from "../periods.ts";
import {
  loadAllRecords,
  loadLatestFinancials,
  loadManifest,
  loadMarkdown,
  loadRecord,
  resolveCompany,
  type Company,
} from "../records.ts";
import { AccessionIndex, normalizeAccession, passagesCiting } from "../filings.ts";
import { FIGURES, headlineField, resolveFigure } from "../figures.ts";
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
  // ---- Sources and filings -------------------------------------------------

  server.registerTool(
    "get_source_filings",
    {
      title: "SEC filings the record is built from",
      description:
        "The SEC filings behind a company's record: the annual report (10-K, or 20-F/40-F for a foreign " +
        "issuer) and the latest quarterly report (10-Q, or 6-K), each with its form, its own fiscal year and " +
        "period end, the date it was filed, its accession number, a link to the document on sec.gov and how " +
        "its fiscal year was established; plus, for every period in the statements, which filing (form and " +
        "accession) its figures were read from, including any separate accession for cash flow, per-share or " +
        "non-GAAP figures taken from an earnings release; the sec.gov documents the figure links open; and " +
        "Ticker Scout's published files for the record. Pass `record` for an earlier record.",
      inputSchema: z.object({ ticker: TICKER, record: RECORD }),
      annotations: READ_ONLY,
    },
    async ({ ticker, record }) =>
      guard(async () => {
        const c = await resolveCompany(ticker);
        const tag = resolveRecordArg(c, record);
        const [r, m] = await Promise.all([tag ? loadRecord(c, tag) : loadLatestFinancials(c), loadManifest(c, tag)]);
        const per = periodsOf(r.doc, r.tag).map((p) => {
          const accessions: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(p.data)) {
            if (/accession|source_form|source_statement|source_exhibit|source_note|source_description|cash_flow_source|derived_from/.test(k) && typeof v !== "object") {
              accessions[k] = v;
            } else if (/accessions|derived_from|also_sourced_from/.test(k) && Array.isArray(v)) accessions[k] = v;
          }
          return { period: p.name, period_end: p.period_end, ...accessions };
        });
        return jsonResult(
          {
            ticker: c.ticker,
            company: c.company,
            cik: m.doc.cik,
            record: r.tag,
            source_filings: m.doc.source_filings ?? r.doc.source_filings ?? null,
            latest_filing: m.doc.fiscal_period,
            sources_by_period: per,
            record_level_sources: r.doc.sources ?? null,
            // The sec.gov documents the figure links open, and how a link is built.
            sec_documents: obj(r.doc.figure_sources).documents ?? null,
            how_figure_links_work: obj(r.doc.figure_sources).about ?? null,
            published_files: m.doc.files ?? null,
          },
          m.url,
        );
      }),
  );

  server.registerTool(
    "get_accession_numbers",
    {
      title: "Every SEC accession number cited",
      description:
        "Every SEC accession number a company's record cites, across the financial statements, the 10-K/10-Q " +
        "narrative and the 8-K events digest, newest first. For each: the form (10-K, 10-Q, 8-K, 20-F, 6-K, " +
        "DEF 14A...), the filing date where stated, the EDGAR filing index URL, the document URL where known, " +
        "and every use - which periods' figures came from it, which narrative or events sections cite it. An " +
        "accession number (0001045810-26-000075 = filer CIK 0001045810, year 2026, sequence 75) is the SEC's " +
        "permanent ID for one filing, the thing to cite. Use get_filing for everything about one of them.",
      inputSchema: z.object({ ticker: TICKER, record: RECORD }),
      annotations: READ_ONLY,
    },
    async ({ ticker, record }) =>
      guard(async () => {
        const c = await resolveCompany(ticker);
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
          { ticker: c.ticker, company: c.company, cik: m.doc.cik, record: r.tag, count: list.length, accessions: list },
          m.url,
        );
      }),
  );

  server.registerTool(
    "get_filing",
    {
      title: "Everything about one SEC filing",
      description:
        "Look up one SEC filing by accession number (with or without dashes) within a company's record: its " +
        "form, filing date, EDGAR index and document links, which fiscal periods' figures were read from it, " +
        "and the full text of every narrative and events passage that cites it - for example what an 8-K " +
        "announced, or which quarter a 10-Q reported. Searches every published record when `record` is omitted.",
      inputSchema: z.object({
        ticker: TICKER,
        accession: z.string().describe("SEC accession number, e.g. 0001045810-26-000073 or 000104581026000073."),
        record: RECORD,
      }),
      annotations: READ_ONLY,
    },
    async ({ ticker, accession, record }) =>
      guard(async () => {
        const acc = normalizeAccession(accession);
        if (!acc) throw new Error(`"${accession}" is not an SEC accession number. The form is 0001045810-26-000073 (10 digits, 2, 6).`);
        const c = await resolveCompany(ticker);
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
              message: `${acc} is not cited anywhere in ${c.ticker}'s published records (${tags.join(", ")}). get_accession_numbers lists every accession that is.`,
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

  // ---- Units, currency and conventions ------------------------------------

  server.registerTool(
    "get_reporting_conventions",
    {
      title: "Units, schema and conventions",
      description:
        "How to read a company's numbers before using them: the units statement (actual dollars, not " +
        "millions), reporting currency and whether figures were converted to US dollars, the business type " +
        "and statement template the record uses and why, the fiscal-year convention, sign conventions, the " +
        "accounting basis (US GAAP, IFRS), share-count notes, and any definitions the record gives for its " +
        `own line items and segments. ${UNITS_NOTE}`,
      inputSchema: z.object({ ticker: TICKER, record: RECORD }),
      annotations: READ_ONLY,
    },
    async ({ ticker, record }) =>
      guard(async () => {
        const c = await resolveCompany(ticker);
        const r = await recordDoc(c, record);
        const meta = metaHeader(r.doc);
        delete meta.company_details;
        delete meta.next_filing;
        const bases = new Set<string>();
        for (const p of periodsOf(r.doc, r.tag)) {
          for (const k of ["accounting_basis", "basis", "presentation_basis"]) {
            if (typeof p.data[k] === "string") bases.add(`${p.name}: ${p.data[k]}`);
          }
        }
        const defs: Record<string, unknown> = {};
        for (const k of ["definitions", "line_item_definitions", "segment_definitions", "adjustments"]) if (r.doc[k]) defs[k] = r.doc[k];
        return jsonResult(
          { ticker: c.ticker, record: r.tag, ...meta, accounting_basis_by_period: [...bases], ...defs },
          r.url,
        );
      }),
  );

  server.registerTool(
    "get_fiscal_calendar",
    {
      title: "Fiscal calendar",
      description:
        "A company's fiscal calendar: when its fiscal year ends, whether it runs 52/53-week years, any " +
        "calendar note the record carries, and the exact start date, end date and length in days (and weeks, " +
        "where the record states them) of every fiscal year and quarter held across every published record. " +
        "Use it to line a company's fiscal periods up against calendar dates or against another company: " +
        "NVIDIA's fiscal year ends in late January, Apple's in late September, Microsoft's on June 30.",
      inputSchema: z.object({ ticker: TICKER }),
      annotations: READ_ONLY,
    },
    async ({ ticker }) =>
      guard(async () => {
        const c = await resolveCompany(ticker);
        const records = await loadAllRecords(c);
        const fp = obj(records[0].doc.fiscal_period);
        const seen = new Set<string>();
        const rows = records
          .flatMap((r) => periodsOf(r.doc, r.tag))
          .filter((p) => p.kind === "annual" || p.kind === "quarter")
          .filter((p) => {
            const k = `${p.kind}${p.period_end}`;
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          })
          .sort((a, b) => (a.period_end ?? "").localeCompare(b.period_end ?? ""))
          .map((p) => {
            const days = p.period_start && p.period_end ? Math.round((Date.parse(p.period_end) - Date.parse(p.period_start)) / 86_400_000) + 1 : null;
            const weeks = p.data.weeks_in_period ?? p.data.weeks_in_year ?? p.data.fiscal_year_weeks ?? p.data.weeks ?? null;
            return { period: p.name, kind: p.kind, period_start: p.period_start, period_end: p.period_end, length_days: days, ...(weeks ? { weeks } : {}) };
          });
        const annualDays = rows.filter((r) => r.kind === "annual").map((r) => r.length_days ?? 0);
        const weekBased = annualDays.some((d) => d === 364 || d === 371);
        return jsonResult(
          {
            ticker: c.ticker,
            company: c.company,
            fiscal_year_end: fp.fiscal_year_end ?? null,
            fiscal_year_end_words: fyeWords(fp.fiscal_year_end),
            fiscal_year_convention: records[0].doc.fiscal_year_convention ?? null,
            calendar_note: records[0].doc.fiscal_calendar_note ?? null,
            week_based_years: weekBased
              ? "Yes: fiscal years of 364 or 371 days indicate a 52/53-week calendar ending on a set weekday."
              : "No 52/53-week year detected in the periods held.",
            periods: rows,
          },
          records[0].url,
        );
      }),
  );

  server.registerTool(
    "get_currency_conversion",
    {
      title: "Currency and exchange rates",
      description:
        "The currency a company reports in and how its figures were put into US dollars. For a US-dollar " +
        "filer this says so and that no conversion was applied. For a foreign issuer (for example TSMC, which " +
        "reports in New Taiwan dollars) it returns the conversion policy and, for every period, the exact " +
        "rate used - the average rate for income statement and cash flow figures, the closing rate on the " +
        "balance-sheet date for balance-sheet figures - each with its source: the rate the filing itself " +
        "states where one exists, otherwise the Federal Reserve H.10 series, with the document and accession " +
        "named. Rates are stated as foreign currency per US dollar.",
      inputSchema: z.object({ ticker: TICKER, record: RECORD }),
      annotations: READ_ONLY,
    },
    async ({ ticker, record }) =>
      guard(async () => {
        const c = await resolveCompany(ticker);
        const r = await recordDoc(c, record);
        const adj = obj(r.doc.adjustments);
        const rates = periodsOf(r.doc, r.tag)
          .filter((p) => p.data.conversion)
          .map((p) => ({ period: p.name, period_start: p.period_start, period_end: p.period_end, conversion: p.data.conversion }));
        const converted = r.doc.converted_to_usd === true;
        return jsonResult(
          {
            ticker: c.ticker,
            company: c.company,
            record: r.tag,
            reporting_currency: r.doc.reporting_currency,
            converted_to_usd: converted,
            summary: converted
              ? `${c.company} reports in ${r.doc.reporting_currency}. Every money figure Ticker Scout publishes for it is converted to US dollars at the rate recorded for its period below.`
              : `${c.company} reports in ${r.doc.reporting_currency}. No currency conversion is applied.`,
            policy: adj.fx ?? null,
            units: r.doc.units,
            rates_by_period: rates,
          },
          r.url,
        );
      }),
  );

  server.registerTool(
    "get_adr_details",
    {
      title: "ADR / ADS ratio",
      description:
        "American Depositary Receipt details for a foreign issuer: how many ordinary shares one American " +
        "Depositary Share represents (the ADR ratio, e.g. 5 for TSMC), the basis on which per-share figures " +
        "are published (per ADS, in US dollars), the ratio recorded on each period, and which share counts " +
        "stay in ordinary shares. For a company with no ADR program it says so: its per-share figures are " +
        "per ordinary share as filed.",
      inputSchema: z.object({ ticker: TICKER, record: RECORD }),
      annotations: READ_ONLY,
    },
    async ({ ticker, record }) =>
      guard(async () => {
        const c = await resolveCompany(ticker);
        const r = await recordDoc(c, record);
        const adj = obj(r.doc.adjustments);
        const ratio = adj.adr_ratio ?? null;
        const per = periodsOf(r.doc, r.tag)
          .map((p) => ({ period: p.name, ads_ratio: obj(p.data.conversion).ads_ratio ?? p.data.ads_ratio ?? null }))
          .filter((x) => x.ads_ratio !== null);
        return jsonResult(
          {
            ticker: c.ticker,
            company: c.company,
            is_adr: ratio !== null && ratio !== undefined,
            adr_ratio: ratio,
            meaning: ratio ? `One American Depositary Share represents ${ratio} ordinary shares.` : `${c.ticker} has no ADR ratio in its record: its shares trade directly, and per-share figures are per ordinary share as filed.`,
            per_share_basis: adj.per_share_basis ?? null,
            units: r.doc.units,
            ratio_by_period: per,
          },
          r.url,
        );
      }),
  );

  server.registerTool(
    "get_stock_splits",
    {
      title: "Stock splits and share adjustments",
      description:
        "Stock splits a company's record has adjusted for: every split applied (ratio and date), which figures " +
        "were restated for it, and any as-reported pre-split values the record keeps alongside. Per-share " +
        "figures and share counts Ticker Scout publishes are split-adjusted, so periods before and after a " +
        "split compare directly. Also returns the record's notes that mention a split.",
      inputSchema: z.object({ ticker: TICKER, record: RECORD }),
      annotations: READ_ONLY,
    },
    async ({ ticker, record }) =>
      guard(async () => {
        const c = await resolveCompany(ticker);
        const r = await recordDoc(c, record);
        const adj = obj(r.doc.adjustments);
        const splits = Array.isArray(adj.splits_applied) ? adj.splits_applied : [];
        const preSplit: Record<string, unknown>[] = [];
        for (const p of periodsOf(r.doc, r.tag)) {
          for (const [b, v] of Object.entries(p.data)) {
            for (const [k, x] of Object.entries(obj(v))) if (/pre_split|as_reported/.test(k)) preSplit.push({ period: p.name, field: `${b}.${k}`, value: x });
          }
        }
        const notes = (Array.isArray(r.doc.notes) ? r.doc.notes : []).filter((n) => /split/i.test(String(n)));
        return jsonResult(
          {
            ticker: c.ticker,
            company: c.company,
            record: r.tag,
            splits_applied: splits,
            summary: splits.length ? `${splits.length} split(s) applied; per-share figures and share counts are adjusted.` : "No stock split falls within the periods held, so no split adjustment was needed.",
            pro_forma_split_adjusted: r.doc.pro_forma_split_adjusted ?? null,
            as_reported_pre_split_values: preSplit,
            notes_mentioning_splits: notes,
          },
          r.url,
        );
      }),
  );

  server.registerTool(
    "get_data_notes",
    {
      title: "Sourcing notes",
      description:
        "The record's own sourcing notes: how the business type and statement template were chosen, which " +
        "filing each statement was read from, how a discrete quarter was derived, what was reclassified or " +
        "restated, and any period-level notes on balance sheet or cash flow coverage. Read these before " +
        "relying on an unusual figure; they are the record's explanation of itself.",
      inputSchema: z.object({ ticker: TICKER, record: RECORD }),
      annotations: READ_ONLY,
    },
    async ({ ticker, record }) =>
      guard(async () => {
        const c = await resolveCompany(ticker);
        const r = await recordDoc(c, record);
        const periodNotes = periodsOf(r.doc, r.tag)
          .map((p) => ({
            period: p.name,
            ...Object.fromEntries(Object.entries(p.data).filter(([k, v]) => typeof v === "string" && /note|derivation|basis|source_description|coverage/.test(k))),
          }))
          .filter((x) => Object.keys(x).length > 1);
        return jsonResult({ ticker: c.ticker, record: r.tag, notes: r.doc.notes ?? [], period_notes: periodNotes }, r.url);
      }),
  );

  server.registerTool(
    "get_data_gaps",
    {
      title: "What is not disclosed",
      description:
        "What a company's record does not contain, and why: the record's own list of uncertainties (figures " +
        "the filings do not disclose, periods presented only year to date, items that could not be " +
        "reconciled), period-level notes on statements not reported, and which standard figures (revenue, " +
        "operating income, capex, and the rest of list_standard_figures) are absent from the latest fiscal " +
        "year and quarter. Where a filing does not disclose a figure it is omitted and the omission explained, " +
        "never zeroed.",
      inputSchema: z.object({ ticker: TICKER, record: RECORD }),
      annotations: READ_ONLY,
    },
    async ({ ticker, record }) =>
      guard(async () => {
        const c = await resolveCompany(ticker);
        const r = await recordDoc(c, record);
        const ps = periodsOf(r.doc, r.tag);
        const latest = [ps.find((p) => p.kind === "annual"), ps.find((p) => p.kind === "quarter")].filter(Boolean) as typeof ps;
        const missing = latest.map((p) => ({
          period: p.name,
          standard_figures_not_reported: FIGURES.filter((f) => !resolveFigure(p, f, headlineField(r.doc, f)).primary).map((f) => f.id),
          statements_not_recorded: ["income_statement", "balance_sheet", "cash_flow"].filter((b) => !p.data[b]),
        }));
        const notReported = ps
          .map((p) => ({
            period: p.name,
            ...Object.fromEntries(Object.entries(p.data).filter(([k]) => /not_reported|availability|coverage_note/.test(k))),
          }))
          .filter((x) => Object.keys(x).length > 1);
        return jsonResult(
          {
            ticker: c.ticker,
            record: r.tag,
            uncertainties: r.doc.uncertainties ?? [],
            period_notes: notReported,
            latest_periods: missing,
            note: "A standard figure listed as not reported may exist under a company-specific name; find_figures searches for it.",
          },
          r.url,
        );
      }),
  );

  server.registerTool(
    "get_headline_summary",
    {
      title: "Headline summary and Q&A",
      description:
        "The record's written headline for its latest period: a one-paragraph summary of the quarter or year " +
        "in plain sentences with exact figures and year-over-year changes, the question-and-answer pairs " +
        "built from it ('How much revenue did NVIDIA report in Q2 FY2027?'), and the headline metrics with " +
        "their prior-period values and the exact field and accession each was read from. Every figure in it is " +
        "reconciled against the record. Pass `record` for an earlier period's headline.",
      inputSchema: z.object({ ticker: TICKER, record: RECORD }),
      annotations: READ_ONLY,
    },
    async ({ ticker, record }) =>
      guard(async () => {
        const c = await resolveCompany(ticker);
        const r = await recordDoc(c, record);
        const h = obj(r.doc.headline);
        if (!Object.keys(h).length) throw new Error(`${c.ticker}'s record ${r.tag} has no headline block. get_key_figures and get_financials still work.`);
        const metrics = (Array.isArray(h.metrics) ? h.metrics : []).map((m) => {
          const x = obj(m);
          const s = obj(x.source);
          return {
            label: x.label,
            value: x.value,
            text: x.text,
            exact: x.exact,
            prior: x.prior,
            yoy: x.yoy,
            field: s.array && s.field ? `${s.array}[${s.index}].${s.field}` : s.field,
            period_label: s.period_label,
            prior_period_label: s.prior_period_label,
            accession: s.source_accession,
          };
        });
        return jsonResult(
          { ticker: c.ticker, company: c.company, record: r.tag, period: h.period, period_end: h.period_end_words, summary: h.summary, qa: h.qa, metrics },
          r.url,
        );
      }),
  );

  // ---- Filing schedule and coverage ---------------------------------------

  server.registerTool(
    "get_next_filing",
    {
      title: "Next expected SEC filing",
      description:
        "When a company is expected to file next with the SEC, and what: the predicted date and form (10-Q or " +
        "10-K; 6-K or 20-F for a foreign issuer), alongside the latest period held, when that filing was made, " +
        "and the filing dates of the reports the record is built from. The date is a prediction from the " +
        "company's own filing history, not an announced date, and a filing date is not an earnings date: " +
        "most companies release earnings on an 8-K days or weeks before the 10-Q or 10-K is filed.",
      inputSchema: z.object({ ticker: TICKER }),
      annotations: READ_ONLY,
    },
    async ({ ticker }) =>
      guard(async () => {
        const c = await resolveCompany(ticker);
        const m = await loadManifest(c);
        const sf = Array.isArray(m.doc.source_filings) ? (m.doc.source_filings as Record<string, unknown>[]) : [];
        return jsonResult(
          {
            ticker: c.ticker,
            company: c.company,
            next_expected_filing: c.entry.next_expected_filing ?? m.doc.next_filing ?? null,
            latest_period_held: c.entry.latest_period,
            latest_period_end: c.entry.period_end,
            latest_form: c.entry.latest_form,
            filed: sf.map((f) => ({ form: f.form, period_end: f.period_end, filed: f.filed, accession: f.accession })),
            note: "Predicted from filing history, not announced. A 10-Q or 10-K is usually filed after the earnings release (an 8-K).",
          },
          m.url,
        );
      }),
  );

  server.registerTool(
    "list_upcoming_filings",
    {
      title: "Upcoming SEC filings across coverage",
      description:
        "Every covered company expected to file a 10-Q or 10-K (or 6-K / 20-F) within the next N days, " +
        "soonest first, with the predicted date and form and the period currently held. Use it to see whose " +
        "data refreshes soon. Dates are predictions from each company's filing history, not announced dates. " +
        "Filter by form with `form`.",
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
    "get_coverage_summary",
    {
      title: "Coverage summary",
      description:
        "What Ticker Scout covers as a whole: how many companies, when the data was last updated, how many " +
        "hold each latest form (10-Q, 10-K, 6-K, 20-F), which are foreign issuers, how many published " +
        "records each company has and the earliest record held, the URL patterns for every file, and what " +
        "is deliberately not covered (no market prices, no estimates, no analyst data).",
      inputSchema: z.object({}),
      annotations: READ_ONLY,
    },
    async () =>
      guard(async () => {
        const file = await loadTickers();
        const all = file.tickers as (typeof file.tickers[number] & { periods?: string[]; period_count?: number; earliest_period?: string })[];
        const byForm: Record<string, number> = {};
        for (const e of all) byForm[e.latest_form ?? "unknown"] = (byForm[e.latest_form ?? "unknown"] ?? 0) + 1;
        const recordCounts: Record<string, number> = {};
        for (const e of all) {
          const n = String(e.period_count ?? e.periods?.length ?? 1);
          recordCounts[n] = (recordCounts[n] ?? 0) + 1;
        }
        const raw = file as unknown as Record<string, unknown>;
        return jsonResult(
          {
            companies: file.ticker_count,
            data_updated: file.updated,
            description: file.description,
            latest_form_counts: byForm,
            foreign_issuers: all.filter((e) => /20-F|40-F|6-K/.test(e.latest_form ?? "")).map((e) => `${e.ticker} (${e.company})`),
            companies_by_number_of_records: recordCounts,
            url_patterns: raw.url_pattern,
            not_covered: "No market prices, quotes or market capitalization; no analyst estimates; no figures that are not in a company's own SEC filings.",
            units: UNITS_NOTE,
          },
          sourceUrl("/tickers.json"),
        );
      }),
  );

  server.registerTool(
    "guide",
    {
      title: "How to use these tools",
      description:
        "Start here if unsure. How Ticker Scout's tools fit together: what a record is versus a period, the " +
        "period syntax every period argument accepts, units and currency, how figures are cited and linked to " +
        "sec.gov, what to call for common questions, and the full map of tools grouped by what they answer. " +
        "No arguments.",
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
            citations:
              "Every value carries its source accession; get_figure_source and the figure tools give a sec.gov link " +
              "that opens the filing at the line printing the number. Cite the dated URL (e.g. " +
              "https://tickerscout.ai/nvda/fy27q2/financials.json), which never changes.",
            common_questions: {
              "How much did X earn last quarter?": "get_key_figures, or get_net_income / get_eps",
              "Revenue trend": "get_revenue (every period in the latest record) or get_figure_history(figure='revenue')",
              "A specific year or quarter": "get_period(period='FY2025') or any figure tool with period",
              "How far back does the data go?": "list_periods",
              "Compare companies": "compare_companies(tickers, figure)",
              "Segment or product revenue": "get_segments, get_revenue_breakdown, get_geographic_revenue",
              "A company-specific metric": "find_figures(query) then get_figure",
              "Risks, strategy, management discussion": "get_risk_factors, get_business_overview, get_annual_mdna, get_current_quarter",
              "What did the company announce?": "get_events or list_events, then get_earnings_releases etc.",
              "Find a topic in the filings": "search_sections then search_text",
              "Which filing did this come from?": "get_figure_source, get_accession_numbers, get_filing",
              "Foreign issuer currency": "get_currency_conversion, get_adr_details",
            },
            tools: TOOL_MAP,
          },
          sourceUrl("/llms.txt"),
        ),
      ),
  );
}

