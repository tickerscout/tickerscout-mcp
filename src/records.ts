import { fetchJson, fetchText, sourceUrl } from "./upstream.ts";
import { loadTickers, normalizeTicker, resolveTicker, type TickerEntry, type TickersFile } from "./tickers.ts";
import type { FinancialsDoc } from "./financials.ts";
import {
  namesOnePeriod,
  parsePeriodSpec,
  PeriodNotAvailable,
  periodsOf,
  selectPeriods,
  spansHistory,
  type Period,
  type PeriodSpec,
} from "./periods.ts";

/**
 * A covered company and the published records behind it.
 *
 * The undated files (/nvda/financials.json) always hold the latest record. Every record
 * is ALSO published at a permanent dated path (/nvda/fy27q1/financials.json), listed in
 * tickers.json as `periods`. History is read from those, never from anything stored here.
 */
export interface Company {
  ticker: string;
  company: string;
  /** Lowercase directory on tickerscout.ai, e.g. "brk-b". */
  dir: string;
  entry: TickerEntry & { periods?: string[] };
}

export async function resolveCompany(input: string): Promise<Company> {
  return companyFrom(await loadTickers(), input);
}

/** Resolve against an already-loaded tickers.json, for tools that look up several companies. */
export function companyFrom(file: TickersFile, input: string): Company {
  const entry = resolveTicker(file, input) as Company["entry"];
  return {
    ticker: entry.ticker,
    company: entry.company,
    dir: normalizeTicker(entry.ticker),
    entry,
  };
}

/** Fiscal tags of every published record, newest first, e.g. ["FY27Q2", "FY27Q1"]. */
export function recordTags(c: Company): string[] {
  const tags = c.entry.periods?.length ? c.entry.periods : [c.entry.latest_period ?? "latest"];
  return [...tags];
}

export function latestTag(c: Company): string {
  return c.entry.latest_period ?? recordTags(c)[0];
}

export function nextFilingText(c: Company): string | null {
  const n = c.entry.next_expected_filing;
  return n ? `${n.date} (${n.type})` : null;
}

export interface LoadedDoc {
  tag: string;
  path: string;
  url: string;
  doc: FinancialsDoc;
}

export async function loadLatestFinancials(c: Company): Promise<LoadedDoc> {
  const path = `/${c.dir}/financials.json`;
  return { tag: latestTag(c), path, url: sourceUrl(path), doc: await fetchJson<FinancialsDoc>(path) };
}

/** One published record by its fiscal tag. The latest tag reads the undated file. */
export async function loadRecord(c: Company, tag: string): Promise<LoadedDoc> {
  if (tag.toUpperCase() === latestTag(c).toUpperCase()) return loadLatestFinancials(c);
  const path = `/${c.dir}/${tag.toLowerCase()}/financials.json`;
  return { tag: tag.toUpperCase(), path, url: sourceUrl(path), doc: await fetchJson<FinancialsDoc>(path) };
}

/** Every published record, newest first. */
export async function loadAllRecords(c: Company): Promise<LoadedDoc[]> {
  return Promise.all(recordTags(c).map((t) => loadRecord(c, t)));
}

/** Resolve a caller's record tag ("FY27Q1", "fy27q1") against what is published. */
export function matchRecordTag(c: Company, input: string): string {
  const want = input.trim().toUpperCase().replace(/\s+/g, "");
  const hit = recordTags(c).find((t) => t.toUpperCase() === want);
  if (hit) return hit;
  throw new PeriodNotAvailable(
    `${c.ticker} has no published record tagged "${input}". Published records: ` +
      `${recordTags(c).join(", ")}. A record tag names the filing a bundle was built from ` +
      `(FY27Q2 = the Q2 FY2027 10-Q); to ask for a fiscal period inside the statements, ` +
      `use the period argument instead.`,
  );
}

export interface PeriodSelection {
  periods: Period[];
  /** Records actually read, newest first. */
  records: LoadedDoc[];
  /** The newest record read: its meta header describes units for every period returned. */
  primary: LoadedDoc;
}

/**
 * Periods answering a request, reading older records only when needed: a request that
 * spans history reads every record, and a request for one named period reads the latest
 * record first and the older ones only if the latest does not hold it.
 */
export async function selectForCompany(
  c: Company,
  period: string | undefined,
): Promise<PeriodSelection> {
  const spec: PeriodSpec = parsePeriodSpec(period);
  const ctx = { ticker: c.ticker, nextFiling: nextFilingText(c) };

  if (spansHistory(spec)) {
    const records = await loadAllRecords(c);
    const all = records.flatMap((r) => periodsOf(r.doc, r.tag));
    return { periods: selectPeriods(all, spec, ctx), records, primary: records[0] };
  }

  const latest = await loadLatestFinancials(c);
  try {
    return {
      periods: selectPeriods(periodsOf(latest.doc, latest.tag), spec, ctx),
      records: [latest],
      primary: latest,
    };
  } catch (err) {
    if (!(err instanceof PeriodNotAvailable) || !namesOnePeriod(spec) || recordTags(c).length < 2) {
      throw err;
    }
  }
  const older = await Promise.all(
    recordTags(c)
      .filter((t) => t.toUpperCase() !== latestTag(c).toUpperCase())
      .map((t) => loadRecord(c, t)),
  );
  const records = [latest, ...older];
  const all = records.flatMap((r) => periodsOf(r.doc, r.tag));
  return { periods: selectPeriods(all, spec, ctx), records, primary: latest };
}

export async function loadManifest(c: Company, tag?: string): Promise<{ url: string; doc: Record<string, unknown> }> {
  const path =
    tag && tag.toUpperCase() !== latestTag(c).toUpperCase()
      ? `/${c.dir}/${tag.toLowerCase()}/index.json`
      : `/${c.dir}/index.json`;
  return { url: sourceUrl(path), doc: await fetchJson<Record<string, unknown>>(path) };
}

export async function loadMarkdown(
  c: Company,
  file: "narrative" | "events",
  tag?: string,
): Promise<{ url: string; md: string; tag: string }> {
  const dated = tag && tag.toUpperCase() !== latestTag(c).toUpperCase();
  const path = dated ? `/${c.dir}/${tag!.toLowerCase()}/${file}.md` : `/${c.dir}/${file}.md`;
  return { url: sourceUrl(path), md: await fetchText(path), tag: dated ? tag!.toUpperCase() : latestTag(c) };
}
