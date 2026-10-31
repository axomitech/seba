import { z } from "zod";
import { DEFAULT_CONTENT_CHARS, DEFAULT_LIMIT, MAX_COMPARE_BOOKS, MAX_CONTENT_CHARS, MAX_LIMIT, MAX_LIST_LIMIT, MAX_PAGE_NUMBER, MAX_QUERY_CHARS } from "../../utils/limits";

const textbookId = z.uuid().describe("Textbook ID (UUID) from list_textbooks / search_textbooks");
const classLevel = z.enum(["IX", "X"]).describe("Class: IX (9) or X (10)");
const medium = z.string().trim().min(2).max(30).regex(/^[\p{L}\p{M}\s-]+$/u, "letters only")
  .describe("Medium/language, e.g. Assamese, English, Bengali, Bodo, Hindi, Manipuri, Nepali, Karbi");
const subject = z.string().trim().min(1).max(60).describe("Subject name or part of it, e.g. 'Science', 'Mathematics'");
const subjectType = z.enum(["Core", "Elective", "MIL", "NSQF", "Co-Curricular"]).describe("Subject type as listed in the SEBA catalogue");
const query = z.string().trim().min(2).max(MAX_QUERY_CHARS).describe("Search text. Assamese, other Indic scripts and English are supported");
const limit = (max: number, def = DEFAULT_LIMIT) => z.number().int().min(1).max(max).default(def);
const cursor = z.string().trim().max(300).optional().describe("Opaque cursor from a previous response's next_cursor");

const filters = {
  class: classLevel.optional(),
  subject: subject.optional(),
  medium: medium.optional(),
  subject_type: subjectType.optional(),
};

const chapterSelector = {
  chapter_id: z.uuid().optional().describe("Chapter ID from get_chapters"),
  textbook_id: textbookId.optional(),
  chapter_number: z.string().trim().min(1).max(8).optional().describe("Chapter number as printed in the book, e.g. '3'"),
  chapter_ordinal: z.number().int().min(1).max(200).optional().describe("Position of the chapter in the book (1 = first)"),
};

export const schemas = {
  list_textbooks: z.object({
    ...filters,
    indexed_only: z.boolean().default(false).describe("Only books whose text is indexed and searchable"),
    academic_session: z.string().trim().max(20).optional().describe("Academic session. The SEBA catalogue does not publish this, so it is currently never populated"),
    limit: limit(MAX_LIST_LIMIT, 20),
    cursor,
  }),
  get_textbook_details: z.object({ textbook_id: textbookId }),
  search_textbooks: z.object({ query, ...filters, limit: limit(MAX_LIST_LIMIT, 10) }),
  get_chapters: z.object({ textbook_id: textbookId }),
  get_chapter_content: z.object({
    ...chapterSelector,
    from_page: z.number().int().min(1).max(MAX_PAGE_NUMBER).optional().describe("Continue from this PDF page (use next_from_page of the previous response)"),
    max_chars: z.number().int().min(500).max(MAX_CONTENT_CHARS).default(DEFAULT_CONTENT_CHARS).describe("Approximate size budget for returned text"),
  }),
  search_textbook_content: z.object({
    query,
    ...filters,
    textbook_ids: z.array(textbookId).min(1).max(MAX_COMPARE_BOOKS).optional().describe("Restrict to these textbooks"),
    mode: z.enum(["auto", "keyword", "semantic", "hybrid"]).default("auto").describe("auto = hybrid when semantic search is enabled, otherwise keyword"),
    limit: limit(MAX_LIMIT),
  }),
  get_page_content: z.object({
    textbook_id: textbookId,
    page: z.number().int().min(1).max(MAX_PAGE_NUMBER),
    page_type: z.enum(["pdf", "printed"]).default("pdf").describe("pdf = position in the PDF file; printed = page number printed in the book (only known for some pages)"),
  }),
  get_exercises: z.object({
    ...chapterSelector,
    limit: limit(MAX_LIMIT, 10),
    cursor,
  }),
  get_book_pdf_url: z.object({ textbook_id: textbookId }),
  compare_textbook_topics: z.object({
    topic: query,
    textbook_ids: z.array(textbookId).min(2).max(MAX_COMPARE_BOOKS).optional().describe("Compare these textbooks (2-6). If omitted, the best-matching books under the filters are compared"),
    ...filters,
    passages_per_book: z.number().int().min(1).max(5).default(2),
  }),
  answer_textbook_question: z.object({
    question: z.string().trim().min(3).max(1000),
    task: z.enum(["answer", "summarize_chapter", "explain", "practice_questions", "mcq", "math_steps"]).default("answer"),
    ...filters,
    textbook_id: textbookId.optional(),
    chapter_id: z.uuid().optional(),
    response_language: z.enum(["auto", "english", "assamese"]).default("auto"),
  }),
} as const;

export type ToolName = keyof typeof schemas;
