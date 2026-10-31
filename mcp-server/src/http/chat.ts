import { z } from "zod";
import type { ToolContext } from "../mcp/tools/define";
import { groqToolSpecs, runToolByName } from "../mcp/tools/registry";
import { createTutor } from "../services/tutor-factory";
import type { Evidence } from "../services/tutor";
import { schemas } from "../mcp/schemas/tool-schemas";
import { AppError, toSafeError } from "../utils/errors";
import { errorSummary, logEvent } from "../utils/log";
import { GroqError } from "../services/groq";
import { errorResponse, json, readLimitedText } from "./respond";

const ChatBody = schemas.answer_textbook_question.omit({ question: true }).extend({
  message: z.string().trim().min(3).max(1000),
  /** grounded = retrieve then generate (deterministic, default); agentic = model chooses retrieval tools */
  mode: z.enum(["grounded", "agentic"]).default("grounded"),
});

const AGENT_TOOLS = ["search_textbook_content", "get_page_content", "get_chapter_content", "search_textbooks", "get_chapters"];

interface PassageLike {
  textbook_id: string; textbook_title: string; class: string; subject: string; medium: string;
  chapter: { number: string | null; title: string } | null;
  pages: { pdf_start: number; pdf_end: number; printed_start: string | null };
  text: string; source_pdf_url: string | null;
}

/** Turn tool output into evidence the model can cite by handle; handles are assigned by application code. */
function annotate(name: string, out: Record<string, unknown>, register: (e: Evidence[]) => Array<{ ref: string }>): Record<string, unknown> {
  const toEvidence = (p: PassageLike): Evidence => ({
    textbook_id: p.textbook_id, title: p.textbook_title, class: p.class, subject: p.subject, medium: p.medium,
    chapter_number: p.chapter?.number ?? null, chapter_title: p.chapter?.title ?? null,
    pdf_page_start: p.pages.pdf_start, pdf_page_end: p.pages.pdf_end, printed_page_start: p.pages.printed_start,
    source_pdf_url: p.source_pdf_url, text: p.text,
  });
  if (name === "search_textbook_content" && Array.isArray(out.passages)) {
    const ps = out.passages as PassageLike[];
    const refs = register(ps.map(toEvidence));
    return { ...out, passages: ps.map((p, i) => ({ ref: refs[i]!.ref, text: p.text, textbook: p.textbook_title, chapter: p.chapter?.title ?? null, pages: p.pages })) };
  }
  const pageLike = (pg: { pdf_page: number; printed_page: string | null; chapter: { number: string | null; title: string } | null; text: string }, meta: Record<string, unknown>): Evidence => ({
    textbook_id: String(meta.textbook_id), title: String(meta.textbook_title), class: String(meta.class), subject: String(meta.subject), medium: String(meta.medium),
    chapter_number: pg.chapter?.number ?? null, chapter_title: pg.chapter?.title ?? null,
    pdf_page_start: pg.pdf_page, pdf_page_end: pg.pdf_page, printed_page_start: pg.printed_page,
    source_pdf_url: (meta.source_pdf_url as string | null) ?? null, text: pg.text,
  });
  if (name === "get_page_content" && out.page) {
    const pg = out.page as Parameters<typeof pageLike>[0];
    const [r] = register([pageLike(pg, out)]);
    return { ref: r!.ref, textbook: out.textbook_title, page: pg };
  }
  if (name === "get_chapter_content" && Array.isArray(out.pages)) {
    const pgs = out.pages as Array<Parameters<typeof pageLike>[0]>;
    const refs = register(pgs.map((pg) => pageLike(pg, out)));
    return { textbook: out.textbook_title, chapter: out.chapter, next_from_page: out.next_from_page, pages: pgs.map((pg, i) => ({ ref: refs[i]!.ref, pdf_page: pg.pdf_page, text: pg.text })) };
  }
  return out;
}

export async function handleChat(request: Request, ctx: ToolContext): Promise<Response> {
  if (request.method !== "POST") return errorResponse(405, "invalid_input", "Use POST", { allow: "POST" });
  if (!ctx.settings.groqEnabled) return errorResponse(503, "disabled", "Groq-backed chat is not enabled on this server.");
  const raw = await readLimitedText(request, 16 * 1024);
  if (raw === null) return errorResponse(413, "payload_too_large", "Request body too large");
  let parsed: z.infer<typeof ChatBody>;
  try {
    parsed = ChatBody.parse(JSON.parse(raw));
  } catch (e) {
    const msg = e instanceof z.ZodError ? e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 300) : "Body must be valid JSON";
    return errorResponse(400, "invalid_input", msg);
  }
  const started = Date.now();
  try {
    const tutor = createTutor(ctx, {
      class: parsed.class, subject: parsed.subject, medium: parsed.medium, subject_type: parsed.subject_type,
      textbook_ids: parsed.textbook_id ? [parsed.textbook_id] : undefined,
    });
    const req = { question: parsed.message, task: parsed.task, language: parsed.response_language, chapterId: parsed.chapter_id };
    if (parsed.task === "summarize_chapter" && !parsed.chapter_id) throw new AppError("invalid_input", "summarize_chapter requires chapter_id");
    let result;
    if (parsed.mode === "agentic") {
      try {
        result = await tutor.respondWithTools(req, groqToolSpecs(ctx, AGENT_TOOLS), async (name, args, register) => {
          if (!AGENT_TOOLS.includes(name)) throw new AppError("invalid_input", "Tool not allowed");
          return annotate(name, await runToolByName(ctx, name, args), register);
        });
      } catch (e) {
        // not every Groq model/tool combination is reliable: fall back to the deterministic pipeline
        if (!(e instanceof GroqError) || e.kind === "auth" || e.kind === "rate_limit") throw e;
        logEvent("warn", "agentic_fallback", { kind: e.kind });
        result = await tutor.respond(req);
      }
    } else {
      result = await tutor.respond(req);
    }
    logEvent("info", "chat", { mode: parsed.mode, task: parsed.task, grounded: result.grounded, ms: Date.now() - started });
    return json(result);
  } catch (e) {
    const safe = toSafeError(e);
    logEvent(safe.code === "internal" ? "error" : "warn", "chat_failed", { code: safe.code, ...(safe.code === "internal" ? errorSummary(e) : {}) });
    return errorResponse(e instanceof AppError ? e.status : 500, safe.code, safe.message);
  }
}
