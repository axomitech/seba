import type { Settings } from "../types/environment";
import type { PassageRow, PageRow } from "../database/queries/content";
import { buildCitation } from "./citations";
import { excerpt } from "../utils/text";

export const EXCERPT_NOTICE =
  "This deployment returns excerpts only. Open source_pdf_url for the complete official text.";

/** Apply the content-exposure policy to extracted text. */
export function applyExposure(text: string, settings: Settings, maxFull = 20000): { text: string; truncated: boolean } {
  return excerpt(text, settings.contentExposure === "excerpt" ? settings.excerptChars : maxFull);
}

export function presentPassage(r: PassageRow, settings: Settings, match: string) {
  const body = applyExposure(r.content, settings);
  const base = {
    textbook_id: r.textbook_id,
    textbook_title: r.title,
    class: r.class,
    subject: r.subject,
    medium: r.medium,
    chapter: r.chapter_title ? { chapter_id: r.chapter_id, number: r.chapter_number, title: r.chapter_title } : null,
    pages: { pdf_start: r.page_start, pdf_end: r.page_end, printed_start: r.printed_page_start },
    kind: r.chunk_kind,
    text: body.text,
    truncated: body.truncated,
    relevance: r.score,
    match,
    source_pdf_url: r.source_url,
  };
  return {
    ...base,
    citation: buildCitation({
      textbook_id: r.textbook_id, title: r.title, class: r.class, subject: r.subject, medium: r.medium,
      chapter_number: r.chapter_number, chapter_title: r.chapter_title, pdf_page_start: r.page_start,
      pdf_page_end: r.page_end, printed_page_start: r.printed_page_start, source_pdf_url: r.source_url,
    }),
  };
}

export function presentPage(p: PageRow, settings: Settings) {
  const body = applyExposure(p.content, settings);
  return {
    pdf_page: p.pdf_page_index,
    printed_page: p.printed_page,
    chapter: p.chapter_title ? { chapter_id: p.chapter_id, number: p.chapter_number, title: p.chapter_title } : null,
    text: body.text,
    truncated: body.truncated,
    extraction: { method: p.extraction_method, ocr_confidence: p.ocr_confidence === null ? null : Math.round(p.ocr_confidence) },
  };
}

export function contentMeta(settings: Settings) {
  return {
    content_exposure: settings.contentExposure,
    ...(settings.contentExposure === "excerpt" ? { content_notice: EXCERPT_NOTICE } : {}),
  };
}
