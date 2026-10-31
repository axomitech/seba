import type { Db } from "../client";
import { Params, TEXTBOOK_FROM, textbookWhere, type TextbookFilters } from "./sql";
import { AppError, notFound } from "../../utils/errors";
import { escapeLike, toWebSearchQuery } from "../../utils/text";

export interface PassageRow {
  chunk_id: string;
  textbook_id: string;
  title: string;
  class: string;
  subject: string;
  medium: string;
  source_url: string | null;
  chapter_id: string | null;
  chapter_number: string | null;
  chapter_title: string | null;
  page_start: number;
  page_end: number;
  printed_page_start: string | null;
  chunk_kind: "body" | "exercise";
  content: string;
  score: number;
}

export type SearchMode = "keyword" | "semantic" | "hybrid";

export interface SearchOptions {
  filters: TextbookFilters;
  limit: number;
  kind?: "body" | "exercise";
  /** keep at most N hits per textbook (used by topic comparison) */
  perBook?: number;
  chapterId?: string;
}

const PASSAGE_COLS = `
  h.chunk_id, h.textbook_id, t.title, t.class_label AS class, s.name AS subject, l.name AS medium,
  src.url AS source_url, h.chapter_id, ch.chapter_number, ch.title AS chapter_title,
  h.page_start, h.page_end, h.chunk_kind, h.content, h.score,
  (SELECT p.printed_page FROM textbook_pages p WHERE p.source_id = h.source_id AND p.pdf_page_index = h.page_start) AS printed_page_start`;

const PASSAGE_JOINS = `
  JOIN textbooks t ON t.id = h.textbook_id
  JOIN subjects s ON s.id = t.subject_id
  JOIN languages l ON l.id = t.language_id
  LEFT JOIN textbook_sources src ON src.id = h.source_id
  LEFT JOIN chapters ch ON ch.id = h.chapter_id`;

/** Final stage shared by keyword and semantic: dedupe shared PDFs, per-book cap, limit, enrich. */
function rankedTail(p: Params, opts: SearchOptions): string {
  const dedupe = !opts.filters.textbook_ids?.length;
  const inner = `SELECT hits.*, ${dedupe ? "row_number() OVER (PARTITION BY hits.chunk_id ORDER BY hits.textbook_id)" : "1"} AS dup_rn,
       row_number() OVER (PARTITION BY hits.textbook_id ORDER BY hits.score DESC) AS book_rn FROM hits`;
  const perBook = opts.perBook ? `AND h.book_rn <= ${p.add(opts.perBook)}` : "";
  return `, ranked AS (${inner})
    SELECT ${PASSAGE_COLS} FROM ranked h ${PASSAGE_JOINS}
    WHERE h.dup_rn = 1 ${perBook} ORDER BY h.score DESC, h.chunk_id LIMIT ${p.add(opts.limit)}`;
}

function commonWhere(opts: SearchOptions, p: Params): string[] {
  const w = textbookWhere(opts.filters, p);
  w.push(`src.status = 'indexed'`);
  if (opts.kind) w.push(`c.chunk_kind = ${p.add(opts.kind)}`);
  if (opts.chapterId) w.push(`c.chapter_id = ${p.add(opts.chapterId)}::uuid`);
  return w;
}

/** Keyword search: PostgreSQL full-text ('simple' config, no stemming so Assamese is untouched) plus
 *  trigram-indexed substring match, which also handles Indic scripts where tokenisation is lossy. */
