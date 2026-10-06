import { z } from "zod";

import { errorResult, jsonResult, type ToolResult } from "../respond.ts";
import { sourceUrl } from "../upstream.ts";
import type { FinancialsDoc } from "../financials.ts";
import { PERIOD_SYNTAX, PeriodNotAvailable, PeriodSpecError, parsePeriodSpec } from "../periods.ts";
import { matchRecordTag, recordTags, type Company } from "../records.ts";

export const TICKER = z.string().describe("Ticker symbol, case-insensitive. Examples: NVDA, brk-b, BRK.B.");

export const PERIOD = z
  .string()
  .optional()
  .describe(
    "Fiscal period: 'FY2025', 'Q2 FY2027' (also 'FY27Q2', 'Q2 2027'), 'latest', 'latest quarter', " +
      "'latest annual', 'ttm', 'ytd', 'annual', 'quarterly', 'all', or a period-end date. The company's " +
      "own fiscal years. Omit for every period in the latest record. A period earlier than the data held " +
      "returns that the data does not go back that far, and what is held.",
  );

export const RECORD = z
  .string()
  .optional()
  .describe(
    "An earlier published record, by tag ('FY27Q1') or by the period its filing reports ('Q1 FY2027'). " +
      "Omit for the latest. list_periods lists every record.",
  );

/** Read-only, public data, no side effects. True of every tool here. */
export const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

export const UNITS_NOTE =
  "All money is in actual dollars (not thousands, not millions), per-share figures in dollars per " +
  "share (per ADS for a foreign issuer that has one), share counts in actual shares, split-adjusted. " +
  "A foreign issuer's figures are converted to US dollars at the rate recorded on each period.";

export const UNITS_SHORT =
  "Actual dollars (not millions), shares split-adjusted, a foreign issuer's figures in US dollars.";

export const SOURCE_NOTE =
  "Every value carries the SEC accession number of the filing it came from and, where the filing " +
  "tags the number, a sec.gov link that opens the filing at the line printing it.";

/**
 * Turn a thrown error into a readable result instead of a 500. A request for a period or
 * record that is not held is an ANSWER, not a failure: it comes back as a normal result
 * saying the data does not go back that far (or is not reported yet) and listing what is.
 */
export async function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof PeriodNotAvailable) {
      return jsonResult({ available: false, message: err.message }, sourceUrl("/tickers.json"));
    }
    if (err instanceof PeriodSpecError) return errorResult(err);
    return errorResult(err);
  }
}

/** The units header every figure response carries, so a value is never separated from its scale. */
export function unitsHeader(doc: FinancialsDoc): Record<string, unknown> {
  const out: Record<string, unknown> = {
    units: doc.units,
    reporting_currency: doc.reporting_currency,
  };
  if (doc.converted_to_usd === true) out.converted_to_usd = true;
  const adj = doc.adjustments as Record<string, unknown> | undefined;
  if (adj?.per_share_basis) out.per_share_basis = adj.per_share_basis;
  if (typeof doc.fiscal_calendar_note === "string") out.fiscal_calendar_note = doc.fiscal_calendar_note;
  return out;
}

function tagOrder(tag: string): number {
  const m = /^FY(\d{2,4})(?:Q([1-4]))?$/i.exec(tag);
  if (!m) return 0;
  const fy = Number(m[1]) % 100;
  return fy * 10 + (m[2] ? Number(m[2]) : 5);
}

/**
 * A record argument, resolved to a published fiscal tag. Accepts the tag itself or the
 * period its filing reports. Returns undefined for "latest".
 */
export function resolveRecordArg(c: Company, input: string | undefined): string | undefined {
  const raw = input?.trim();
  if (!raw || /^(latest|current)$/i.test(raw)) return undefined;
  try {
    return matchRecordTag(c, raw);
  } catch {
    // fall through: the caller may have named a period rather than a tag
  }
  const tags = recordTags(c);
  let wanted: string | null = null;
  try {
    const spec = parsePeriodSpec(raw);
    const yy = (fy: number) => String(fy % 100).padStart(2, "0");
    if (spec.type === "quarter" && spec.fy !== null) wanted = `FY${yy(spec.fy)}Q${spec.q}`;
    if (spec.type === "fiscal_year") wanted = `FY${yy(spec.fy)}`;
  } catch {
    // unreadable; reported below
  }
  const hit = wanted ? tags.find((t) => t.toUpperCase() === wanted) : undefined;
  if (hit) return hit;
  const earliest = [...tags].sort((a, b) => tagOrder(a) - tagOrder(b))[0];
  const tooEarly = wanted && earliest && tagOrder(wanted) < tagOrder(earliest);
  throw new PeriodNotAvailable(
    (tooEarly
      ? `We don't have data going back that far: ${c.ticker}'s earliest published record is ${earliest}. `
      : `${c.ticker} has no published record for "${raw}". `) +
      `Records held: ${tags.join(", ")}. Each record is the snapshot built when one 10-Q or 10-K ` +
      `was filed, and holds several fiscal periods inside it; to ask for a fiscal year or quarter ` +
      `inside the statements, use get_period or a figure tool's period argument.`,
  );
}
