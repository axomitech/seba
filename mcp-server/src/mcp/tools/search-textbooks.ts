import { defineTool } from "./define";
import { schemas } from "../schemas/tool-schemas";
import { searchTextbooks } from "../../database/queries/textbooks";
import { assertQuery } from "../../services/textbook-search";

export const searchTextbooksTool = defineTool({
  name: "search_textbooks",
  title: "Search textbooks by title or subject",
  description: "Find textbooks whose title or subject matches the query, filtered by class, subject, medium and subject type. Returns book metadata, not page content (use search_textbook_content for that).",
  inputSchema: schemas.search_textbooks,
  async run(ctx, input) {
    const q = assertQuery(input.query);
    const textbooks = await ctx.withDb((db) =>
      searchTextbooks(db, q, { class: input.class, subject: input.subject, medium: input.medium, subject_type: input.subject_type }, input.limit));
    return { query: q, textbooks, count: textbooks.length };
  },
});
