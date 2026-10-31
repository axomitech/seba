import { McpServer } from "@modelcontextprotocol/server";
import { registerPrompts } from "../prompts/answer-from-seba";
import { registerAbout } from "../resources/about";
import { enabledTools, executeTool } from "./tools/registry";
import type { ToolContext } from "./tools/define";

export const SERVER_NAME = "seba-textbook-mcp";
export const SERVER_VERSION = "0.1.0";

/** A fresh, stateless server per request (the Streamable HTTP handler calls this factory each time). */
export function createSebaServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Read-only retrieval over official SEBA/ASSEB Class IX-X textbooks. Find a book with list_textbooks/search_textbooks, then use " +
        "get_chapters, search_textbook_content, get_page_content or get_exercises. Always cite passages with their `citation` field and " +
        "never invent book names or page numbers. Text is extracted from PDFs (some via OCR) and may contain errors; source_pdf_url is authoritative.",
    },
  );
  for (const def of enabledTools(ctx)) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.inputSchema,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (args: unknown) => executeTool(def, ctx, args),
    );
  }
  registerAbout(server, ctx.settings);
  registerPrompts(server);
  return server;
}
