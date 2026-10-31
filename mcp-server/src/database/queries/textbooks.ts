import type { Db } from "../client";
import { Params, TEXTBOOK_FROM, decodeCursor, encodeCursor, textbookWhere, type TextbookFilters } from "./sql";
import { AppError, notFound } from "../../utils/errors";
import { escapeLike } from "../../utils/text";

export interface TextbookSummary {
  textbook_id: string;
  title: string;
  class: string;
  subject: string;
  medium: string;
  medium_as_listed: string;
  subject_type: string | null;
  academic_session: string | null;
  content_status: "indexed" | "not_indexed" | "unsupported_format" | "no_pdf";
  source_url: string | null;
  source_kind: string | null;
}

const SUMMARY_COLS = `
  t.id AS textbook_id, t.title, t.class_label AS class, s.name AS subject, l.name AS medium,
  t.medium_label AS medium_as_listed, t.subject_type, t.academic_session,
  CASE WHEN src.id IS NULL THEN 'no_pdf'
       WHEN src.status = 'indexed' THEN 'indexed'
       WHEN src.status = 'unsupported' THEN 'unsupported_format'
       WHEN src.status = 'unavailable' THEN 'no_pdf'
       ELSE 'not_indexed' END AS content_status,
  src.url AS source_url, src.url_kind AS source_kind`;

interface ListCursor { c: string; k: string; i: string }
const isListCursor = (v: unknown): v is ListCursor =>
  typeof v === "object" && v !== null && typeof (v as ListCursor).c === "string" &&
  typeof (v as ListCursor).k === "string" && /^[0-9a-f-]{36}$/.test((v as ListCursor).i);

export async function listTextbooks(db: Db, filters: TextbookFilters, limit: number, cursor?: string) {
  const p = new Params();
  const where = textbookWhere(filters, p);
  if (cursor) {
    const cur = decodeCursor(cursor, isListCursor);
    if (!cur) throw new AppError("invalid_input", "Invalid cursor");
    where.push(`(t.class_label, lower(t.title), t.id) > (${p.add(cur.c)}, ${p.add(cur.k)}, ${p.add(cur.i)}::uuid)`);
  }
  const rows = await db.query<TextbookSummary & { sort_key: string }>(
    `SELECT ${SUMMARY_COLS}, lower(t.title) AS sort_key ${TEXTBOOK_FROM}
     WHERE ${where.join(" AND ")}
     ORDER BY t.class_label, lower(t.title), t.id LIMIT ${p.add(limit + 1)}`,
    p.values,
  );
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  const next_cursor = rows.length > limit && last ? encodeCursor({ c: last.class, k: last.sort_key, i: last.textbook_id }) : null;
  return { textbooks: page.map(({ sort_key: _sk, ...r }) => r), next_cursor };
}

export interface TextbookDetails extends TextbookSummary {
  catalogue_serial: number | null;
  page_count: number | null;
  chapter_count: number;
  chunk_count: number;
  indexed_at: string | null;
  source_last_modified: string | null;
  extraction_summary: Record<string, unknown> | null;
}

export async function getTextbook(db: Db, id: string): Promise<TextbookDetails> {
  const rows = await db.query<TextbookDetails>(
    `SELECT ${SUMMARY_COLS}, t.catalogue_serial, src.page_count, src.indexed_at, src.http_last_modified AS source_last_modified,
            src.extraction_summary,
            (SELECT count(*)::int FROM chapters c WHERE c.source_id = t.source_id) AS chapter_count,
            (SELECT count(*)::int FROM textbook_chunks k WHERE k.source_id = t.source_id) AS chunk_count
     ${TEXTBOOK_FROM} WHERE t.id = $1 AND t.catalogue_status = 'listed'`,
    [id],
  );
  if (!rows[0]) throw notFound("Textbook");
  return rows[0];
}

/** Title/subject search ranked by trigram similarity (works for Latin and Indic scripts). */
export async function searchTextbooks(db: Db, query: string, filters: TextbookFilters, limit: number) {
  const p = new Params();
  const q = p.add(query);
  const like = p.add(`%${escapeLike(query)}%`);
  const where = textbookWhere(filters, p);
  where.push(`(t.title ILIKE ${like} ESCAPE '\\' OR s.name ILIKE ${like} ESCAPE '\\' OR similarity(t.title, ${q}) > 0.25)`);
  const rows = await db.query<TextbookSummary & { score: number }>(
    `SELECT ${SUMMARY_COLS},
            GREATEST(similarity(t.title, ${q}), similarity(s.name, ${q}),
                     CASE WHEN t.title ILIKE ${like} ESCAPE '\\' THEN 0.9 ELSE 0 END) AS score
     ${TEXTBOOK_FROM} WHERE ${where.join(" AND ")}
     ORDER BY score DESC, t.class_label, t.title LIMIT ${p.add(limit)}`,
    p.values,
  );
  return rows.map((r) => ({ ...r, score: Number(Number(r.score).toFixed(3)) }));
}

export async function getPdfSource(db: Db, id: string) {
  const rows = await db.query<{
    textbook_id: string; title: string; source_url: string | null; source_kind: string | null;
    http_last_modified: string | null; discovered_from: string | null; status: string | null;
  }>(
    `SELECT t.id AS textbook_id, t.title, src.url AS source_url, src.url_kind AS source_kind,
            src.http_last_modified, src.discovered_from, src.status
     ${TEXTBOOK_FROM} WHERE t.id = $1 AND t.catalogue_status = 'listed'`,
    [id],
  );
  if (!rows[0]) throw notFound("Textbook");
  return rows[0];
}
