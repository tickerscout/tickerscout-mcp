import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { jsonResult } from "../respond.ts";
import { sourceUrl } from "../upstream.ts";
import { loadTickers } from "../tickers.ts";
import type { FinancialsDoc } from "../financials.ts";
import { parsePeriodSpec, periodHeader, periodPath, PERIOD_SYNTAX, PeriodNotAvailable, spansHistory, type Period } from "../periods.ts";
import { companyFrom, resolveCompany, selectForCompany, type PeriodSelection } from "../records.ts";
import {
  FIGURES,
  currencyPrefix,
  display,
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
import { PERIOD, READ_ONLY, SOURCE_NOTE, TICKER, UNITS_NOTE, guard, unitsHeader } from "./shared.ts";

export const KIND_WORDS: Record<string, string> = {
  money: "dollars",
  per_share: "dollars per share",
  shares: "shares",
  percent: "percent",
};

function docsOf(sel: PeriodSelection): Map<string, FinancialsDoc> {
  return new Map(sel.records.map((r) => [r.tag, r.doc]));
}

function figureBlock(sel: PeriodSelection, def: FigureDef) {
  const { values, missing } = figureRows(sel.primary.doc, sel.periods, def, docsOf(sel));
  const names = [...new Set(values.map((v) => v.name_in_record as string))];
  return {
    standard_figure: def.id,
    // What this company's record actually calls it. Pass any of these names to
    // get_figure to ask for exactly that field.
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

/** A standard figure named by its id, label or one of its synonyms, not by a record field name. */
function standardByWords(input: string): FigureDef | undefined {
  const def = findStandardFigure(input);
  if (!def) return undefined;
  const q = normName(input);
  return [def.id, def.label, ...def.synonyms].some((w) => normName(w) === q) ? def : undefined;
}

/** Every field whose path or own name is the query, compared without case or punctuation. */
function sameNamed(periods: Period[], query: string): string[] {
  const nq = normName(stripPeriodPrefix(query.trim()));
  const all = [...new Set(periods.flatMap((p) => flattenPeriod(p).map((f) => f.path)))];
  return all.filter((path) => normName(path) === nq || normName(nameOf(path)) === nq);
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
/**
 * Resolve any figure request: a standard figure by its generic words, then an exact path or
 * name from the record, then a standard figure by one of its field names, then fields
 * containing the words.
 */
function answerFigure(sel: PeriodSelection, figure: string): Record<string, unknown> {
  // A standard figure asked for by its generic words ('revenue', 'net income', 'free cash
  // flow', 'eps') is answered the standard way: the company's headline field first, then the
  // names that figure goes by, period by period, each value under the record's own name and
  // path. The words can also be a field name in the record (NVIDIA's income_statement.revenue,
  // and reportable_segments.Graphics.revenue beside it; a year-to-date block's period-level
  // net_income), so every same-named field the answer did not use is listed by path, callable
  // exactly as written.
  const generic = standardByWords(figure);
  const isPath = stripPeriodPrefix(figure.trim()).includes(".");
  if (generic && !isPath) {
    const block = figureBlock(sel, generic);
    const named = sameNamed(sel.periods, figure);
    if (block.values.length || !named.length) {
      const used = new Set(block.values.map((v) => v.field as string));
      const others = named.filter((path) => !used.has(path));
      return { matched_as: "standard figure", ...block, ...(others.length ? { other_fields_with_this_name: others } : {}) };
    }
  }
  // A path, or a name the company's own record uses ('total_net_sales',
  // 'net_income_attributable_to_walmart', 'Data Center'), is answered with exactly that field.
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
        "list_company_figures lists every field this company reports, by the name its record uses (pass " +
        "it a query to search them); guide lists the standard figures every company is searched for.",
    );
  }
  const capped = paths.slice(0, 15);
  return {
    matched_as: "words in field names",
    ...(paths.length > capped.length ? { note: `${paths.length} fields matched; the first 15 are shown. Narrow the query or use an exact name.` } : {}),
    figures: fieldBlocks(sel, capped),
  };
}


type Row = Record<string, unknown>;

/** A history: oldest first, split into annual and quarterly series. Empty series are left out. */
function series(rows: Row[]): Record<string, Row[]> {
  const asc = [...rows].sort((a, b) => String(a.period_end).localeCompare(String(b.period_end)));
  const out: Record<string, Row[]> = {
    annual: asc.filter((r) => r.kind === "annual"),
    quarterly: asc.filter((r) => r.kind === "quarter"),
    year_to_date_and_trailing: asc.filter((r) => r.kind !== "annual" && r.kind !== "quarter"),
  };
  for (const k of Object.keys(out)) if (!out[k].length) delete out[k];
  return out;
}

/** The same answer, reshaped as a history. */
function asHistory(answer: Row): Row {
  if (Array.isArray(answer.values)) {
    const { values, ...rest } = answer;
    return { ...rest, history: series(values as Row[]) };
  }
  return {
    ...answer,
    figures: (answer.figures as { name_in_record: string; field: string; values: Row[] }[]).map((f) => ({
      name_in_record: f.name_in_record,
      field: f.field,
      history: series(f.values),
    })),
  };
}

const STANDARD_IDS = FIGURES.map((f) => f.id).join(", ");

const FIGURE_ARG = z
  .union([z.string(), z.array(z.string()).min(1).max(10)])
  .describe(
    "A standard figure name or synonym ('revenue', 'net income', 'eps', 'capex', 'fcf'), a field name or " +
      "path from the record ('total_net_sales', 'reportable_segments.Compute & Networking.revenue'), or " +
      "words. Pass a list of up to ten to get several figures in one call.",
  );

export function registerFigureTools(server: McpServer) {
  server.registerTool(
    "get_figure",
    {
      title: "Any figure, any period",
      description:
        "Get any figure for a company: revenue, net income, EPS, free cash flow, debt, a segment's revenue, " +
        "a bank's CET1 ratio, a KPI. Pass a standard name or synonym and it returns the field this " +
        "company uses for it, named; pass a field name or path from the record and it returns exactly that " +
        "field; otherwise fields whose names contain all the words. Case, spaces and underscores do not " +
        "matter. Standard figures: " + STANDARD_IDS + ". Every value leads with its name_in_record and " +
        "json_path, so what is returned is never relabeled, and carries its dates, form and accession. " +
        `${SOURCE_NOTE} Default: every period in the latest record. \`period\` narrows to a fiscal year, ` +
        "quarter, 'ttm', 'ytd' or 'latest', searching older records; period='all' returns the full " +
        "history held, oldest first, as annual and quarterly series (the newer record's value wins where " +
        `two hold the same period, because it carries any restatement). ${UNITS_NOTE} When nothing ` +
        "matches, the error names the closest fields; list_company_figures lists every field by name.",
      inputSchema: z.object({ ticker: TICKER, figure: FIGURE_ARG, period: PERIOD }),
      annotations: READ_ONLY,
    },
    async ({ ticker, figure, period }) =>
      guard(async () => {
        const c = await resolveCompany(ticker);
        const sel = await selectForCompany(c, period);
        const history = spansHistory(parsePeriodSpec(period));
        const one = (f: string) => {
          const answer = answerFigure(sel, f);
          return history ? asHistory(answer) : answer;
        };
        const head = envelope(c, sel, period);
        if (!Array.isArray(figure)) return jsonResult({ ...head, requested_figure: figure, ...one(figure) }, sel.primary.url);
        // Several figures: one that does not match gets its own error row rather than failing the call.
        const results = figure.map((f) => {
          try {
            return { requested_figure: f, ...one(f) };
          } catch (err) {
            return { requested_figure: f, error: err instanceof Error ? err.message : String(err) };
          }
        });
        return jsonResult({ ...head, results }, sel.primary.url);
      }),
  );

  server.registerTool(
    "list_company_figures",
    {
      title: "Every figure a company reports, by its own names",
      description:
        "Discover which figures a company's record holds and what it calls them. Without `query`: " +
        "standard_figures maps each standard figure (revenue, net income, EPS, cash, debt and the rest) to " +
        "the name THIS company's record gives it (Apple's revenue is total_net_sales, JPMorgan's is " +
        "total_net_revenue), and other_figures holds every remaining figure grouped by its statement or " +
        "table (segments, revenue_by_* breakdowns, key metrics, bank and insurance tables, non-GAAP " +
        "measures), keyed by path, with its values. With `query`: only the fields whose names contain " +
        "every word ('data center', 'cet1', 'comparable sales', 'backlog', 'subscribers'), plus the " +
        "standard figure the words name, if any. Every name and path returned can be passed to get_figure " +
        "exactly as written. `block` limits to one table. A listing defaults to the latest fiscal year and " +
        "latest quarter, a search to every period in the latest record; pass `period` for others.",
      inputSchema: z.object({
        ticker: TICKER,
        query: z.string().optional().describe("Words to find in field names, e.g. 'data center revenue'. Omit to list everything."),
        block: z.string().optional().describe("Only this table, e.g. income_statement, reportable_segments, key_metrics."),
        period: PERIOD,
      }),
      annotations: READ_ONLY,
    },
    async ({ ticker, query, block, period }) =>
      guard(async () => {
        const c = await resolveCompany(ticker);
        const sel = await selectForCompany(c, period);
        if (!period && !query?.trim()) {
          // Listing everything defaults to the latest fiscal year and the latest quarter: every
          // name a company uses appears in one of them, at a fraction of the size of every period.
          // A search keeps every period in the latest record, so a field only a year-to-date or
          // comparative column carries is still found.
          const q = sel.periods.find((p) => p.kind === "quarter");
          const a = sel.periods.find((p) => p.kind === "annual");
          sel.periods = [q, a].filter((p): p is (typeof sel.periods)[number] => Boolean(p));
        }
        const inBlock = (path: string) => !block || path.startsWith(`${block}.`) || (block === "period_level" && !path.includes("."));

        if (query?.trim()) {
          const std = findStandardFigure(query);
          const exact = exactFields(sel.periods, query).paths;
          const paths = [...new Set([...exact, ...fieldsWithWords(sel.periods, query)])].filter(inBlock);
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
              ...(paths.length > 40 ? { note: `${paths.length} fields matched; the first 40 are shown. Narrow the query.` } : {}),
              ...(!paths.length && !std ? { note: "No field name contains every word. Try fewer words, or omit query to list every figure." } : {}),
            },
            sel.primary.url,
          );
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
              "Pass any name_in_record, field or other_figures key to get_figure exactly as written, e.g. " +
              "get_figure(ticker, 'total_net_sales') or get_figure(ticker, 'revenue_by_market_platform.Data Center').",
            standard_figures: standard,
            other_figure_count: otherCount,
            other_figures: other,
          },
          sel.primary.url,
        );
      }),
  );

  server.registerTool(
    "compare_companies",
    {
      title: "Compare a figure across companies",
      description:
        "One standard figure for two to ten companies side by side: revenue, net income, EPS, operating " +
        "income, free cash flow, debt, cash, equity or any other standard figure listed in get_figure. " +
        "Defaults to each company's latest discrete period (its latest quarter, or its latest fiscal year " +
        "if that is newer); pass period='latest annual', 'ttm', 'latest quarter' or a fiscal year. Fiscal " +
        "calendars differ between companies, so each row states its own period and dates, and the field " +
        "it was read from; a company that does not report the figure, or the period, gets a row saying so " +
        `rather than failing the call. ${UNITS_NOTE}`,
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
              `name things differently. Standard figures: ${STANDARD_IDS}.`,
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
}
