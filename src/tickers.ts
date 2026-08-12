import { fetchJson } from "./upstream.ts";

export interface NextFiling {
  date: string;
  type: string;
}

export interface TickerEntry {
  ticker: string;
  company: string;
  cik?: string;
  exchange?: string;
  path?: string;
  latest_period?: string;
  period_end?: string;
  latest_form?: string;
  next_expected_filing?: NextFiling;
}

export interface TickersFile {
  site?: string;
  base_url?: string;
  description?: string;
  updated: string;
  ticker_count: number;
  tickers: TickerEntry[];
}

export const TICKERS_PATH = "/tickers.json";

/** Lowercase, trim, and map BRK.B style input onto the site's brk-b directory names. */
export function normalizeTicker(input: string): string {
  return input.trim().toLowerCase().replace(/\./g, "-");
}

export function matchCompanies(entries: TickerEntry[], query?: string): TickerEntry[] {
  const q = (query ?? "").trim().toLowerCase();
  if (!q) return entries;
  return entries.filter(
    (e) => e.ticker.toLowerCase().includes(q) || e.company.toLowerCase().includes(q),
  );
}

/** Suggestions for an unknown ticker: substring hits first, then same first letter. */
export function nearMatches(entries: TickerEntry[], input: string, limit = 5): string[] {
  const q = normalizeTicker(input);
  if (!q) return [];
  const substring = entries.filter(
    (e) => e.ticker.toLowerCase().includes(q) || e.company.toLowerCase().includes(q),
  );
  const sameInitial = entries.filter((e) => e.ticker.toLowerCase().startsWith(q[0]));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of [...substring, ...sameInitial]) {
    if (seen.has(e.ticker)) continue;
    seen.add(e.ticker);
    out.push(e.ticker);
    if (out.length >= limit) break;
  }
  return out;
}

export async function loadTickers(): Promise<TickersFile> {
  return fetchJson<TickersFile>(TICKERS_PATH);
}

/** Resolve a user-supplied ticker to its entry, or throw a message that lists suggestions. */
export function resolveTicker(file: TickersFile, input: string): TickerEntry {
  const norm = normalizeTicker(input);
  const hit = file.tickers.find((e) => normalizeTicker(e.ticker) === norm);
  if (hit) return hit;
  const suggestions = nearMatches(file.tickers, input);
  const tail = suggestions.length ? ` Did you mean: ${suggestions.join(", ")}?` : "";
  throw new Error(
    `Ticker "${input}" is not covered by Ticker Scout. ` +
      `Coverage is ${file.ticker_count} companies as of ${file.updated}.${tail} ` +
      `Call list_companies to see the full list.`,
  );
}
