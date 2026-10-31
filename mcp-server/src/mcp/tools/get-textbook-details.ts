import { defineTool } from "./define";
import { schemas } from "../schemas/tool-schemas";
import { getTextbook } from "../../database/queries/textbooks";

export const getTextbookDetailsTool = defineTool({
  name: "get_textbook_details",
  title: "Get textbook details",
  description: "Metadata for one textbook: title, class, subject, medium, official source URL, indexing status, page/chapter counts and extraction quality.",
  inputSchema: schemas.get_textbook_details,
  async run(ctx, input) {
    const t = await ctx.withDb((db) => getTextbook(db, input.textbook_id));
    const { extraction_summary, ...rest } = t;
    return { ...rest, extraction_quality: extraction_summary ?? null };
  },
});
