import type { ToolContext } from "../mcp/tools/define";
import type { TextbookFilters } from "../database/queries/sql";
import { GroqService } from "./groq";
import { createRetrievalPort } from "./retrieval-port";
import { TutorService } from "./tutor";
import { AppError } from "../utils/errors";

export function createGroq(ctx: ToolContext): GroqService {
  if (!ctx.settings.groqEnabled || !ctx.env.GROQ_API_KEY) {
    throw new AppError("disabled", "Groq-backed answers are not enabled on this server.", 503);
  }
  return new GroqService({ apiKey: ctx.env.GROQ_API_KEY, model: ctx.settings.groqModel, baseUrl: ctx.settings.groqBaseUrl });
}

export function createTutor(ctx: ToolContext, filters: TextbookFilters): TutorService {
  return new TutorService(createGroq(ctx), createRetrievalPort(ctx, filters), { paraphraseOnly: ctx.settings.contentExposure === "excerpt" });
}
