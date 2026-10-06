import { splitSections, type Section } from "./markdown.ts";

/**
 * Named topics inside the narrative and events documents, and keyword search across them.
 *
 * Headings are written per company and carry variable suffixes ("Management's discussion —
 * fiscal 2026", "Current quarter — three and six months ended June 30, 2026"), so a topic
 * is a heading PATTERN, never a fixed string. Verified against every published narrative.md
 * and events.md: every narrative has Business, 127 of 128 have Subsequent events, 125 have
 * Risk factors (3 call it Risks), and every one has an annual MD&A and a current-quarter
 * section under one of a dozen phrasings.
 */

export interface Topic {
  id: string;
  label: string;
  /** Matched against h2 headings. */
  heading: RegExp;
  /** h2 headings that match `heading` but belong to another topic. */
  excludeHeading?: RegExp;
  /** Matched against h3 subheadings and bold run-in heads inside other sections. */
  subheading?: RegExp;
  /** Paragraph keywords, for topics that are as often a passage as a section. */
  keywords?: RegExp;
}

export const NARRATIVE_TOPICS: Record<string, Topic> = {
  business: {
    id: "business",
    label: "Business",
    heading: /^business\b/i,
  },
  risk_factors: {
    id: "risk_factors",
    label: "Risk factors",
    heading: /^risk/i,
  },
  annual_mdna: {
    id: "annual_mdna",
    label: "Management's discussion and analysis (fiscal year)",
    heading: /^(management'?s discussion|md&a)/i,
  },
  current_quarter: {
    id: "current_quarter",
    label: "Current quarter (quarterly report MD&A)",
    // Phrased a dozen ways ("Current quarter — ...", "The second quarter of 2026", "First quarter
    // of fiscal 2027", "Interim detail: the March 2026 quarter", "Most recent periods"), so any
    // section about a quarter or the latest period that is not one of the other four.
    heading: /quarter|\bperiods?\b|interim|^(the )?(current|most recent)\b|within the year/i,
    excludeHeading: /^(business|risk|management|md&a|subsequent)/i,
  },
  subsequent_events: {
    id: "subsequent_events",
    label: "Subsequent events",
    heading: /^subsequent/i,
  },
  legal_proceedings: {
    id: "legal_proceedings",
    label: "Legal proceedings and regulatory matters",
    heading: /legal|litigation|regulatory and legal/i,
    subheading: /legal|litigation|proceedings|lawsuit|antitrust|investigation/i,
    keywords: /\b(litigation|lawsuits?|legal proceedings|antitrust|class action|subpoena|settle(d|ment)|investigation|consent decree|indictment|plaintiffs?|verdict|appeal)\b/i,
  },
};

export const EVENT_TOPICS: Record<string, Topic> = {
  earnings: {
    id: "earnings",
    label: "Earnings releases and guidance",
    heading: /earnings|results|guidance|quarter|fiscal/i,
    keywords: /\b(reported (record )?revenue|earnings release|results for the|guidance|guided|outlook)\b/i,
  },
  management_changes: {
    id: "management_changes",
    label: "Board and management changes",
    heading: /management|board|leadership|executive|officer|director|succession|people/i,
    keywords: /\b(appointed|named (as )?(chief|president|ceo|cfo)|resign(ed|ation)|retire(d|ment)|succe(ed|ssion)|elected to the board|stepp(ed|ing) down|chief executive officer|chief financial officer|item 5\.02)\b/i,
  },
  capital_returns: {
    id: "capital_returns",
    label: "Dividends and share repurchases",
    heading: /capital (return|action|allocation)|dividend|repurchase|buyback|shareholder return/i,
    keywords: /\b(dividend|repurchase|buyback|accelerated share)\b/i,
  },
  debt_and_financing: {
    id: "debt_and_financing",
    label: "Debt offerings, credit facilities and financing",
    heading: /debt|financing|capital markets|capital structure|credit|notes|borrowing|liquidity/i,
    keywords: /\b(senior (unsecured )?notes|notes due|credit (agreement|facility)|revolv(er|ing)|term loan|commercial paper|debt offering|indenture|item 2\.03|bond)\b/i,
  },
  mergers_and_acquisitions: {
    id: "mergers_and_acquisitions",
    label: "Mergers, acquisitions and divestitures",
    heading: /m&a|merger|acqui|divest|transaction|spin|disposition/i,
    keywords: /\b(acquire[ds]?|acquisition|merger|divest(ed|iture)|spin-?off|definitive agreement|item (1\.01|2\.01))\b/i,
  },
  governance: {
    id: "governance",
    label: "Governance, annual meetings and shareholder votes",
    heading: /governance|annual meeting|shareholder|stockholder|bylaws|vote|charter/i,
    keywords: /\b(annual meeting|shareholders? (voted|approved)|stockholders? (voted|approved)|bylaws?|item 5\.07|say-on-pay|proxy)\b/i,
  },
  restructuring: {
    id: "restructuring",
    label: "Restructuring, layoffs and impairments",
    heading: /restructur|impairment|reorganization|workforce/i,
    keywords: /\b(restructuring|layoffs?|workforce reduction|headcount|impairment|item 2\.05|exit costs?)\b/i,
  },
  legal_and_regulatory: {
    id: "legal_and_regulatory",
    label: "Legal and regulatory events",
    heading: /legal|litigation|regulat|investigation|settlement/i,
    keywords: /\b(litigation|lawsuit|settle(d|ment)|investigation|regulator|antitrust|consent order|subpoena|fine[ds]?)\b/i,
  },
};

export interface TopicMatch {
  heading: string;
  body: string;
  matched: "section" | "subsection" | "passage";
  parent?: string;
}

/** Split a section body into h3 subsections, with any text before the first h3 kept as the lead. */
export function splitSubsections(body: string): { heading: string | null; body: string }[] {
  const out: { heading: string | null; body: string }[] = [];
  let heading: string | null = null;
  let buf: string[] = [];
  const flush = () => {
    const text = buf.join("\n").trim();
    if (heading !== null || text) out.push({ heading, body: text });
  };
  for (const line of body.split("\n")) {
    const m = /^###[ \t]+(.*\S)[ \t]*$/.exec(line);
    if (m) {
      flush();
      heading = m[1];
      buf = [];
    } else buf.push(line);
  }
  flush();
  return out;
}

/** Paragraphs and list items, each a self-contained passage. Tables stay whole. */
export function splitPassages(body: string): string[] {
  const out: string[] = [];
  let buf: string[] = [];
  const flush = () => {
    const t = buf.join("\n").trim();
    if (t) out.push(t);
    buf = [];
  };
  for (const line of body.split("\n")) {
    if (!line.trim()) {
      flush();
      continue;
    }
    // A new list item starts a new passage; its wrapped continuation lines stay with it.
    if (/^\s{0,3}([-*+]|\d+\.)\s/.test(line) && buf.length && !/^\s*\|/.test(buf[0])) flush();
    buf.push(line);
  }
  flush();
  return out;
}

const BOLD_HEAD = /^\*\*([^*]{2,80}?)[.:]?\*\*/;

/**
 * Everything in a document under a topic: whole h2 sections whose heading matches, then
 * h3 subsections and bold-headed paragraphs inside other sections, then (for topics that
 * define keywords) individual passages elsewhere that mention it. Each match says which.
 */
export function topicMatches(md: string, topic: Topic, passageLimit = 12): TopicMatch[] {
  const sections = splitSections(md);
  const out: TopicMatch[] = [];
  const taken = new Set<Section>();
  for (const s of sections) {
    if (topic.heading.test(s.heading) && !topic.excludeHeading?.test(s.heading)) {
      out.push({ heading: s.heading, body: s.body, matched: "section" });
      taken.add(s);
    }
  }
  if (topic.subheading) {
    for (const s of sections) {
      if (taken.has(s)) continue;
      for (const sub of splitSubsections(s.body)) {
        if (sub.heading && topic.subheading.test(sub.heading)) {
          out.push({ heading: sub.heading, body: sub.body, matched: "subsection", parent: s.heading });
          continue;
        }
        const paras = splitPassages(sub.body);
        for (let i = 0; i < paras.length; i++) {
          const head = BOLD_HEAD.exec(paras[i]);
          if (!head || !topic.subheading.test(head[1])) continue;
          // A bold head on a line of its own introduces the passages under it, up to the next head.
          const parts = [paras[i]];
          if (paras[i].replace(BOLD_HEAD, "").trim().length < 5) {
            for (let j = i + 1; j < paras.length && !BOLD_HEAD.test(paras[j]); j++) parts.push(paras[j]);
          }
          out.push({ heading: head[1], body: parts.join("\n\n"), matched: "subsection", parent: s.heading });
        }
      }
    }
  }
  if (topic.keywords) {
    let n = 0;
    const already = new Set(out.map((m) => m.body));
    for (const s of sections) {
      if (taken.has(s)) continue;
      for (const para of splitPassages(s.body)) {
        if (n >= passageLimit) break;
        if (para.startsWith("|") || [...already].some((b) => b.includes(para))) continue;
        if (topic.keywords.test(para)) {
          out.push({ heading: s.heading, body: para, matched: "passage", parent: s.heading });
          n++;
        }
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Keyword search
// ---------------------------------------------------------------------------

export interface SearchQuery {
  phrases: string[];
  terms: string[];
}

/** Quoted phrases are matched exactly; other words must all appear (case-insensitive). */
export function parseQuery(q: string): SearchQuery {
  const phrases: string[] = [];
  const rest = q.replace(/"([^"]+)"/g, (_, p: string) => {
    phrases.push(p.toLowerCase().trim());
    return " ";
  });
  const STOP = new Set(["the", "a", "an", "of", "and", "or", "in", "on", "to", "for", "is", "are", "what", "how", "did"]);
  const terms = rest
    .toLowerCase()
    .split(/[^a-z0-9&$%.\-']+/)
    .map((t) => t.replace(/^[.\-']+|[.\-']+$/g, ""))
    .filter((t) => t.length > 1 && !STOP.has(t));
  return { phrases, terms };
}

function countOf(hay: string, needle: string): number {
  let n = 0;
  let i = hay.indexOf(needle);
  while (i >= 0) {
    n++;
    i = hay.indexOf(needle, i + needle.length);
  }
  return n;
}

export function scoreText(text: string, q: SearchQuery): number {
  const hay = text.toLowerCase();
  let score = 0;
  for (const p of q.phrases) {
    const c = countOf(hay, p);
    if (!c) return 0;
    score += c * 3;
  }
  for (const t of q.terms) {
    const c = countOf(hay, t);
    if (!c) return 0;
    score += c;
  }
  return score;
}

/** A window of text around the first hit, for a result list. */
export function snippet(text: string, q: SearchQuery, width = 320): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const hay = flat.toLowerCase();
  const first = [...q.phrases, ...q.terms]
    .map((t) => hay.indexOf(t))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, first - Math.floor(width / 3));
  const end = Math.min(flat.length, start + width);
  return `${start > 0 ? "..." : ""}${flat.slice(start, end)}${end < flat.length ? "..." : ""}`;
}

export interface SectionHit {
  document: string;
  section: string;
  subsection: string | null;
  hits: number;
  chars: number;
  snippet: string;
}

/** Sections and subsections ranked by how often they mention the query. */
export function searchSections(document: string, md: string, q: SearchQuery): SectionHit[] {
  const out: SectionHit[] = [];
  for (const s of splitSections(md)) {
    for (const sub of splitSubsections(s.body)) {
      const text = `${sub.heading ?? ""}\n${sub.body}`;
      const hits = scoreText(text, q);
      if (hits) {
        out.push({
          document,
          section: s.heading,
          subsection: sub.heading,
          hits,
          chars: sub.body.length,
          snippet: snippet(sub.body, q),
        });
      }
    }
  }
  return out.sort((a, b) => b.hits - a.hits);
}

export interface PassageHit {
  document: string;
  section: string;
  subsection: string | null;
  score: number;
  text: string;
}

/** Individual paragraphs and list items that contain every term of the query. */
export function searchPassages(document: string, md: string, q: SearchQuery): PassageHit[] {
  const out: PassageHit[] = [];
  for (const s of splitSections(md)) {
    for (const sub of splitSubsections(s.body)) {
      for (const para of splitPassages(sub.body)) {
        const score = scoreText(para, q);
        if (score) {
          out.push({
            document,
            section: s.heading,
            subsection: sub.heading,
            score,
            text: para.length > 1600 ? `${para.slice(0, 1600)}...` : para,
          });
        }
      }
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Headings tree: h2 sections with their h3 subsections and sizes. */
export function outline(md: string): { section: string; chars: number; first_sentence: string; subsections: string[] }[] {
  return splitSections(md).map((s) => ({
    section: s.heading,
    chars: s.chars,
    first_sentence: s.firstSentence,
    subsections: splitSubsections(s.body)
      .map((x) => x.heading)
      .filter((h): h is string => h !== null),
  }));
}
