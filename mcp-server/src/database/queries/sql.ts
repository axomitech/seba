import { escapeLike } from "../../utils/text";

/** Collects bind parameters and hands out $n placeholders. Caller data never enters SQL text. */
export class Params {
  readonly values: unknown[] = [];
  add(v: unknown): string {
    this.values.push(v);
    return `$${this.values.length}`;
  }
}

export interface TextbookFilters {
  class?: "IX" | "X";
  subject?: string;
  medium?: string;
  subject_type?: string;
  textbook_ids?: string[];
  /** also match books whose catalogue medium is "All" when a medium filter is given (default true) */
  include_all_medium?: boolean;
  indexed_only?: boolean;
}

/** FROM clause shared by every query that needs book metadata. */
export const TEXTBOOK_FROM = `
  FROM textbooks t
  JOIN subjects s ON s.id = t.subject_id
  JOIN languages l ON l.id = t.language_id
  LEFT JOIN textbook_sources src ON src.id = t.source_id`;

/** WHERE fragments (all start with t.catalogue_status) for the given filters. */
export function textbookWhere(f: TextbookFilters, p: Params): string[] {
  const w = ["t.catalogue_status = 'listed'"];
  if (f.class) w.push(`(t.class_label = ${p.add(f.class)} OR t.class_label = 'IX-X')`);
  if (f.subject) w.push(`s.name ILIKE ${p.add(`%${escapeLike(f.subject)}%`)} ESCAPE '\\'`);
  if (f.medium) {
    const code = f.medium.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-");
    const ph = p.add(code);
    w.push(f.include_all_medium === false ? `l.code = ${ph}` : `(l.code = ${ph} OR l.code = 'all')`);
  }
  if (f.subject_type) w.push(`lower(t.subject_type) = ${p.add(f.subject_type.toLowerCase())}`);
  if (f.textbook_ids?.length) w.push(`t.id = ANY(${p.add(f.textbook_ids)}::uuid[])`);
  if (f.indexed_only) w.push(`src.status = 'indexed'`);
  return w;
}

/** Decode a client-supplied cursor. Returns null for anything malformed. */
export function decodeCursor<T>(cursor: string | undefined, guard: (v: unknown) => v is T): T | null {
  if (!cursor) return null;
  try {
    const json = new TextDecoder().decode(Uint8Array.from(atob(cursor.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)));
    const v: unknown = JSON.parse(json);
    return guard(v) ? v : null;
  } catch {
    return null;
  }
}

export function encodeCursor(v: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(v));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
