import { defineTool } from "./define";
import { schemas } from "../schemas/tool-schemas";
import { decodeCursor, encodeCursor } from "../../database/queries/sql";
import { resolveChapter } from "../../database/queries/chapters";
import { getExerciseChunks, getTextbookSource } from "../../database/queries/content";
import { contentMeta, applyExposure } from "../../services/present";
import { AppError } from "../../utils/errors";
import { splitQuestions } from "../../utils/text";

const isCur = (v: unknown): v is { i: number } => typeof v === "object" && v !== null && Number.isInteger((v as { i: number }).i) && (v as { i: number }).i >= 0;

export const getExercisesTool = defineTool({
  name: "get_exercises",
  title: "Get exercises and questions",
  description:
    "Exercise/question sections of a chapter (chapter_id, or textbook_id + chapter_number) or of a whole textbook (textbook_id only). " +
    "Exercise regions are detected heuristically from headings such as 'Exercise' / 'অনুশীলনী'; 'questions' is a best-effort numbered split and may be empty.",
  inputSchema: schemas.get_exercises,
  async run(ctx, input) {
    const after = input.cursor ? (decodeCursor(input.cursor, isCur)?.i ?? (() => { throw new AppError("invalid_input", "Invalid cursor"); })()) : -1;
    const wholeBook = !input.chapter_id && !input.chapter_number && !input.chapter_ordinal;
    if (wholeBook && !input.textbook_id) throw new AppError("invalid_input", "Provide chapter_id, or textbook_id (optionally with chapter_number)");
    const { rows, textbook, chapterId } = await ctx.withDb(async (db) => {
      if (wholeBook) {
        const b = await getTextbookSource(db, input.textbook_id!);
        if (!b.source_id) throw new AppError("not_found", "This textbook has no indexed content.", 404);
        return { rows: await getExerciseChunks(db, b.source_id, null, after, input.limit), textbook: { id: input.textbook_id!, title: b.title, source_url: b.source_url }, chapterId: null };
      }
      const ref = await resolveChapter(db, input);
      const b = await getTextbookSource(db, ref.textbook_id);
      return { rows: await getExerciseChunks(db, ref.source_id, ref.chapter.chapter_id, after, input.limit), textbook: { id: ref.textbook_id, title: b.title, source_url: b.source_url }, chapterId: ref.chapter.chapter_id };
    });
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      textbook_id: textbook.id, textbook_title: textbook.title, chapter_id: chapterId,
      exercises: page.map((r) => {
        const body = applyExposure(r.content, ctx.settings);
        return {
          chapter: r.chapter_title ? { chapter_id: r.chapter_id, number: r.chapter_number, title: r.chapter_title } : null,
          pages: { pdf_start: r.page_start, pdf_end: r.page_end },
          text: body.text, truncated: body.truncated,
          questions: ctx.settings.contentExposure === "full" ? splitQuestions(r.content) : [],
        };
      }),
      next_cursor: rows.length > input.limit && last ? encodeCursor({ i: last.chunk_index }) : null,
      source_pdf_url: textbook.source_url,
      note: page.length === 0 ? "No exercise sections were detected for this selection." : "Exercise detection is heuristic; verify against the PDF.",
      ...contentMeta(ctx.settings),
    };
  },
});
