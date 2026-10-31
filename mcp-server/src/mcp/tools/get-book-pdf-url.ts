import { defineTool } from "./define";
import { schemas } from "../schemas/tool-schemas";
import { getPdfSource } from "../../database/queries/textbooks";

export const getBookPdfUrlTool = defineTool({
  name: "get_book_pdf_url",
  title: "Get official PDF URL",
  description: "Return the official SEBA/ASSEB source URL of a textbook exactly as published on the SEBA website. The file is not proxied or mirrored by this server.",
  inputSchema: schemas.get_book_pdf_url,
  async run(ctx, input) {
    const s = await ctx.withDb((db) => getPdfSource(db, input.textbook_id));
    return {
      textbook_id: s.textbook_id, title: s.title, source_url: s.source_url, source_kind: s.source_kind,
      listed_on: s.discovered_from, last_modified_at_source: s.http_last_modified,
      attribution: "Board of Secondary Education, Assam (SEBA / ASSEB Division-I) - https://site.sebaonline.org/textbook",
      ...(s.source_url ? {} : { note: "The SEBA catalogue lists this book without a downloadable file." }),
      ...(s.source_kind && s.source_kind !== "pdf" ? { note: "The official link is not a PDF (e.g. an archive or a web page), so this book cannot be indexed." } : {}),
    };
  },
});
