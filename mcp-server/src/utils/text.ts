/** NFC-normalise and collapse whitespace so equivalent Assamese/Unicode input compares equal. */
export function normalizeQuery(q: string): string {
  return q.normalize("NFC").replace(/\s+/g, " ").trim();
}

/** Escape LIKE/ILIKE metacharacters (use with ESCAPE '\'). */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/** Word-ish tokens (letters, combining marks, digits) for building OR-style full-text queries. */
export function tokenize(q: string): string[] {
  return normalizeQuery(q).match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
}

// Question/function words that carry no topic signal. Removing them stops "what is X?" from requiring
// the literal words "what" and "is" in the passage (the 'simple' text-search config has no stopwords).
const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "of", "in", "on", "at", "to", "for", "and", "or", "by", "with", "from", "as", "it", "its",
  "what", "which", "who", "whom", "whose", "why", "how", "when", "where", "does", "do", "did", "explain", "define", "describe", "tell", "me", "about", "give",
  "কি", "কী", "কিয়", "কেনেকৈ", "কোন", "কোনটো", "কোনবোৰ", "কেতিয়া", "ক’ত", "ক'ত", "কাক", "কাৰ", "আৰু", "বা", "হয়", "নহয়", "হ’ল", "হ'ল", "এটা", "এই", "সেই",
]);

/**
 * Text for PostgreSQL websearch_to_tsquery('simple', ...). Stopwords are dropped first. Up to two remaining
 * terms stay AND-ed (precise); longer natural-language questions become OR-ed so one missing word does not
 * zero the result, and ts_rank_cd then favours passages matching more terms.
 */
export function toWebSearchQuery(q: string): string {
  const all = [...new Set(tokenize(q).filter((t) => [...t].length >= 2))];
  const content = all.filter((t) => !STOPWORDS.has(t.toLowerCase()));
  const tokens = (content.length ? content : all).slice(0, 12);
  if (tokens.length === 0) return normalizeQuery(q);
  return tokens.length <= 2 ? tokens.join(" ") : tokens.join(" or ");
}

/** Truncate at a word boundary. Returns the text and whether it was cut. */
export function excerpt(text: string, max: number): { text: string; truncated: boolean } {
  if ([...text].length <= max) return { text, truncated: false };
  const cut = [...text].slice(0, max).join("");
  const sp = cut.lastIndexOf(" ");
  return { text: (sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd() + " …", truncated: true };
}

export interface ParsedQuestion {
  number: string;
  text: string;
}

// "1.", "2)", "Q3.", "২.", or a lettered sub-part "(a)" / "(iv)"
const Q_START = /^\s*(?:Q\.?\s*)?(?:(\d{1,3}|[০-৯]{1,3}|[०-९]{1,3}|[ivx]{1,4})[.)]|(\([a-z]\)|\([ivx]{1,4}\)))\s+(\S.*)$/iu;

/** Best-effort split of an exercise block into numbered questions. Never invents numbering. */
export function splitQuestions(block: string): ParsedQuestion[] {
  const out: ParsedQuestion[] = [];
  for (const line of block.split(/\n+/)) {
    const m = Q_START.exec(line);
    if (m) out.push({ number: (m[1] ?? m[2])!, text: m[3]!.trim() });
    else if (out.length && line.trim()) out[out.length - 1]!.text += " " + line.trim();
  }
  return out;
}
