import type { FinancialsDoc } from "./financials.ts";

/**
 * Fiscal periods: finding them inside a financials record, naming them consistently,
 * and resolving what a caller types ("FY2025", "Q2 2027", "ttm", "2026-07-26") to the
 * periods that answer it.
 *
 * Every record holds several periods: up to three fiscal years in `annual`, the latest
 * quarter and its prior-year comparative in `quarterly`, and usually a year-to-date and
 * a trailing-twelve-months block. Older published records hold older quarters, so the
 * history of a company is the union of its records, newest record first.
 */

export type PeriodKind =
  | "annual"
  | "quarter"
  | "year_to_date"
  | "prior_year_to_date"
  | "trailing_twelve_months";

export interface Period {
  kind: PeriodKind;
  /** Canonical name: "FY2026", "Q2 FY2027", or the file's own label for YTD/TTM. */
  name: string;
  /** The label the file itself prints, when it has one. */
  label: string | null;
  fiscal_year: number | null;
  fiscal_quarter: number | null;
  period_start: string | null;
  period_end: string | null;
  /** Top-level key the period lives under, and its index when that key is an array. */
  array: string;
  index: number | null;
  /** The published record (fiscal tag of the bundle) this period was read from. */
  record: string;
  data: Record<string, unknown>;
}

const SINGLE_BLOCKS: [string, PeriodKind][] = [
  ["year_to_date", "year_to_date"],
  ["prior_year_to_date", "prior_year_to_date"],
  ["trailing_twelve_months", "trailing_twelve_months"],
];

const ORDINALS: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4 };

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function int(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) ? n : null;
}

function fullYear(y: string): number {
  const n = Number(y);
  return y.length === 2 ? 2000 + n : n;
}

/** Fiscal year and quarter as a period label states them, for the files that omit the fields. */
export function parseLabel(label: string): { fy: number | null; q: number | null } {
  let q: number | null = null;
  let m = /\bQ([1-4])\b/i.exec(label) ?? /\b([1-4])Q\b/i.exec(label);
  if (m) q = Number(m[1]);
  if (q === null) {
    m = /\b(first|second|third|fourth)\b[\w\s]{0,12}?\bquarter\b/i.exec(label);
    if (m) q = ORDINALS[m[1].toLowerCase()];
  }

  let fy: number | null = null;
  const patterns = [
    /\bFY\s?'?(\d{4})\b/i,
    /\bfiscal\s+(?:year\s+)?(\d{4})\b/i,
    /\b(\d{4})\s*Q[1-4]\b/i,
    /\bQ[1-4]\s*(?:FY)?\s*'?(\d{4})\b/i,
    /\bFY\s?'?(\d{2})\b/i,
    /\b(?:first|second|third|fourth)\s+quarter\s+(?:of\s+)?(?:fiscal\s+)?(\d{4})\b/i,
    /\b(\d{4})\b/,
  ];
  for (const p of patterns) {
    const hit = p.exec(label);
    if (hit) {
      fy = fullYear(hit[1]);
      break;
    }
  }
  return { fy, q };
}

function days(a: string, b: string): number {
  return (Date.parse(b) - Date.parse(a)) / 86_400_000;
}

/**
 * Fiscal year and quarter for a quarterly column whose file states neither, worked out
 * from the same file's own fiscal years: the quarter ends inside exactly one of them, and
 * its distance from that year's start says which quarter it is. Uses nothing but dates
 * the file prints.
 */
