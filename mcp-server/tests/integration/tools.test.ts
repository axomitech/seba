import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IDS, OWNER_DSN, setupDatabase } from "../helpers/db";
import { call, connect, fakeAi, makeEnv } from "../helpers/worker";

const run = OWNER_DSN ? describe : describe.skip;

run("MCP tools against PostgreSQL (reader role, real queries)", () => {
  let client: Awaited<ReturnType<typeof connect>>;
  beforeAll(async () => { await setupDatabase(); client = await connect(makeEnv()); });
  afterAll(async () => { await client?.close(); });

  describe("protocol", () => {
    it("lists exactly the ten retrieval tools with schemas and read-only annotations (no Groq tool when disabled)", async () => {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([
        "compare_textbook_topics", "get_book_pdf_url", "get_chapter_content", "get_chapters", "get_exercises",
        "get_page_content", "get_textbook_details", "list_textbooks", "search_textbook_content", "search_textbooks",
      ]);
      for (const t of tools) {
        expect(t.inputSchema.type).toBe("object");
        expect(t.annotations?.readOnlyHint).toBe(true);
        expect(t.description?.length).toBeGreaterThan(40);
      }
    });
    it("exposes the about resource and the answering prompt", async () => {
      expect((await client.listResources()).resources.map((r) => r.uri)).toContain("seba://about");
      const prompt = await client.getPrompt({ name: "answer_from_seba_textbooks", arguments: { question: "পোহৰ কি?" } });
      expect(JSON.stringify(prompt.messages)).toContain("citation");
    });
  });

  describe("list_textbooks / search_textbooks / details", () => {
    it("lists only catalogue-listed books, never removed ones, with honest content status", async () => {
      const r = await call(client, "list_textbooks", { limit: 50 });
      const byId = new Map<string, any>(r.data.textbooks.map((t: any) => [t.textbook_id, t]));
      expect(r.data.count).toBe(7);
      expect(byId.has(IDS.t_removed)).toBe(false);
      expect(byId.get(IDS.t_sci_en).content_status).toBe("indexed");
      expect(byId.get(IDS.t_pending).content_status).toBe("not_indexed");
      expect(byId.get(IDS.t_rar).content_status).toBe("unsupported_format");
      expect(byId.get(IDS.t_nolink).content_status).toBe("no_pdf");
      expect(byId.get(IDS.t_nolink).source_url).toBeNull();
      expect(byId.get(IDS.t_sci_en).academic_session).toBeNull();     // never fabricated
    });
    it("can restrict to indexed (searchable) books", async () => {
      const r = await call(client, "list_textbooks", { indexed_only: true });
      expect(r.data.textbooks.map((t: any) => t.textbook_id).sort()).toEqual([IDS.t_sci_en, IDS.t_sci_as, IDS.t_reader_ix, IDS.t_reader_x].sort());
      expect(r.data.textbooks.every((t: any) => t.content_status === "indexed")).toBe(true);
    });
    it("paginates with opaque cursors without gaps or duplicates", async () => {
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let i = 0; i < 10; i++) {
        const r = await call(client, "list_textbooks", { limit: 3, ...(cursor ? { cursor } : {}) });
        seen.push(...r.data.textbooks.map((t: any) => t.textbook_id));
        cursor = r.data.next_cursor ?? undefined;
        if (!cursor) break;
      }
      expect(seen).toHaveLength(7);
      expect(new Set(seen).size).toBe(7);
    });
    it("filters by class, medium (including 'All' mediums), subject and type", async () => {
      const asm = await call(client, "list_textbooks", { medium: "Assamese" });
      expect(asm.data.textbooks.map((t: any) => t.textbook_id)).toEqual(expect.arrayContaining([IDS.t_sci_as, IDS.t_reader_ix, IDS.t_reader_x]));
      expect(asm.data.textbooks.map((t: any) => t.textbook_id)).not.toContain(IDS.t_sci_en);
      const cx = await call(client, "list_textbooks", { class: "X" });
      expect(cx.data.textbooks.map((t: any) => t.textbook_id).sort()).toEqual([IDS.t_pending, IDS.t_reader_x, IDS.t_rar].sort());   // IX-X book matches X
      expect((await call(client, "list_textbooks", { subject: "scien", subject_type: "Core" })).data.count).toBe(4);
    });
    it("rejects bad cursors and bad enums with clear errors", async () => {
      const bad = await call(client, "list_textbooks", { cursor: "%%%not-a-cursor" });
      expect(bad.isError).toBe(true);
      expect(bad.data.error.code).toBe("invalid_input");
      expect((await call(client, "list_textbooks", { class: "XII" })).isError).toBe(true);
    });
    it("searches titles fuzzily and by subject", async () => {
      const r = await call(client, "search_textbooks", { query: "Scince Textbok" });
      expect(r.data.textbooks[0].textbook_id).toBe(IDS.t_sci_en);
      expect((await call(client, "search_textbooks", { query: "Bigyan", medium: "Assamese" })).data.count).toBe(1);
      expect((await call(client, "search_textbooks", { query: "zzzzqqq" })).data.count).toBe(0);
    });
    it("returns details incl. extraction quality; unknown and removed ids are not_found", async () => {
      const r = await call(client, "get_textbook_details", { textbook_id: IDS.t_sci_en });
      expect(r.data).toMatchObject({ title: "Science Textbook", page_count: 5, chapter_count: 2, chunk_count: 3, class: "IX", medium: "English" });
      expect(r.data.extraction_quality.chapter_quality.method).toBe("toc");
      for (const id of ["99999999-9999-4999-8999-999999999999", IDS.t_removed]) {
        const e = await call(client, "get_textbook_details", { textbook_id: id });
        expect(e).toMatchObject({ isError: true, data: { error: { code: "not_found" } } });
      }
    });
    it("never exposes server-side file paths or hashes", async () => {
      const all = JSON.stringify([
        await call(client, "get_textbook_details", { textbook_id: IDS.t_sci_en }),
        await call(client, "list_textbooks", {}), await call(client, "get_book_pdf_url", { textbook_id: IDS.t_sci_en }),
      ]);
      expect(all).not.toMatch(/\/secret\/local|deadbeef|local_path|sha256/);
    });
  });

  describe("chapters and pages", () => {
    it("returns ordered chapters, and an explanatory note when none exist", async () => {
      const r = await call(client, "get_chapters", { textbook_id: IDS.t_sci_en });
      expect(r.data.chapters.map((c: any) => [c.chapter_number, c.title, c.start_page, c.end_page])).toEqual([["1", "Light", 1, 3], ["2", "Sound", 4, 5]]);
      const none = await call(client, "get_chapters", { textbook_id: IDS.t_pending });
      expect(none.data).toMatchObject({ count: 0 });
      expect(none.data.note).toMatch(/No chapters/);
      expect((await call(client, "get_chapters", { textbook_id: IDS.t_nolink })).data.count).toBe(0);
    });
    it("gets chapter content by chapter_id or by textbook + number, with page refs", async () => {
      const a = await call(client, "get_chapter_content", { chapter_id: IDS.ch_light });
      const b = await call(client, "get_chapter_content", { textbook_id: IDS.t_sci_en, chapter_number: "1" });
      const c = await call(client, "get_chapter_content", { textbook_id: IDS.t_sci_en, chapter_ordinal: 1 });
      expect(a.data.pages.map((p: any) => p.pdf_page)).toEqual([1, 2, 3]);
      expect(b.data.pages).toEqual(a.data.pages);
      expect(c.data.chapter.chapter_id).toBe(IDS.ch_light);
      expect(a.data).toMatchObject({ textbook_title: "Science Textbook", class: "IX", chapter: { title: "Light", number: "1" } });
      expect(a.data.pages[1].printed_page).toBe("1");
    });
    it("paginates large chapters by size using next_from_page", async () => {
      const first = await call(client, "get_chapter_content", { chapter_id: IDS.ch_light, max_chars: 500 });
      expect(first.data.pages.length).toBeGreaterThanOrEqual(1);
      expect(first.data.next_from_page).toBeGreaterThan(1);
      const next = await call(client, "get_chapter_content", { chapter_id: IDS.ch_light, max_chars: 500, from_page: first.data.next_from_page });
      expect(next.data.pages[0].pdf_page).toBe(first.data.next_from_page);
    });
    it("requires a chapter selector and reports unknown chapters", async () => {
      expect((await call(client, "get_chapter_content", {})).data.error.code).toBe("invalid_input");
      expect((await call(client, "get_chapter_content", { textbook_id: IDS.t_sci_en, chapter_number: "99" })).data.error.code).toBe("not_found");
    });
    it("gets a page by PDF index and by printed number; explains invalid pages", async () => {
      const r = await call(client, "get_page_content", { textbook_id: IDS.t_sci_en, page: 5 });
      expect(r.data.page).toMatchObject({ pdf_page: 5, printed_page: "4", chapter: { title: "Sound" }, extraction: { method: "ocr", ocr_confidence: 91 } });
      expect(r.data.source_pdf_url).toContain("science_en.pdf");
      const printed = await call(client, "get_page_content", { textbook_id: IDS.t_sci_en, page: 4, page_type: "printed" });
      expect(printed.data.page.pdf_page).toBe(5);
      const far = await call(client, "get_page_content", { textbook_id: IDS.t_sci_en, page: 400 });
      expect(far.data.error).toMatchObject({ code: "not_found", message: expect.stringContaining("5 pages") });
      const pending = await call(client, "get_page_content", { textbook_id: IDS.t_pending, page: 1 });
      expect(pending.data.error.message).toMatch(/not been indexed/);
      expect((await call(client, "get_page_content", { textbook_id: IDS.t_sci_en, page: 0 })).isError).toBe(true);
    });
  });

  describe("search_textbook_content", () => {
    it("finds English passages with complete provenance", async () => {
      const r = await call(client, "search_textbook_content", { query: "laws of reflection" });
      expect(r.data.search_mode).toBe("keyword");
      const top = r.data.passages[0];
      expect(top).toMatchObject({ textbook_id: IDS.t_sci_en, textbook_title: "Science Textbook", class: "IX", medium: "English", subject: "General Science" });
      expect(top.chapter.title).toBe("Light");
      expect(top.pages.pdf_start).toBeGreaterThanOrEqual(1);
      expect(top.citation).toMatch(/^Science Textbook — Class IX, General Science \(English\), Chapter 1: Light, PDF p/);
      expect(top.source_pdf_url).toContain("science_en.pdf");
      expect(top.text.toLowerCase()).toContain("reflection");
    });
    it("finds Assamese passages", async () => {
      const r = await call(client, "search_textbook_content", { query: "প্ৰতিফলন" });
      expect(r.data.passages[0]).toMatchObject({ textbook_id: IDS.t_sci_as, medium: "Assamese" });
      expect(r.data.passages[0].chapter.title).toBe("পোহৰ");
    });
    it("applies filters and restricts to selected books", async () => {
      expect((await call(client, "search_textbook_content", { query: "light", medium: "Assamese" })).data.passages.every((p: any) => p.medium !== "English")).toBe(true);
      const only = await call(client, "search_textbook_content", { query: "light", textbook_ids: [IDS.t_sci_en] });
      expect(new Set(only.data.passages.map((p: any) => p.textbook_id))).toEqual(new Set([IDS.t_sci_en]));
      expect((await call(client, "search_textbook_content", { query: "light", class: "X" })).data.passages.map((p: any) => p.textbook_id)).not.toContain(IDS.t_sci_en);
    });
    it("lists a PDF shared by two catalogue rows once, unless both are requested explicitly", async () => {
      const once = await call(client, "search_textbook_content", { query: "lamp knowledge" });
      expect(once.data.passages.filter((p: any) => p.text.includes("lamp"))).toHaveLength(1);
      const both = await call(client, "search_textbook_content", { query: "lamp knowledge", textbook_ids: [IDS.t_reader_ix, IDS.t_reader_x] });
      expect(both.data.passages.map((p: any) => p.class).sort()).toEqual(["IX", "X"]);
    });
    it("never searches books that are not indexed and says so on empty results", async () => {
      const r = await call(client, "search_textbook_content", { query: "xylophone quasar" });
      expect(r.data).toMatchObject({ count: 0, passages: [] });
      expect(r.data.note).toMatch(/indexed/);
    });
    it("respects result limits", async () => {
      const r = await call(client, "search_textbook_content", { query: "light reflection sound mirror", limit: 2 });
      expect(r.data.passages.length).toBeLessThanOrEqual(2);
      expect((await call(client, "search_textbook_content", { query: "light", limit: 21 })).isError).toBe(true);
    });
    it("treats SQL injection payloads and LIKE wildcards as plain text", async () => {
      for (const q of ["'; DROP TABLE textbooks; --", "\" OR 1=1 --", "100%", "_____", "\\\\", "a) | (b", "Robert'); DELETE FROM chapters;--"]) {
        const r = await call(client, "search_textbook_content", { query: q });
        expect(r.isError, q).toBe(false);
        expect(r.data.count, q).toBe(0);
      }
      const owner = new pg.Client({ connectionString: OWNER_DSN });
      await owner.connect();
      expect((await owner.query("select count(*)::int n from textbooks")).rows[0].n).toBe(8);
      expect((await owner.query("select count(*)::int n from chapters")).rows[0].n).toBe(3);
      await owner.end();
      expect((await call(client, "list_textbooks", { subject: "x' OR '1'='1" })).data.count).toBe(0);
    });
    it("handles a query that tokenises to nothing", async () => {
      const r = await call(client, "search_textbook_content", { query: "?!" });
      expect(r.isError).toBe(false);
      expect(r.data.count).toBe(0);
    });
  });

  describe("semantic and hybrid search", () => {
    it("uses vectors when the AI binding is enabled and falls back to keywords when it fails", async () => {
      const c = await connect(makeEnv({ EMBEDDINGS_ENABLED: "true", AI: fakeAi }));
      try {
        const sem = await call(c, "search_textbook_content", { query: "how does an echo work", mode: "semantic" });
        // "echo" -> sound axis: the Sound chapter chunk must rank first even though the words differ from the text
        expect(sem.data.search_mode).toBe("semantic");
        expect(sem.data.passages[0].chapter.title).toBe("Sound");
        const hybrid = await call(c, "search_textbook_content", { query: "reflection of light" });
        expect(hybrid.data.search_mode).toBe("hybrid");
        expect(hybrid.data.passages[0].match).toBe("hybrid");
        expect(hybrid.data.passages[0].chapter.title).toBe("Light");
      } finally { await c.close(); }
      const broken = await connect(makeEnv({ EMBEDDINGS_ENABLED: "true", AI: { run: async () => { throw new Error("AI down"); } } }));
      try {
        const r = await call(broken, "search_textbook_content", { query: "reflection of light" });
        expect(r.data.search_mode).toBe("keyword");
        expect(r.data.notes.join(" ")).toMatch(/unavailable/);
        expect((await call(broken, "search_textbook_content", { query: "reflection", mode: "semantic" })).data.error.code).toBe("unavailable");
      } finally { await broken.close(); }
    });
    it("says so when semantic search was requested but is not enabled", async () => {
      const r = await call(client, "search_textbook_content", { query: "light", mode: "semantic" });
      expect(r.data.search_mode).toBe("keyword");
      expect(r.data.notes[0]).toMatch(/not enabled/);
    });
    it("rejects embeddings of the wrong size from the AI service", async () => {
      const bad = await connect(makeEnv({ EMBEDDINGS_ENABLED: "true", AI: { run: async () => ({ data: [[1, 2, 3]] }) } }));
      try { expect((await call(bad, "search_textbook_content", { query: "reflection", mode: "semantic" })).isError).toBe(true); }
      finally { await bad.close(); }
    });
  });

  describe("exercises, pdf url, comparison", () => {
    it("returns exercise regions with a best-effort question split in full mode", async () => {
      const r = await call(client, "get_exercises", { chapter_id: IDS.ch_light });
      expect(r.data.exercises).toHaveLength(1);
      expect(r.data.exercises[0].pages.pdf_start).toBe(3);
      expect(r.data.exercises[0].questions.map((q: any) => q.number)).toEqual(["1", "2", "(a)"]);
      expect(r.data.note).toMatch(/heuristic/);
      const book = await call(client, "get_exercises", { textbook_id: IDS.t_sci_en });
      expect(book.data.exercises).toHaveLength(1);
      expect((await call(client, "get_exercises", { chapter_id: IDS.ch_sound })).data.note).toMatch(/No exercise/);
      expect((await call(client, "get_exercises", {})).data.error.code).toBe("invalid_input");
    });
    it("returns the official URL and explains unusable sources", async () => {
      const ok = await call(client, "get_book_pdf_url", { textbook_id: IDS.t_sci_en });
      expect(ok.data).toMatchObject({ source_url: "https://www.sebaonline.org/textbooks/class-9/science_en.pdf", source_kind: "pdf" });
      expect(ok.data.attribution).toMatch(/SEBA/);
      expect((await call(client, "get_book_pdf_url", { textbook_id: IDS.t_rar })).data.note).toMatch(/not a PDF/);
      expect((await call(client, "get_book_pdf_url", { textbook_id: IDS.t_nolink })).data.note).toMatch(/without a downloadable/);
    });
    it("compares a topic across books, grouped per book with citations (keyword search cannot cross scripts)", async () => {
      const r = await call(client, "compare_textbook_topics", { topic: "light", textbook_ids: [IDS.t_sci_en, IDS.t_sci_as], passages_per_book: 1 });
      expect(r.data.book_count).toBe(1);                       // "light" does not literally occur in the Assamese text
      expect(r.data.books[0].passages[0].citation).toMatch(/Science Textbook/);
      expect(r.data.note).toMatch(/no indexed passages/);
      const asm = await call(client, "compare_textbook_topics", { topic: "প্ৰতিফলন", textbook_ids: [IDS.t_sci_en, IDS.t_sci_as] });
      expect(asm.data.books.map((b: any) => b.medium)).toEqual(["Assamese"]);
    });
    it("with semantic search the same topic is found in both mediums", async () => {
      const c = await connect(makeEnv({ EMBEDDINGS_ENABLED: "true", AI: fakeAi }));
      try {
        const r = await call(c, "compare_textbook_topics", { topic: "light", textbook_ids: [IDS.t_sci_en, IDS.t_sci_as], passages_per_book: 1 });
        expect(r.data.book_count).toBe(2);
        expect(r.data.books.map((b: any) => b.medium).sort()).toEqual(["Assamese", "English"]);
        for (const b of r.data.books) { expect(b.passages).toHaveLength(1); expect(b.passages[0].citation).toBeTruthy(); }
      } finally { await c.close(); }
      const none = await call(client, "compare_textbook_topics", { topic: "light", textbook_ids: [IDS.t_pending, IDS.t_nolink] });
      expect(none.data.error.code).toBe("not_found");
    });
  });

  describe("content exposure policy", () => {
    it("truncates passages, pages and exercises in excerpt mode and says so", async () => {
      const c = await connect(makeEnv({ CONTENT_EXPOSURE: "excerpt", EXCERPT_CHARS: "100" }));
      try {
        const s = await call(c, "search_textbook_content", { query: "mirrors reflection" });
        expect(s.data.content_exposure).toBe("excerpt");
        expect(s.data.content_notice).toMatch(/excerpts only/i);
        expect(s.data.passages.every((p: any) => p.text.length <= 110)).toBe(true);
        expect(s.data.passages.some((p: any) => p.truncated)).toBe(true);
        const pg = await call(c, "get_page_content", { textbook_id: IDS.t_sci_en, page: 2 });
        expect(pg.data.page.truncated).toBe(true);
        expect(pg.data.page.text.length).toBeLessThanOrEqual(110);
        const ex = await call(c, "get_exercises", { chapter_id: IDS.ch_light });
        expect(ex.data.exercises[0].questions).toEqual([]);
      } finally { await c.close(); }
    });
  });

  describe("resilience", () => {
    it("reports an unavailable database without leaking connection details", async () => {
      const c = await connect(makeEnv({ HYPERDRIVE: { connectionString: "postgresql://seba_mcp_reader:supersecret@127.0.0.1:1/nodb" } }));
      try {
        const r = await call(c, "list_textbooks", {});
        expect(r.isError).toBe(true);
        expect(r.data.error.code).toBe("unavailable");
        expect(r.text).not.toMatch(/supersecret|127\.0\.0\.1|ECONNREFUSED|postgres/i);
      } finally { await c.close(); }
    });
    it("uses only privileges granted to the read-only role (writes and operational tables are denied)", async () => {
      const { readerDsn } = await import("../helpers/db");
      const rd = new pg.Client({ connectionString: readerDsn() });
      await rd.connect();
      await expect(rd.query("delete from textbooks")).rejects.toThrow();
      await expect(rd.query("select local_path from textbook_sources")).rejects.toThrow(/permission denied/);
      await expect(rd.query("select * from ingestion_logs")).rejects.toThrow(/permission denied/);
      await rd.end();
    });
  });
});
