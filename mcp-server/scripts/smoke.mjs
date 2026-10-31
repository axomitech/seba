// Smoke test for a running endpoint (local `wrangler dev` or the deployed Worker).
//   MCP_URL=https://<worker>.<subdomain>.workers.dev/mcp MCP_TOKEN=... node scripts/smoke.mjs
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const url = process.env.MCP_URL;
const token = process.env.MCP_TOKEN;
if (!url) { console.error("MCP_URL is required"); process.exit(2); }

const expected = ["list_textbooks", "get_textbook_details", "search_textbooks", "get_chapters", "get_chapter_content",
  "search_textbook_content", "get_page_content", "get_exercises", "get_book_pdf_url", "compare_textbook_topics"];
let failed = 0;
const check = (name, ok, detail = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`); if (!ok) failed++; };

const health = await fetch(new URL("/healthz", url));
check("GET /healthz", health.ok);
const anon = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
check("unauthenticated /mcp is rejected (401/503)", [401, 503].includes(anon.status) || !token, `status ${anon.status}`);

const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined }));
const tools = (await client.listTools()).tools.map((t) => t.name);
check("initialize + tools/list", expected.every((t) => tools.includes(t)), `${tools.length} tools`);
const call = async (name, args) => { const r = await client.callTool({ name, arguments: args }); return r.structuredContent ?? JSON.parse(r.content[0].text); };

const list = await call("list_textbooks", { limit: 3 });
check("list_textbooks returns rows from the database", list.count > 0, `${list.count} rows`);
const indexed = (await call("list_textbooks", { limit: 1, indexed_only: true })).textbooks[0];
if (indexed) {
  const d = await call("get_textbook_details", { textbook_id: indexed.textbook_id });
  check("get_textbook_details", d.textbook_id === indexed.textbook_id && d.source_url?.startsWith("https://"), indexed.title);
  const p = await call("get_page_content", { textbook_id: indexed.textbook_id, page: 1 });
  check("get_page_content", Boolean(p.page) || p.error?.code === "not_found");
  const s = await call("search_textbook_content", { query: indexed.title.split(/\s+/)[0] ?? "the", limit: 2 });
  check("search_textbook_content", Array.isArray(s.passages));
} else console.log("SKIP  no indexed textbook found yet - run the ingestion engine");
const bad = await client.callTool({ name: "get_textbook_details", arguments: { textbook_id: "not-a-uuid" } });
check("invalid input is rejected", bad.isError === true);
await client.close();
process.exit(failed ? 1 : 0);
