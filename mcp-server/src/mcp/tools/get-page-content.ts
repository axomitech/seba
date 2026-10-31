import { defineTool } from "./define";
import { schemas } from "../schemas/tool-schemas";
import { getPage, getTextbookSource } from "../../database/queries/content";
import { contentMeta, presentPage } from "../../services/present";

export const getPageContentTool = defineTool({
  name: "get_page_content",
  title: "Get page content",
  description: "Extracted text of one page, by PDF page index (default) or by printed page number, with chapter and extraction-quality metadata.",
  inputSchema: schemas.get_page_content,
  async run(ctx, input) {
    const { page, book } = await ctx.withDb(async (db) => ({
      page: await getPage(db, input.textbook_id, input.page, input.page_type),
      book: await getTextbookSource(db, input.textbook_id),
    }));
    return {
      textbook_id: input.textbook_id, textbook_title: book.title, class: book.class, subject: book.subject, medium: book.medium,
      page: presentPage(page, ctx.settings), source_pdf_url: book.source_url, ...contentMeta(ctx.settings),
    };
  },
});
