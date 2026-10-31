import type { McpServer } from "@modelcontextprotocol/server";
import type { Settings } from "../types/environment";

export function registerAbout(server: McpServer, settings: Settings): void {
  server.registerResource(
    "about",
    "seba://about",
    { title: "About this server", description: "Source, coverage and limitations of the SEBA textbook index", mimeType: "text/markdown" },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: "text/markdown",
        text: [
          "# SEBA Textbook MCP",
          "Read-only retrieval over Class IX and X textbooks published by the Board of Secondary Education, Assam (SEBA / ASSEB Division-I).",
          "Official catalogue: https://site.sebaonline.org/textbook",
          "",
          "## Things to know",
          "- Only textbooks with `content_status: indexed` are searchable. Archive (.rar) and web-page links in the catalogue cannot be indexed.",
          "- Text comes from PDF text layers or OCR. Many Assamese/Bengali books use legacy fonts and are OCR'd, so occasional errors are expected; check `extraction.method` and `ocr_confidence`.",
          "- Chapter and exercise boundaries are detected automatically and may be incomplete (`chapter_quality`).",
          "- Page references: `pdf_page` is the position in the PDF; `printed_page` is the number printed in the book when it could be determined.",
          `- Content exposure: **${settings.contentExposure}**${settings.contentExposure === "excerpt" ? ` (passages truncated to ~${settings.excerptChars} characters; use source_pdf_url for the full text)` : ""}.`,
          "- Always cite using the `citation` field returned with each passage.",
        ].join("\n"),
      }],
    }),
  );
}
