import type { ToolContext } from "../mcp/tools/define";
import type { TextbookFilters } from "../database/queries/sql";
import { resolveChapter } from "../database/queries/chapters";
import { getPagesInRange, type PassageRow } from "../database/queries/content";
import { getTextbookSource } from "../database/queries/content";
import type { Evidence, RetrievalPort } from "./tutor";
import { searchContent } from "./textbook-search";

export function passageToEvidence(r: PassageRow): Evidence {
  return {
    textbook_id: r.textbook_id, title: r.title, class: r.class, subject: r.subject, medium: r.medium,
    chapter_number: r.chapter_number, chapter_title: r.chapter_title,
    pdf_page_start: r.page_start, pdf_page_end: r.page_end, printed_page_start: r.printed_page_start,
    source_pdf_url: r.source_url, text: r.content,
  };
}

/** Database-backed implementation of the tutor's retrieval port. */
export function createRetrievalPort(ctx: ToolContext, filters: TextbookFilters): RetrievalPort {
  return {
    async search(query, limit) {
      const res = await ctx.withDb((db) =>
        searchContent({ db, settings: ctx.settings, embedQuery: ctx.embedQuery }, { query, limit, mode: "auto", filters }));
      return res.rows.map(passageToEvidence);
    },
    async chapter(chapterId, maxChars) {
      return ctx.withDb(async (db) => {
        const ref = await resolveChapter(db, { chapter_id: chapterId });
        const book = await getTextbookSource(db, ref.textbook_id);
        const pages = await getPagesInRange(db, ref.source_id, ref.chapter.start_page, ref.chapter.end_page, 60);
        const out: Evidence[] = [];
        let used = 0;
        for (const p of pages) {
          if (!p.content.trim()) continue;
          if (used + p.content.length > maxChars && out.length) break;
          used += p.content.length;
          out.push({
            textbook_id: ref.textbook_id, title: book.title, class: book.class, subject: book.subject, medium: book.medium,
            chapter_number: ref.chapter.chapter_number, chapter_title: ref.chapter.title,
            pdf_page_start: p.pdf_page_index, pdf_page_end: p.pdf_page_index, printed_page_start: p.printed_page,
            source_pdf_url: book.source_url, text: p.content,
          });
        }
        return out;
      });
    },
  };
}
