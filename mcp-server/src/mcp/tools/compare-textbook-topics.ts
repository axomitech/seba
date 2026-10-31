import { defineTool } from "./define";
import { schemas } from "../schemas/tool-schemas";
import { assertQuery, searchContent } from "../../services/textbook-search";
import { contentMeta, presentPassage } from "../../services/present";
import { AppError } from "../../utils/errors";

export const compareTextbookTopicsTool = defineTool({
  name: "compare_textbook_topics",
  title: "Compare a topic across textbooks",
  description:
    "Retrieve the most relevant passages about one topic from several textbooks (e.g. the same subject in different mediums or classes) so they can be compared. " +
    "Returns passages grouped per book with citations; the comparison itself is left to the caller.",
  inputSchema: schemas.compare_textbook_topics,
  async run(ctx, input) {
    const topic = assertQuery(input.topic);
    const result = await ctx.withDb((db) =>
      searchContent({ db, settings: ctx.settings, embedQuery: ctx.embedQuery }, {
        query: topic, mode: "auto", perBook: input.passages_per_book, limit: Math.min(6 * input.passages_per_book, 30),
        filters: { class: input.class, subject: input.subject, medium: input.medium, subject_type: input.subject_type, textbook_ids: input.textbook_ids },
      }));
    if (result.rows.length === 0) throw new AppError("not_found", "No indexed passages about this topic were found for the selected textbooks.", 404);
    const groups = new Map<string, { textbook_id: string; textbook_title: string; class: string; subject: string; medium: string; passages: ReturnType<typeof presentPassage>[] }>();
    for (const r of result.rows) {
      const g = groups.get(r.textbook_id) ?? { textbook_id: r.textbook_id, textbook_title: r.title, class: r.class, subject: r.subject, medium: r.medium, passages: [] };
      g.passages.push(presentPassage(r, ctx.settings, result.mode_used));
      groups.set(r.textbook_id, g);
    }
    return {
      topic, search_mode: result.mode_used, books: [...groups.values()], book_count: groups.size,
      ...(input.textbook_ids && groups.size < input.textbook_ids.length ? { note: "Some requested textbooks have no indexed passages about this topic." } : {}),
      ...(result.notes.length ? { notes: result.notes } : {}), ...contentMeta(ctx.settings),
    };
  },
});
