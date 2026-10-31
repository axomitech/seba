/** Deterministic source references. The model never supplies book names or page numbers. */
export interface SourceRef {
  /** short handle shown to the model, e.g. "S1" */
  ref: string;
  textbook_id: string;
  title: string;
  class: string;
  subject: string;
  medium: string;
  chapter_number: string | null;
  chapter_title: string | null;
  pdf_page_start: number;
  pdf_page_end: number;
  printed_page_start: string | null;
  source_pdf_url: string | null;
}

export function buildCitation(r: Omit<SourceRef, "ref">): string {
  const chapter = r.chapter_title
    ? `, ${r.chapter_number ? `Chapter ${r.chapter_number}: ` : "Chapter: "}${r.chapter_title}`
    : "";
  const pages = r.pdf_page_start === r.pdf_page_end ? `PDF p. ${r.pdf_page_start}` : `PDF pp. ${r.pdf_page_start}–${r.pdf_page_end}`;
  const printed = r.printed_page_start ? ` (printed p. ${r.printed_page_start})` : "";
  return `${r.title} — Class ${r.class}, ${r.subject} (${r.medium})${chapter}, ${pages}${printed}`;
}

const CITE_RE = /\[(S\d{1,3})\]/g;

export function citedRefs(answer: string): string[] {
  return [...new Set([...answer.matchAll(CITE_RE)].map((m) => m[1]!))];
}

/**
 * Check which [S#] markers in a model answer correspond to passages that were really retrieved.
 * Unknown markers are stripped so a hallucinated reference can never reach the user.
 */
export function validateCitations(answer: string, allowed: ReadonlySet<string>) {
  const cited = citedRefs(answer);
  const valid = cited.filter((c) => allowed.has(c));
  const invalid = cited.filter((c) => !allowed.has(c));
  const cleaned = answer.replace(CITE_RE, (m, id: string) => (allowed.has(id) ? m : "")).replace(/ {2,}/g, " ");
  return { valid, invalid, cleaned };
}
