import { defineTool } from "./define";
import { schemas } from "../schemas/tool-schemas";
import { createTutor } from "../../services/tutor-factory";
import { AppError } from "../../utils/errors";

/** Optional: the only tool that calls an LLM. All retrieval tools work without Groq. */
export const answerTextbookQuestionTool = defineTool({
  name: "answer_textbook_question",
  title: "Answer a question from the textbooks (Groq)",
  description:
    "Generate an answer, chapter summary, explanation, practice questions, MCQs or step-by-step maths solution grounded ONLY in retrieved textbook passages, " +
    "in English or Assamese. Source references are added from database metadata, not by the model. Clients with their own LLM should prefer search_textbook_content.",
  inputSchema: schemas.answer_textbook_question,
  enabled: (ctx) => ctx.settings.groqEnabled,
  async run(ctx, input) {
    if (input.task === "summarize_chapter" && !input.chapter_id) {
      throw new AppError("invalid_input", "summarize_chapter requires chapter_id (see get_chapters)");
    }
    const tutor = createTutor(ctx, { class: input.class, subject: input.subject, medium: input.medium, subject_type: input.subject_type,
                                      textbook_ids: input.textbook_id ? [input.textbook_id] : undefined });
    const res = await tutor.respond({ question: input.question, task: input.task, language: input.response_language, chapterId: input.chapter_id });
    return { ...res };
  },
});