function deriveQuarter(
  end: string,
  annuals: { fy: number; start: string; end: string }[],
): { fy: number | null; q: number | null } {
  const quarterOf = (start: string) =>
    Math.min(4, Math.max(1, Math.round(days(start, end) / 91.3)));
  for (const a of annuals) {
    if (days(a.start, end) > 0 && days(end, a.end) >= -4) return { fy: a.fy, q: quarterOf(a.start) };
  }
  if (!annuals.length) return { fy: null, q: null };
  const latest = annuals.reduce((x, y) => (x.end > y.end ? x : y));
  const gap = days(latest.end, end);
  if (gap > 0 && gap < 372) {
    return { fy: latest.fy + 1, q: Math.min(4, Math.max(1, Math.round(gap / 91.3))) };
  }
  const earliest = annuals.reduce((x, y) => (x.start < y.start ? x : y));
  const before = days(end, earliest.start);
  if (before > 0 && before < 372) {
    return { fy: earliest.fy - 1, q: Math.min(4, Math.max(1, Math.round((366 - before) / 91.3))) };
  }
  return { fy: null, q: null };
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

/** Every period a record holds, in file order: annual, quarterly, then the single blocks. */
export function periodsOf(doc: FinancialsDoc, record: string): Period[] {
  const out: Period[] = [];
  const annualRaw = Array.isArray(doc.annual) ? doc.annual : [];
  const annuals: { fy: number; start: string; end: string }[] = [];

  annualRaw.forEach((raw, i) => {
    const p = asRecord(raw);
    if (!p) return;
    const label = str(p.label) ?? str(p.period_label);
    const fy = int(p.fiscal_year) ?? (label ? parseLabel(label).fy : null);
    const start = str(p.period_start);
    const end = str(p.period_end);
    if (fy !== null && start && end) annuals.push({ fy, start, end });
    out.push({
      kind: "annual",
      name: fy !== null ? `FY${fy}` : (label ?? `annual[${i}]`),
      label,
      fiscal_year: fy,
      fiscal_quarter: null,
      period_start: start,
      period_end: end,
      array: "annual",
      index: i,
      record,
      data: p,
    });
  });

  const quarterlyRaw = Array.isArray(doc.quarterly) ? doc.quarterly : [];
  quarterlyRaw.forEach((raw, i) => {
    const p = asRecord(raw);
    if (!p) return;
    const label = str(p.label) ?? str(p.period_label);
    let fy = int(p.fiscal_year);
    let q = int(p.fiscal_quarter);
    if (q === null) {
      const fp = str(p.fiscal_period);
      const m = fp ? /Q([1-4])/i.exec(fp) : null;
      if (m) q = Number(m[1]);
    }
    if ((fy === null || q === null) && label) {
      const parsed = parseLabel(label);
      fy ??= parsed.fy;
      q ??= parsed.q;
    }
    const end = str(p.period_end);
    if ((fy === null || q === null) && end) {
      const derived = deriveQuarter(end, annuals);
      fy ??= derived.fy;
      q ??= derived.q;
    }
    out.push({
      kind: "quarter",
      name: fy !== null && q !== null ? `Q${q} FY${fy}` : (label ?? `quarterly[${i}]`),
      label,
      fiscal_year: fy,
      fiscal_quarter: q !== null && q >= 1 && q <= 4 ? q : null,
      period_start: str(p.period_start),
      period_end: end,
      array: "quarterly",
      index: i,
      record,
      data: p,
    });
  });

  for (const [key, kind] of SINGLE_BLOCKS) {
    const v = doc[key];
    const blocks = Array.isArray(v) ? v : v ? [v] : [];
    blocks.forEach((raw, i) => {
      const p = asRecord(raw);
      if (!p) return;
      const label = str(p.label) ?? str(p.period_label);
      const end = str(p.period_end);
      const fallback =
        kind === "trailing_twelve_months"
          ? `Trailing twelve months${end ? ` ended ${end}` : ""}`
          : kind === "year_to_date"
            ? `Year to date${end ? ` ended ${end}` : ""}`
            : `Prior year to date${end ? ` ended ${end}` : ""}`;
      out.push({
        kind,
        name: label ?? fallback,
        label,
        fiscal_year: int(p.fiscal_year),
        fiscal_quarter: null,
        period_start: str(p.period_start),
        period_end: end,
        array: key,
        index: Array.isArray(v) ? i : null,
        record,
        data: p,
      });
    });
  }
  return out;
}

/** JSON path of a period inside its record, e.g. "quarterly[0]" or "trailing_twelve_months". */
export function periodPath(p: Period): string {
  return p.index === null ? p.array : `${p.array}[${p.index}]`;
}

/** Scalars that describe a period: dates, label, form, accession, basis. Never the statements. */
export function periodHeader(p: Period): Record<string, unknown> {
  const out: Record<string, unknown> = {
    period: p.name,
    kind: p.kind,
    fiscal_year: p.fiscal_year,
  };
  if (p.fiscal_quarter !== null) out.fiscal_quarter = p.fiscal_quarter;
  if (p.label && p.label !== p.name) out.label_in_filing_record = p.label;
  out.period_start = p.period_start;
  out.period_end = p.period_end;
  for (const [k, v] of Object.entries(p.data)) {
    if (k in out || k === "label" || k === "period_label") continue;
    if (typeof v !== "object" || v === null) out[k] = v;
  }
  out.record = p.record;
  out.path_in_file = periodPath(p);
  return out;
}

// ---------------------------------------------------------------------------
// What a caller asks for
// ---------------------------------------------------------------------------

export type PeriodSpec =
  | { type: "every" }
  | { type: "history" }
  | { type: "latest" }
  | { type: "latest_quarter" }
  | { type: "latest_annual" }
  | { type: "all_annual" }
  | { type: "all_quarters" }
  | { type: "kind"; kind: PeriodKind }
  | { type: "fiscal_year"; fy: number }
  | { type: "quarter"; fy: number | null; q: number }
  | { type: "date"; date: string };

export class PeriodSpecError extends Error {}

export const PERIOD_SYNTAX =
  "Fiscal year: 'FY2025', 'FY25', 'fiscal 2025' or '2025'. Quarter: 'Q2 FY2027', 'Q2 2027', " +
  "'FY27Q2', '2027Q2', '2Q27', 'second quarter 2027', or 'Q2' for the latest second quarter. " +
  "Special: 'latest' (most recent period of any kind), 'latest quarter', 'latest annual', " +
  "'ttm' (trailing twelve months), 'ytd' (year to date), 'prior ytd', 'annual' (every fiscal " +
  "year), 'quarterly' (every quarter), 'all' (every period in every published record). A " +
  "period-end date such as '2026-07-26' also works.";

/** Turn what a caller typed into a period request. Fiscal years are the company's own. */
export function parsePeriodSpec(input: string | undefined): PeriodSpec {
  const raw = (input ?? "").trim();
  const s = raw.toLowerCase().replace(/[_\-\s]+/g, " ").trim();
  if (!s) return { type: "every" };
  if (s === "all" || s === "history" || s === "all periods" || s === "every") return { type: "history" };
  if (s === "latest" || s === "current" || s === "most recent") return { type: "latest" };
  if (/^(latest|last|most recent|current) (quarter|q|3 months|three months)$/.test(s))
    return { type: "latest_quarter" };
  if (/^(latest|last|most recent|current) (annual|year|fiscal year|fy|10 k|20 f)$/.test(s))
    return { type: "latest_annual" };
  if (/^(annual|annuals|years|fiscal years|yearly|all annual|all years)$/.test(s))
    return { type: "all_annual" };
  if (/^(quarterly|quarters|all quarters|all quarterly)$/.test(s)) return { type: "all_quarters" };
  if (/^(ttm|ltm|trailing twelve months|trailing 12 months|last twelve months|trailing)$/.test(s))
    return { type: "kind", kind: "trailing_twelve_months" };
  if (/^(prior ytd|prior year to date|ytd prior|previous ytd|prior year ytd)$/.test(s))
    return { type: "kind", kind: "prior_year_to_date" };
  if (/^(ytd|year to date)$/.test(s)) return { type: "kind", kind: "year_to_date" };

  const iso = /^(\d{4}) (\d{2}) (\d{2})$/.exec(s) ?? /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (iso) return { type: "date", date: `${iso[1]}-${iso[2]}-${iso[3]}` };

  // Quarter forms, most specific first.
  const quarterForms: [RegExp, (m: RegExpExecArray) => { fy: string | null; q: string }][] = [
    [/^q([1-4]) (?:of )?(?:fy|fiscal year|fiscal)? ?'?(\d{4}|\d{2})$/, (m) => ({ q: m[1], fy: m[2] })],
    [/^fy ?'?(\d{4}|\d{2}) ?q([1-4])$/, (m) => ({ fy: m[1], q: m[2] })],
    [/^(\d{4}) ?q([1-4])$/, (m) => ({ fy: m[1], q: m[2] })],
    [/^([1-4])q ?'?(\d{4}|\d{2})$/, (m) => ({ q: m[1], fy: m[2] })],
    [/^q([1-4])$/, (m) => ({ q: m[1], fy: null })],
  ];
  const compact = s.replace(/fy(\d)/g, "fy $1").replace(/\s+/g, " ");
  for (const candidate of [s, s.replace(/\s+/g, ""), compact]) {
    for (const [re, pick] of quarterForms) {
      const m = re.exec(candidate);
      if (m) {
        const { fy, q } = pick(m);
        return { type: "quarter", q: Number(q), fy: fy ? fullYear(fy) : null };
      }
    }
  }
  const ordinal = /^(first|second|third|fourth) (?:fiscal )?quarter(?: of)?(?: (?:fiscal|fy) ?)?(?: ?'?(\d{4}|\d{2}))?$/.exec(s);
  if (ordinal) {
    return {
      type: "quarter",
      q: ORDINALS[ordinal[1]],
      fy: ordinal[2] ? fullYear(ordinal[2]) : null,
    };
  }

  const year =
    /^(?:fy|fiscal year|fiscal|year) ?'?(\d{4}|\d{2})$/.exec(s) ??
    /^fy(\d{4}|\d{2})$/.exec(s.replace(/\s+/g, "")) ??
    /^(\d{4})$/.exec(s);
  if (year) return { type: "fiscal_year", fy: fullYear(year[1]) };

  throw new PeriodSpecError(`Could not read the period "${raw}". ${PERIOD_SYNTAX}`);
}

/** Does this period answer the request? Pure test, no availability logic. */
function matches(p: Period, spec: PeriodSpec): boolean {
  switch (spec.type) {
    case "all_annual":
      return p.kind === "annual";
    case "all_quarters":
      return p.kind === "quarter";
    case "kind":
      return p.kind === spec.kind;
    case "fiscal_year":
      return p.kind === "annual" && p.fiscal_year === spec.fy;
    case "quarter":
      return (
        p.kind === "quarter" &&
        p.fiscal_quarter === spec.q &&
        (spec.fy === null || p.fiscal_year === spec.fy)
      );
    case "date":
      return p.period_end !== null && Math.abs(days(p.period_end, spec.date)) <= 3;
    default:
      return true;
  }
}

/**
 * Keep one copy of each distinct period. Records are passed newest first, so when two
 * records hold the same quarter (a 10-Q's prior-year comparative and the original), the
 * newer one wins: it carries any restatement.
 */
export function dedupePeriods(periods: Period[]): Period[] {
  const seen = new Set<string>();
  const out: Period[] = [];
  for (const p of periods) {
    const key =
      p.kind === "annual" && p.fiscal_year !== null
        ? `annual:${p.fiscal_year}`
        : p.kind === "quarter" && p.fiscal_year !== null && p.fiscal_quarter !== null
          ? `quarter:${p.fiscal_year}:${p.fiscal_quarter}`
          : `${p.kind}:${p.period_start}:${p.period_end}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}

function byEndDesc(a: Period, b: Period): number {
  return (b.period_end ?? "").localeCompare(a.period_end ?? "");
}

function latestOf(periods: Period[], kind: PeriodKind): Period | undefined {
  return periods.filter((p) => p.kind === kind).sort(byEndDesc)[0];
}

/** The most recent discrete period: the latest quarter if it ends after the latest fiscal year. */
function latestDiscrete(periods: Period[]): Period | undefined {
  const q = latestOf(periods, "quarter");
  const a = latestOf(periods, "annual");
  if (q && a) return (q.period_end ?? "") >= (a.period_end ?? "") ? q : a;
  return q ?? a;
}

export interface Availability {
  fiscal_years: string[];
  quarters: string[];
  other: string[];
  earliest_fiscal_year: string | null;
  latest_fiscal_year: string | null;
  earliest_quarter: string | null;
  latest_quarter: string | null;
}

export function availability(periods: Period[]): Availability {
  const unique = dedupePeriods([...periods].sort(byEndDesc));
  const annual = unique.filter((p) => p.kind === "annual").sort((a, b) => -byEndDesc(a, b));
  const quarters = unique.filter((p) => p.kind === "quarter").sort((a, b) => -byEndDesc(a, b));
  const other = unique.filter((p) => p.kind !== "annual" && p.kind !== "quarter");
  const desc = (p: Period) => `${p.name} (${p.period_start ?? "?"} to ${p.period_end ?? "?"})`;
  return {
    fiscal_years: annual.map(desc),
    quarters: quarters.map(desc),
    other: other.map(desc),
    earliest_fiscal_year: annual[0]?.name ?? null,
    latest_fiscal_year: annual.at(-1)?.name ?? null,
    earliest_quarter: quarters[0]?.name ?? null,
    latest_quarter: quarters.at(-1)?.name ?? null,
  };
}

export class PeriodNotAvailable extends Error {}

/**
 * The periods that answer a request, or a PeriodNotAvailable error that says plainly
 * whether the request is before the earliest data held, after the latest filing, or a
 * gap between, and lists what is held.
 */
export function selectPeriods(
  periods: Period[],
  spec: PeriodSpec,
  context: { ticker: string; nextFiling?: string | null },
): Period[] {
  const unique = dedupePeriods([...periods].sort(byEndDesc));
  let hits: Period[];
  switch (spec.type) {
    case "every":
    case "history":
      hits = unique;
      break;
    case "latest": {
      const p = latestDiscrete(unique);
      hits = p ? [p] : [];
      break;
    }
    case "latest_quarter": {
      const p = latestOf(unique, "quarter");
      hits = p ? [p] : [];
      break;
    }
    case "latest_annual": {
      const p = latestOf(unique, "annual");
      hits = p ? [p] : [];
      break;
    }
    case "quarter":
      hits = unique.filter((p) => matches(p, spec));
      if (spec.fy === null) hits = hits.slice(0, 1);
      break;
    case "kind":
      hits = unique.filter((p) => matches(p, spec)).slice(0, 1);
      break;
    default:
      hits = unique.filter((p) => matches(p, spec));
  }
  if (hits.length) return hits;
  throw new PeriodNotAvailable(notAvailableMessage(unique, spec, context));
}

function notAvailableMessage(
  periods: Period[],
  spec: PeriodSpec,
  context: { ticker: string; nextFiling?: string | null },
): string {
  const a = availability(periods);
  const held =
    `Ticker Scout holds, for ${context.ticker}: fiscal years ${a.fiscal_years.join(", ") || "none"}; ` +
    `quarters ${a.quarters.join(", ") || "none"}. list_periods gives the detail.`;
  const next = context.nextFiling ? ` The next filing is expected ${context.nextFiling}.` : "";

  if (spec.type === "fiscal_year" || (spec.type === "quarter" && spec.fy !== null)) {
    const fy = spec.fy as number;
    const kindPeriods = periods.filter((p) =>
      spec.type === "fiscal_year" ? p.kind === "annual" : p.kind === "quarter",
    );
    const years = kindPeriods.map((p) => p.fiscal_year).filter((y): y is number => y !== null);
    const what = spec.type === "fiscal_year" ? `FY${fy}` : `Q${spec.q} FY${fy}`;
    if (years.length && fy < Math.min(...years)) {
      const earliest = spec.type === "fiscal_year" ? a.earliest_fiscal_year : a.earliest_quarter;
      return (
        `We don't have data going back that far: ${what} is earlier than anything Ticker Scout ` +
        `holds for ${context.ticker}. The earliest ${spec.type === "fiscal_year" ? "fiscal year" : "quarter"} ` +
        `held is ${earliest}. ${held}`
      );
    }
    const latestYear = years.length ? Math.max(...years) : null;
    const latestQ = kindPeriods
      .filter((p) => p.fiscal_year === latestYear)
      .map((p) => p.fiscal_quarter ?? 0);
    const isFuture =
      latestYear !== null &&
      (fy > latestYear ||
        (spec.type === "quarter" && fy === latestYear && spec.q > Math.max(0, ...latestQ)));
    if (isFuture) {
      return (
        `${what} is not in Ticker Scout's records for ${context.ticker} yet: it has not been ` +
        `reported, or the filing that reports it has not been processed.${next} ${held}`
      );
    }
    return (
      `${what} is not in any record Ticker Scout has published for ${context.ticker}. Coverage ` +
      `began recently, so a quarter inside the range can be missing where no published 10-Q or ` +
      `comparative column carried it. ${held}`
    );
  }
  if (spec.type === "quarter") {
    return `No Q${spec.q} is held for ${context.ticker}. ${held}`;
  }
  if (spec.type === "date") {
    return `No period held for ${context.ticker} ends on or within three days of ${spec.date}. ${held}`;
  }
  if (spec.type === "kind") {
    return `${context.ticker}'s record carries no ${spec.kind.replace(/_/g, " ")} block. ${held}`;
  }
  return `No matching period for ${context.ticker}. ${held}`;
}

/** Requests that span every published record, not only the latest one. */
export function spansHistory(spec: PeriodSpec): boolean {
  return spec.type === "history" || spec.type === "all_annual" || spec.type === "all_quarters";
}

/** Requests for one named period, which may live only in an older record. */
export function namesOnePeriod(spec: PeriodSpec): boolean {
  return spec.type === "fiscal_year" || spec.type === "quarter" || spec.type === "date";
}
