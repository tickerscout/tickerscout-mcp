export const BASE_URL = "https://tickerscout.ai";

// Data changes quarterly, shortly after a company files its 10-K or 10-Q.
// One hour is conservative and keeps origin load near zero.
const CACHE_TTL_SECONDS = 3600;

export class UpstreamError extends Error {
  constructor(url: string, status: number) {
    super(
      `Ticker Scout upstream fetch failed: ${url} returned HTTP ${status}. ` +
        `No cached or fallback copy is served. Retry shortly, or check ` +
        `${BASE_URL}/tickers.json for current coverage.`,
    );
    this.name = "UpstreamError";
  }
}

export function sourceUrl(path: string): string {
  return `${BASE_URL}${path}`;
}

export async function fetchText(path: string): Promise<string> {
  const url = sourceUrl(path);
  const res = await fetch(url, {
    cf: { cacheEverything: true, cacheTtl: CACHE_TTL_SECONDS },
  } as RequestInit);
  if (!res.ok) throw new UpstreamError(url, res.status);
  return res.text();
}

export async function fetchJson<T>(path: string): Promise<T> {
  const text = await fetchText(path);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(
      `Ticker Scout upstream returned unparseable JSON at ${sourceUrl(path)}. ` +
        `Nothing is repaired or guessed.`,
    );
  }
}
