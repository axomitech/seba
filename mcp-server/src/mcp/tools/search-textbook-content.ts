import { defineTool } from "./define";
import { schemas } from "../schemas/tool-schemas";
import { assertQuery, searchContent } from "../../services/textbook-search";
import { contentMeta, presentPassage } from "../../services/present";

export const searchTextbookContentTool = defineTool({
  name: "search_textbook_content",
  title: "Search textbook content",
  description:
    "Keyword and (when enabled) semantic search over indexed textbook passages. Each passage carries textbook, class, subject, medium, chapter, " +
    "PDF and printed page numbers, a ready-made citation and the official PDF URL. Cite using the citation field; do not invent references.",
  inputSchema: schemas.search_textbook_content,
  async run(ctx, input) {
    const query = assertQuery(input.query);
    const result = await ctx.withDb((db) =>
      searchContent({ db, settings: ctx.settings, embedQuery: ctx.embedQuery }, {
        query, limit: input.limit, mode: input.mode,
        filters: { class: input.class, subject: input.subject, medium: input.medium, subject_type: input.subject_type, textbook_ids: input.textbook_ids },
      }));
    return {
      query, search_mode: result.mode_used, count: result.rows.length,
      passages: result.rows.map((r) => presentPassage(r, ctx.settings, result.mode_used)),
      ...(result.notes.length ? { notes: result.notes } : {}),
      ...(result.rows.length === 0 ? { note: "No indexed passages matched. Only textbooks with content_status 'indexed' are searchable." } : {}),
      ...contentMeta(ctx.settings),
    };
  },
});
