import { defineTool } from "./define";
import { schemas } from "../schemas/tool-schemas";
import { resolveChapter } from "../../database/queries/chapters";
import { getPagesInRange, getTextbookSource } from "../../database/queries/content";
import { contentMeta, presentPage } from "../../services/present";

export const getChapterContentTool = defineTool({
  name: "get_chapter_content",
  title: "Get chapter content",
  description:
    "Text of a chapter, page by page with page references. Identify the chapter by chapter_id, or by textbook_id plus chapter_number/chapter_ordinal. " +
    "Large chapters are paginated by size: pass next_from_page as from_page to continue.",
  inputSchema: schemas.get_chapter_content,
  async run(ctx, input) {
    const { textbook_id, source_id, chapter } = await ctx.withDb((db) => resolveChapter(db, input));
    const from = Math.min(Math.max(input.from_page ?? chapter.start_page, chapter.start_page), chapter.end_page);
    const { rows, book } = await ctx.withDb(async (db) => ({
      rows: await getPagesInRange(db, source_id, from, chapter.end_page, 200),
      book: await getTextbookSource(db, textbook_id),
    }));
    const pages: ReturnType<typeof presentPage>[] = [];
    let used = 0;
    let next: number | null = null;
    for (const r of rows) {
      const p = presentPage(r, ctx.settings);
      if (pages.length > 0 && used + p.text.length > input.max_chars) { next = r.pdf_page_index; break; }
      pages.push(p);
      used += p.text.length;
    }
    return {
      textbook_id, textbook_title: book.title, class: book.class, subject: book.subject, medium: book.medium, source_pdf_url: book.source_url,
      chapter: { chapter_id: chapter.chapter_id, number: chapter.chapter_number, title: chapter.title, ordinal: chapter.ordinal,
                 pdf_pages: { start: chapter.start_page, end: chapter.end_page }, detection_method: chapter.detection_method },
      pages, next_from_page: next, ...contentMeta(ctx.settings),
    };
  },
});
