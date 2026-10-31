import { defineTool } from "./define";
import { schemas } from "../schemas/tool-schemas";
import { listTextbooks } from "../../database/queries/textbooks";

export const listTextbooksTool = defineTool({
  name: "list_textbooks",
  title: "List SEBA textbooks",
  description:
    "List official SEBA/ASSEB Class IX and X textbooks, optionally filtered by class, subject, medium (language) and subject type. " +
    "Paginated: pass next_cursor back as cursor. content_status tells whether the book's text is indexed for search.",
  inputSchema: schemas.list_textbooks,
  async run(ctx, input) {
    const { textbooks, next_cursor } = await ctx.withDb((db) =>
      listTextbooks(db, { class: input.class, subject: input.subject, medium: input.medium, subject_type: input.subject_type, indexed_only: input.indexed_only }, input.limit, input.cursor));
    return {
      textbooks, next_cursor, count: textbooks.length,
      ...(input.academic_session ? { note: "academic_session filtering is not available: the SEBA catalogue does not publish sessions." } : {}),
    };
  },
});
