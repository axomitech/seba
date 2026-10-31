import { defineTool } from "./define";
import { schemas } from "../schemas/tool-schemas";
import { getChapters } from "../../database/queries/chapters";

export const getChaptersTool = defineTool({
  name: "get_chapters",
  title: "Get chapter list",
  description:
    "Ordered chapter list of a textbook with page ranges (PDF page indexes). Chapters come from the PDF outline when reliable, otherwise from heading detection; " +
    "detection_method and chapter_quality say which, and an empty list means no chapters could be identified (page content is still available).",
  inputSchema: schemas.get_chapters,
  async run(ctx, input) {
    const { chapters, chapter_quality } = await ctx.withDb((db) => getChapters(db, input.textbook_id));
    return {
      textbook_id: input.textbook_id, chapters, count: chapters.length, chapter_quality,
      ...(chapters.length === 0 ? { note: "No chapters were extracted for this book (not indexed yet, or no reliable chapter structure). Use get_page_content or search_textbook_content." } : {}),
    };
  },
});
