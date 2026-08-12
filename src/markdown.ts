export interface Section {
  heading: string;
  body: string;
  chars: number;
  firstSentence: string;
}

export interface SectionSummary {
  heading: string;
  chars: number;
  first_sentence: string;
}

const FIRST_SENTENCE_BUDGET = 240;

/**
 * Split a document on h2 headings only. An h3 must not break its parent section:
 * "## Business" followed by "### Segments" is one section, not two. Getting this
 * wrong is how the site's own section-lead extractor once returned empty for Visa.
 */
export function splitSections(md: string): Section[] {
  const sections: Section[] = [];
  let heading: string | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (heading === null) return;
    const body = buffer.join("\n").trim();
    sections.push({ heading, body, chars: body.length, firstSentence: firstSentence(body) });
  };

  for (const line of md.split("\n")) {
    // Exactly two hashes then whitespace. "### Segments" does not match.
    const m = /^##[ \t]+(.*\S)[ \t]*$/.exec(line);
    if (m) {
      flush();
      heading = m[1];
      buffer = [];
    } else if (heading !== null) {
      buffer.push(line);
    }
  }
  flush();
  return sections;
}

/**
 * First real sentence of a section. Pipe-table rows, headings and rules are skipped:
 * a table row has no sentence terminator, so including it produces one unsplittable
 * blob. That is how AVGO once produced an empty lead.
 */
export function firstSentence(body: string, budget = FIRST_SENTENCE_BUDGET): string {
  const prose = body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("|") && !l.startsWith("#") && !/^[-*_]{3,}$/.test(l))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (!prose) return "";

  const m = /^(.{20,}?[.!?])(\s|$)/.exec(prose);
  let out = m ? m[1] : prose;
  if (out.length > budget) {
    const cut = out.slice(0, budget);
    const space = cut.lastIndexOf(" ");
    out = (space > 40 ? cut.slice(0, space) : cut) + "...";
  }
  return out;
}

/**
 * Find a section by fuzzy name: exact, then unique prefix, then unique substring.
 * Headings are never hardcoded anywhere. They carry variable suffixes such as
 * "fiscal 2026" and "Q1 fiscal 2027" that change every quarter.
 */
export function findSection(sections: Section[], name: string): Section | null {
  const q = name.trim().toLowerCase();
  if (!q) return null;

  const exact = sections.find((s) => s.heading.toLowerCase() === q);
  if (exact) return exact;

  const prefix = sections.filter((s) => s.heading.toLowerCase().startsWith(q));
  if (prefix.length === 1) return prefix[0];

  const contains = sections.filter((s) => s.heading.toLowerCase().includes(q));
  if (contains.length === 1) return contains[0];

  // Ambiguous or absent. The caller reports the full heading list.
  return null;
}

export function sectionIndex(md: string): SectionSummary[] {
  return splitSections(md).map((s) => ({
    heading: s.heading,
    chars: s.chars,
    first_sentence: s.firstSentence,
  }));
}
