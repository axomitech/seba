import type { Db } from "../client";
import { AppError, notFound } from "../../utils/errors";

export interface ChapterRow {
  chapter_id: string;
  ordinal: number;
  chapter_number: string | null;
  title: string;
  start_page: number;
  end_page: number;
  detection_method: string;
}

export interface ChapterRef {
  textbook_id: string;
  source_id: string;
  chapter: ChapterRow;
}

export async function getChapters(db: Db, textbookId: string) {
  const book = await db.query<{ source_id: string | null; chapter_quality: unknown }>(
    `SELECT t.source_id, src.extraction_summary->'chapter_quality' AS chapter_quality
     FROM textbooks t LEFT JOIN textbook_sources src ON src.id = t.source_id
     WHERE t.id = $1 AND t.catalogue_status = 'listed'`,
    [textbookId],
  );
  if (!book[0]) throw notFound("Textbook");
  if (!book[0].source_id) return { chapters: [] as ChapterRow[], chapter_quality: null };
  const chapters = await db.query<ChapterRow>(
    `SELECT id AS chapter_id, ordinal, chapter_number, title, start_page, end_page, detection_method
     FROM chapters WHERE source_id = $1 ORDER BY ordinal`,
    [book[0].source_id],
  );
  return { chapters, chapter_quality: book[0].chapter_quality ?? null };
}

export interface ChapterSelector {
  chapter_id?: string;
  textbook_id?: string;
  chapter_number?: string;
  chapter_ordinal?: number;
}

/** Resolve a chapter by id, or by textbook + printed chapter number / ordinal. */
export async function resolveChapter(db: Db, sel: ChapterSelector): Promise<ChapterRef> {
  let rows: Array<ChapterRow & { textbook_id: string; source_id: string }>;
  const cols = `c.id AS chapter_id, c.ordinal, c.chapter_number, c.title, c.start_page, c.end_page,
                c.detection_method, c.source_id`;
  if (sel.chapter_id) {
    rows = await db.query(
      `SELECT ${cols}, (SELECT t.id FROM textbooks t WHERE t.source_id = c.source_id AND t.catalogue_status='listed'
                        ORDER BY ${sel.textbook_id ? "(t.id = $2::uuid) DESC," : ""} t.class_label LIMIT 1) AS textbook_id
       FROM chapters c WHERE c.id = $1`,
      sel.textbook_id ? [sel.chapter_id, sel.textbook_id] : [sel.chapter_id],
    );
  } else if (sel.textbook_id && (sel.chapter_number || sel.chapter_ordinal)) {
    rows = await db.query(
      `SELECT ${cols}, t.id AS textbook_id FROM textbooks t JOIN chapters c ON c.source_id = t.source_id
       WHERE t.id = $1 AND t.catalogue_status = 'listed'
         AND ${sel.chapter_number ? "c.chapter_number = $2" : "c.ordinal = $2"}
       ORDER BY c.ordinal LIMIT 1`,
      [sel.textbook_id, sel.chapter_number ?? sel.chapter_ordinal],
    );
  } else {
    throw new AppError("invalid_input", "Provide chapter_id, or textbook_id with chapter_number or chapter_ordinal");
  }
  const r = rows[0];
  if (!r || !r.textbook_id) throw notFound("Chapter");
  const { textbook_id, source_id, ...chapter } = r;
  return { textbook_id, source_id, chapter };
}
