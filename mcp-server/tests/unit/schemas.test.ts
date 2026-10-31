import { describe, expect, it } from "vitest";
import { schemas } from "../../src/mcp/schemas/tool-schemas";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";

describe("tool input validation", () => {
  it("applies defaults and bounds", () => {
    const r = schemas.search_textbook_content.parse({ query: "photosynthesis" });
    expect(r).toMatchObject({ limit: 5, mode: "auto" });
    expect(() => schemas.search_textbook_content.parse({ query: "x" })).toThrow();           // too short
    expect(() => schemas.search_textbook_content.parse({ query: "a".repeat(301) })).toThrow(); // too long
    expect(() => schemas.search_textbook_content.parse({ query: "ok query", limit: 21 })).toThrow();
    expect(() => schemas.search_textbook_content.parse({ query: "ok query", limit: 0 })).toThrow();
    expect(() => schemas.search_textbook_content.parse({ query: "ok query", limit: 2.5 })).toThrow();
  });

  it("rejects malformed ids and out-of-range pages", () => {
    expect(() => schemas.get_textbook_details.parse({ textbook_id: "1; DROP TABLE textbooks" })).toThrow();
    expect(() => schemas.get_textbook_details.parse({ textbook_id: "not-a-uuid" })).toThrow();
    expect(schemas.get_page_content.parse({ textbook_id: ID, page: 3 }).page_type).toBe("pdf");
    for (const page of [0, -1, 5001, 1.5]) expect(() => schemas.get_page_content.parse({ textbook_id: ID, page })).toThrow();
  });

  it("restricts enums and filter shapes", () => {
    expect(() => schemas.list_textbooks.parse({ class: "XI" })).toThrow();
    expect(() => schemas.list_textbooks.parse({ medium: "Assamese; DROP" })).toThrow();   // letters only
    expect(schemas.list_textbooks.parse({ medium: "Assamese", class: "IX" })).toMatchObject({ limit: 20 });
    expect(() => schemas.list_textbooks.parse({ limit: 51 })).toThrow();
    expect(() => schemas.list_textbooks.parse({ subject_type: "Hacking" })).toThrow();
  });

  it("requires 2-6 books to compare", () => {
    expect(() => schemas.compare_textbook_topics.parse({ topic: "light", textbook_ids: [ID] })).toThrow();
    expect(() => schemas.compare_textbook_topics.parse({ topic: "light", textbook_ids: Array(7).fill(ID) })).toThrow();
    expect(schemas.compare_textbook_topics.parse({ topic: "light" }).passages_per_book).toBe(2);
  });

  it("does not accept arbitrary URLs, SQL or table names as tool parameters", () => {
    // the schema has no such fields; unknown keys are stripped, never passed on
    const r = schemas.get_book_pdf_url.parse({ textbook_id: ID, url: "http://169.254.169.254/", table: "users", sql: "select 1" });
    expect(Object.keys(r)).toEqual(["textbook_id"]);
  });
});