export async function keywordSearch(db: Db, query: string, opts: SearchOptions): Promise<PassageRow[]> {
  const p = new Params();
  const tsq = p.add(toWebSearchQuery(query));
  const like = p.add(`%${escapeLike(query)}%`);
  const where = commonWhere(opts, p);
  where.push(`(c.content_tsv @@ websearch_to_tsquery('simple', ${tsq}) OR c.content ILIKE ${like} ESCAPE '\\')`);
  const pool = Math.min(Math.max(opts.limit * 4, 40), 200);
  const sql = `
    WITH hits AS (
      SELECT c.id AS chunk_id, t.id AS textbook_id, c.source_id, c.chapter_id, c.page_start, c.page_end,
             c.chunk_kind, c.content,
             (ts_rank_cd(c.content_tsv, websearch_to_tsquery('simple', ${tsq}))
              + CASE WHEN c.content ILIKE ${like} ESCAPE '\\' THEN 0.5 ELSE 0 END)::float8 AS score
      ${TEXTBOOK_FROM.replace("FROM textbooks t", "FROM textbook_chunks c JOIN textbooks t ON t.source_id = c.source_id")}
      WHERE ${where.join(" AND ")}
      ORDER BY score DESC LIMIT ${pool}
    )${rankedTail(p, opts)}`;
  return normaliseRows(await db.query<PassageRow>(sql, p.values));
}

/** Vector search over stored embeddings (cosine distance). `vector` must match the stored model. */
export async function semanticSearch(db: Db, vector: number[], model: string, opts: SearchOptions): Promise<PassageRow[]> {
  if (vector.length !== 1024 || vector.some((x) => !Number.isFinite(x))) {
    throw new AppError("internal", "Invalid query embedding");
  }
  const p = new Params();
  const vec = p.add(`[${vector.join(",")}]`);
  const mdl = p.add(model);
  const where = commonWhere(opts, p);
  where.push(`e.model = ${mdl}`);
  const pool = Math.min(Math.max(opts.limit * 4, 40), 200);
  const sql = `
    WITH hits AS (
      SELECT c.id AS chunk_id, t.id AS textbook_id, c.source_id, c.chapter_id, c.page_start, c.page_end,
             c.chunk_kind, c.content, (1 - (e.embedding <=> ${vec}::vector))::float8 AS score
      ${TEXTBOOK_FROM.replace("FROM textbooks t", "FROM textbook_embeddings e JOIN textbook_chunks c ON c.id = e.chunk_id JOIN textbooks t ON t.source_id = c.source_id")}
      WHERE ${where.join(" AND ")}
      ORDER BY e.embedding <=> ${vec}::vector LIMIT ${pool}
    )${rankedTail(p, opts)}`;
  return normaliseRows(await db.query<PassageRow>(sql, p.values));
}

/** Reciprocal-rank fusion of keyword and semantic lists. */
export function fuse(lists: PassageRow[][], limit: number, perBook?: number): PassageRow[] {
  const scores = new Map<string, { row: PassageRow; score: number }>();
  for (const list of lists) {
    list.forEach((row, rank) => {
      const key = `${row.textbook_id}:${row.chunk_id}`;
      const cur = scores.get(key) ?? { row, score: 0 };
      cur.score += 1 / (60 + rank + 1);
      scores.set(key, cur);
    });
  }
  const sorted = [...scores.values()].sort((a, b) => b.score - a.score);
  const counts = new Map<string, number>();
  const out: PassageRow[] = [];
  for (const { row, score } of sorted) {
    const n = counts.get(row.textbook_id) ?? 0;
    if (perBook && n >= perBook) continue;
    counts.set(row.textbook_id, n + 1);
    out.push({ ...row, score: Number(score.toFixed(5)) });
    if (out.length >= limit) break;
  }
  return out;
}

function normaliseRows(rows: PassageRow[]): PassageRow[] {
  return rows.map((r) => ({ ...r, score: Number(Number(r.score).toFixed(4)) }));
}

export interface PageRow {
  pdf_page_index: number;
  printed_page: string | null;
  content: string;
  extraction_method: "text" | "ocr" | "empty";
  ocr_confidence: number | null;
  chapter_id: string | null;
  chapter_number: string | null;
  chapter_title: string | null;
}

const PAGE_COLS = `p.pdf_page_index, p.printed_page, p.content, p.extraction_method, p.ocr_confidence,
                   p.chapter_id, ch.chapter_number, ch.title AS chapter_title`;

