/**
 * Keys that describe the file rather than carry statement data. They are lifted
 * into every response's `meta` header and are not offered as sliceable sections.
 *
 * Everything else is a section, discovered at runtime. Top-level keys differ per
 * company: JPM carries bank_metrics, BRK-B carries nested insurance sections, and
 * they share almost no keys with NVDA. Never hardcode a section list.
 */
const META_KEYS = [
  "ticker",
  "company",
  "cik",
  "business_type",
  "template_choice",
  "reporting_currency",
  "converted_to_usd",
  "units",
  "fiscal_year_convention",
  "fiscal_period",
  "company_details",
  "next_filing",
] as const;

/**
 * Keys dropped from every response entirely: not lifted into `meta`, and not
 * offered as a sliceable section either.
 *
 * `units_notes_seen` is the generating agent's record of the scaling note printed
 * on each statement it read ("In millions, except per-share amounts"). It is kept
 * in financials.json so the pipeline's audit stage can compare it against the note
 * the auditor reads independently -- a fact about how the file was BUILT, not a
 * fact about the company. It used to sit in META_KEYS, which meant ~800 tokens of
 * filing parentheticals rode on EVERY response, including a one-section slice
 * (AAPL 29 entries, MSFT 34).
 *
 * Removing it from META_KEYS is not enough on its own: it is an object, so the
 * shape test in listSections would then promote it to a section and it would come
 * back in every unsliced response. Hence a third category.
 *
 * This does NOT weaken the units guarantee sliceFinancials exists to give. What
 * protects a slice of figures from a six-order-of-magnitude misread is the
 * top-level `units` scalar -- "actual dollars (not millions)" -- which metaHeader
 * still carries, along with every other scalar caveat. An agent that wants the
 * per-statement notes can read financials.json directly; the file still has them.
 */
const OMITTED_KEYS = ["units_notes_seen"] as const;

export type FinancialsDoc = Record<string, unknown>;

export interface CondensedMetric {
  label: string;
  value?: number;
  text?: string;
  exact?: string;
  prior?: string;
  yoy?: string;
  accession?: string;
  period_label?: string;
}

export interface CondensedHeadline {
  ticker: unknown;
  company: unknown;
  period: unknown;
  period_end_words: unknown;
  metrics: CondensedMetric[];
}

/**
 * The pre-selected key figures for the latest period. These are the same figures
 * the site publishes in its lede and key-figures table, already reconciled against
 * this file, so a response here cannot disagree with the page.
 */
export function condenseHeadline(doc: FinancialsDoc): CondensedHeadline {
  const h = doc.headline as
    | { period?: unknown; period_end_words?: unknown; metrics?: unknown[] }
    | undefined;
  if (!h || !Array.isArray(h.metrics) || h.metrics.length === 0) {
    throw new Error(
      `${String(doc.ticker ?? "This company")} has no headline block in its financials file, ` +
        `so there are no pre-selected key figures for it. ` +
        `Call get_financials for the full statements.`,
    );
  }
  return {
    ticker: doc.ticker,
    company: doc.company,
    period: h.period,
    period_end_words: h.period_end_words,
    metrics: (h.metrics as Record<string, unknown>[]).map((m) => {
      const src = (m.source ?? {}) as Record<string, unknown>;
      return {
        label: String(m.label),
        value: m.value as number | undefined,
        text: m.text as string | undefined,
        exact: m.exact as string | undefined,
        prior: m.prior as string | undefined,
        yoy: m.yoy as string | undefined,
        accession: src.source_accession as string | undefined,
        period_label: src.period_label as string | undefined,
      };
    }),
  };
}

/**
 * A section is a top-level key holding structured data: an array or an object.
 *
 * Top-level SCALARS are never sections. Bundles carry a per-company scatter of
 * explanatory strings (schema_template, fiscal_calendar_note, business_subtype,
 * units_note_on_share_counts, and a dozen more that differ by company), and they
 * belong in the meta header, not in a menu of things to request. This is a shape
 * test, never a name test, for the same reason render_financials dispatches on
 * shape: no two companies' key sets agree.
 */
function isStructured(value: unknown): boolean {
  return typeof value === "object" && value !== null;
}

export function listSections(doc: FinancialsDoc): string[] {
  const hidden = new Set<string>([...META_KEYS, ...OMITTED_KEYS]);
  return Object.keys(doc).filter((k) => !hidden.has(k) && isStructured(doc[k]));
}

/**
 * The header returned with every response: the declared meta keys plus every
 * top-level scalar. Those scalars are the file's own caveats about units, fiscal
 * calendars and share counts, so they must ride along with any slice rather than
 * being something the caller has to know to ask for.
 */
export function metaHeader(doc: FinancialsDoc): Record<string, unknown> {
  const omitted = new Set<string>(OMITTED_KEYS);
  const out: Record<string, unknown> = {};
  for (const k of META_KEYS) {
    if (k in doc) out[k] = doc[k];
  }
  // The scalar sweep is a shape test, so an omitted key that ever arrived as a
  // string rather than an object would ride along here. Guard it by name.
  for (const [k, v] of Object.entries(doc)) {
    if (!(k in out) && !omitted.has(k) && !isStructured(v)) out[k] = v;
  }
  return out;
}

/**
 * Return the requested sections plus a meta header. The header is not optional:
 * all money in these files is in actual dollars, so a slice of figures separated
 * from its units statement is a six-order-of-magnitude error waiting to happen.
 */
export function sliceFinancials(
  doc: FinancialsDoc,
  sections?: string[],
): Record<string, unknown> {
  const available = listSections(doc);
  const wanted = sections && sections.length ? sections : available;

  const unknown = wanted.filter((s) => !available.includes(s));
  if (unknown.length) {
    throw new Error(
      `Unknown financials section(s) for ${String(doc.ticker)}: ${unknown.join(", ")}. ` +
        `Available sections: ${available.join(", ")}.`,
    );
  }

  const out: Record<string, unknown> = { meta: metaHeader(doc) };
  for (const s of wanted) out[s] = doc[s];
  return out;
}
