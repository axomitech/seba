import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/server";
import type { GroqToolSpec } from "../../services/groq";
import { toSafeError, AppError } from "../../utils/errors";
import { errorSummary, logEvent } from "../../utils/log";
import { MAX_RESPONSE_CHARS } from "../../utils/limits";
import type { ToolContext, ToolDef } from "./define";
import { answerTextbookQuestionTool } from "./answer-textbook-question";
import { compareTextbookTopicsTool } from "./compare-textbook-topics";
import { getBookPdfUrlTool } from "./get-book-pdf-url";
import { getChapterContentTool } from "./get-chapter-content";
import { getChaptersTool } from "./get-chapters";
import { getExercisesTool } from "./get-exercises";
import { getPageContentTool } from "./get-page-content";
import { getTextbookDetailsTool } from "./get-textbook-details";
import { listTextbooksTool } from "./list-textbooks";
import { searchTextbookContentTool } from "./search-textbook-content";
import { searchTextbooksTool } from "./search-textbooks";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ALL_TOOLS: ToolDef<any>[] = [
  listTextbooksTool, getTextbookDetailsTool, searchTextbooksTool, getChaptersTool, getChapterContentTool,
  searchTextbookContentTool, getPageContentTool, getExercisesTool, getBookPdfUrlTool, compareTextbookTopicsTool,
  answerTextbookQuestionTool,
];

export function enabledTools(ctx: ToolContext) {
  return ALL_TOOLS.filter((t) => !t.enabled || t.enabled(ctx));
}

/** Run a tool and convert the outcome (success or any failure) to an MCP CallToolResult. */
export async function executeTool(def: ToolDef, ctx: ToolContext, input: unknown): Promise<CallToolResult> {
  const started = Date.now();
  try {
    const payload = await def.run(ctx, input as never);
    const text = JSON.stringify(payload);
    if (text.length > MAX_RESPONSE_CHARS) {
      throw new AppError("invalid_input", "The result is too large. Request fewer results or a smaller max_chars.");
    }
    logEvent("info", "tool_call", { tool: def.name, ok: true, ms: Date.now() - started });
    return { content: [{ type: "text", text }], structuredContent: payload };
  } catch (e) {
    const safe = toSafeError(e);
    logEvent(safe.code === "internal" ? "error" : "warn", "tool_call", {
      tool: def.name, ok: false, code: safe.code, ms: Date.now() - started, ...(safe.code === "internal" ? errorSummary(e) : {}),
    });
    return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: safe }) }], structuredContent: { error: safe } };
  }
}

/** Validate untrusted arguments (e.g. produced by an LLM) and run a tool by name. Throws AppError on bad input. */
export async function runToolByName(ctx: ToolContext, name: string, rawArgs: unknown): Promise<Record<string, unknown>> {
  const def = enabledTools(ctx).find((t) => t.name === name);
  if (!def) throw new AppError("invalid_input", `Unknown tool: ${name}`);
  const parsed = (def.inputSchema as z.ZodObject).safeParse(rawArgs);
  if (!parsed.success) throw new AppError("invalid_input", `Invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 300)}`);
  return def.run(ctx, parsed.data as never);
}

/** Groq function-calling specs for a subset of the (read-only, retrieval) tools. */
export function groqToolSpecs(ctx: ToolContext, names: string[]): GroqToolSpec[] {
  return enabledTools(ctx)
    .filter((t) => names.includes(t.name))
    .map((t) => {
      const { $schema: _s, ...parameters } = z.toJSONSchema(t.inputSchema as z.ZodObject) as Record<string, unknown>;
      return { type: "function" as const, function: { name: t.name, description: t.description, parameters } };
    });
}
