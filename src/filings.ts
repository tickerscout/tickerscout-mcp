import type { FinancialsDoc } from "./financials.ts";
import { splitSections } from "./markdown.ts";
import { splitPassages } from "./topics.ts";

/**
 * SEC accession numbers: every one a company's record cites, what each was used for, and
 * the sec.gov links for it. An accession number is the SEC's permanent ID for one filing
 * (0001045810-26-000075 = filer 0001045810, year 2026, sequence 75), so it is the thing to
 * cite and the key that joins the statements, the narrative and the events digest.
 */

export const ACCESSION_RE = /\b(\d{10}-\d{2}-\d{6})\b/g;

export function isAccession(s: string): boolean {
  return /^\d{10}-\d{2}-\d{6}$/.test(s.trim());
}

/** Accept 0001045810-26-000075 or 000104581026000075. */
export function normalizeAccession(s: string): string | null {
  const t = s.trim();
  if (isAccession(t)) return t;
  const digits = t.replace(/\D/g, "");
  return digits.length === 18 ? `${digits.slice(0, 10)}-${digits.slice(10, 12)}-${digits.slice(12)}` : null;
}

/** The filing's index page on EDGAR. The path uses the company's CIK and the accession without dashes. */
export function edgarIndexUrl(cik: string | number, accession: string): string {
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, "")}/${accession}-index.htm`;
}

export interface AccessionRecord {
  accession: string;
  form: string | null;
  filed: string | null;
  edgar_index_url: string;
  document_url: string | null;
  uses: string[];
}

const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December";
const FORM_NEAR = /\bForm\s+((?:10-K|10-Q|8-K|20-F|40-F|6-K|DEF 14A|S-\d|424B\d|11-K|SD|S-8)(?:\/A)?)\b/i;
const FILED_NEAR = new RegExp(`\\b(?:filed|furnished|dated)\\s+(?:on\\s+)?((?:${MONTHS})\\s+\\d{1,2},\\s+\\d{4})`, "i");

function isoDate(words: string): string | null {
  const t = Date.parse(`${words} UTC`);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

export class AccessionIndex {
  private map = new Map<string, AccessionRecord>();
  private cik: string;
  // A plain field rather than a parameter property: node's type stripping, which runs the
  // unit tests, does not support parameter properties.
  constructor(cik: string) {
    this.cik = cik;
  }

  private get(acc: string): AccessionRecord {
    let r = this.map.get(acc);
    if (!r) {
      r = { accession: acc, form: null, filed: null, edgar_index_url: edgarIndexUrl(this.cik, acc), document_url: null, uses: [] };
      this.map.set(acc, r);
    }
    return r;
  }

  add(acc: string, use: string, extra: { form?: string | null; filed?: string | null; url?: string | null } = {}) {
    const r = this.get(acc);
    if (use && !r.uses.includes(use)) r.uses.push(use);
    if (extra.form && !r.form) r.form = extra.form;
    if (extra.filed && !r.filed) r.filed = extra.filed;
    if (extra.url && !r.document_url) r.document_url = extra.url;
  }

  /** The manifest's source_filings: the annual and quarterly report the record is built from. */
  addSourceFilings(filings: unknown) {
    if (!Array.isArray(filings)) return;
    for (const f of filings as Record<string, unknown>[]) {
      const acc = typeof f.accession === "string" ? f.accession : null;
      if (!acc) continue;
      const what = `${f.role === "annual" ? "Annual" : "Quarterly"} report the record is built from (${f.form}, fiscal ${f.fiscal_year}${f.fiscal_period && f.fiscal_period !== "FY" ? ` ${f.fiscal_period}` : ""}, period ended ${f.period_end})`;
      this.add(acc, what, {
        form: (f.form as string) ?? null,
        filed: (f.filed as string) ?? null,
        url: (f.url as string) ?? null,
      });
    }
  }

  /** Every *accession* field anywhere in a financials record, with the path that cites it. */
  addFinancials(doc: FinancialsDoc, record: string) {
    const visit = (node: unknown, path: string, periodName: string | null) => {
      if (Array.isArray(node)) {
        node.forEach((v, i) => {
          const label =
            v && typeof v === "object" && !Array.isArray(v)
              ? ((v as Record<string, unknown>).label ?? (v as Record<string, unknown>).period_label ?? null)
              : null;
          visit(v, `${path}[${i}]`, (label as string | null) ?? periodName);
        });
        return;
      }
      if (typeof node !== "object" || node === null) return;
      const obj = node as Record<string, unknown>;
      for (const [k, v] of Object.entries(obj)) {
        const p = path ? `${path}.${k}` : k;
        if (/accession/i.test(k) && (typeof v === "string" || Array.isArray(v))) {
          const text = Array.isArray(v) ? v.join(" ") : v;
          for (const m of text.matchAll(ACCESSION_RE)) {
            const form =
              typeof obj.source_form === "string" && k === "source_accession" ? (obj.source_form as string) : null;
            this.add(m[1], `Figures: ${p}${periodName ? ` (${periodName})` : ""} in record ${record}`, { form });
          }
        } else if (k !== "figure_sources") {
          visit(v, p, periodName);
        }
      }
    };
    visit(doc, "", null);
    if (Array.isArray(doc.source_filings)) this.addSourceFilings(doc.source_filings);
    const docs = (doc.figure_sources as Record<string, unknown> | undefined)?.documents as Record<string, string> | undefined;
    for (const url of Object.values(docs ?? {})) {
      const m = /\/(\d{18})\//.exec(url);
      const acc = m ? normalizeAccession(m[1]) : null;
      if (acc) this.add(acc, "", { url });
    }
  }

  /** Accessions cited in prose, with the sentence's form and filing date when it states them. */
  addMarkdown(md: string, document: string) {
    for (const s of splitSections(md)) {
      for (const para of splitPassages(s.body)) {
        for (const m of para.matchAll(ACCESSION_RE)) {
          const at = m.index ?? 0;
          const near = para.slice(Math.max(0, at - 120), at + 120);
          const form = FORM_NEAR.exec(near)?.[1]?.toUpperCase() ?? null;
          const filedWords = FILED_NEAR.exec(para.slice(at, at + 140))?.[1];
          this.add(m[1], `${document}: "${s.heading}"`, {
            form,
            filed: filedWords ? isoDate(filedWords) : null,
          });
        }
      }
    }
  }

  list(): AccessionRecord[] {
    // Undated accessions sort by the year the accession number itself carries.
    const key = (r: AccessionRecord) => r.filed ?? `20${r.accession.slice(11, 13)}`;
    return [...this.map.values()].sort(
      (a, b) => key(b).localeCompare(key(a)) || b.accession.localeCompare(a.accession),
    );
  }

  find(acc: string): AccessionRecord | undefined {
    return this.map.get(acc);
  }
}

/** Every passage in a markdown document that cites one accession, with its section. */
export function passagesCiting(md: string, accession: string, document: string): { document: string; section: string; text: string }[] {
  const out: { document: string; section: string; text: string }[] = [];
  for (const s of splitSections(md)) {
    for (const para of splitPassages(s.body)) {
      if (para.includes(accession)) out.push({ document, section: s.heading, text: para });
    }
  }
  return out;
}