export async function getPage(db: Db, textbookId: string, page: number, pageType: "pdf" | "printed") {
  const rows = await db.query<PageRow & { page_count: number | null }>(
    `SELECT ${PAGE_COLS}, src.page_count
     FROM textbooks t JOIN textbook_sources src ON src.id = t.source_id
     JOIN textbook_pages p ON p.source_id = t.source_id
     LEFT JOIN chapters ch ON ch.id = p.chapter_id
     WHERE t.id = $1 AND t.catalogue_status = 'listed' AND ${pageType === "pdf" ? "p.pdf_page_index = $2::int" : "p.printed_page = $2::text"}
     ORDER BY p.pdf_page_index LIMIT 1`,
    [textbookId, pageType === "pdf" ? page : String(page)],
  );
  if (rows[0]) return rows[0];
  const exists = await db.query<{ page_count: number | null; status: string | null }>(
    `SELECT src.page_count, src.status FROM textbooks t LEFT JOIN textbook_sources src ON src.id = t.source_id
     WHERE t.id = $1 AND t.catalogue_status = 'listed'`,
    [textbookId],
  );
  if (!exists[0]) throw notFound("Textbook");
  if (exists[0].status !== "indexed") throw new AppError("not_found", "This textbook has not been indexed yet; no page text is available.", 404);
  const total = exists[0].page_count;
  throw new AppError("not_found", pageType === "pdf" && total
    ? `Page ${page} does not exist; this PDF has ${total} pages.`
    : `No page with printed number ${page} was found (printed page numbers are only known for some pages).`, 404);
}

/** Pages of a chapter (or whole range) starting at `fromPage`, up to `limit` rows. */
export async function getPagesInRange(db: Db, sourceId: string, from: number, to: number, limit: number) {
  return db.query<PageRow>(
    `SELECT ${PAGE_COLS} FROM textbook_pages p LEFT JOIN chapters ch ON ch.id = p.chapter_id
     WHERE p.source_id = $1 AND p.pdf_page_index BETWEEN $2 AND $3 ORDER BY p.pdf_page_index LIMIT $4`,
    [sourceId, from, to, limit],
  );
}

export interface ExerciseRow {
  chunk_id: string;
  chunk_index: number;
  page_start: number;
  page_end: number;
  content: string;
  chapter_id: string | null;
  chapter_number: string | null;
  chapter_title: string | null;
}

export async function getExerciseChunks(db: Db, sourceId: string, chapterId: string | null, afterIndex: number, limit: number) {
  const p = new Params();
  const where = [`c.source_id = ${p.add(sourceId)}`, `c.chunk_kind = 'exercise'`, `c.chunk_index > ${p.add(afterIndex)}`];
  if (chapterId) where.push(`c.chapter_id = ${p.add(chapterId)}::uuid`);
  return db.query<ExerciseRow>(
    `SELECT c.id AS chunk_id, c.chunk_index, c.page_start, c.page_end, c.content, c.chapter_id,
            ch.chapter_number, ch.title AS chapter_title
     FROM textbook_chunks c LEFT JOIN chapters ch ON ch.id = c.chapter_id
     WHERE ${where.join(" AND ")} ORDER BY c.chunk_index LIMIT ${p.add(limit + 1)}`,
    p.values,
  );
}

export async function getTextbookSource(db: Db, textbookId: string) {
  const rows = await db.query<{ source_id: string | null; title: string; status: string | null; class: string; subject: string; medium: string; source_url: string | null }>(
    `SELECT t.source_id, t.title, src.status, t.class_label AS class, s.name AS subject, l.name AS medium, src.url AS source_url
     ${TEXTBOOK_FROM} WHERE t.id = $1 AND t.catalogue_status = 'listed'`,
    [textbookId],
  );
  if (!rows[0]) throw notFound("Textbook");
  return rows[0];
}
