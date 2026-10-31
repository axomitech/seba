import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { IDS, OWNER_DSN, setupDatabase } from "../helpers/db";
import { callWorker, makeEnv, TOKEN } from "../helpers/worker";
import { resetLocalRateLimits } from "../../src/utils/rate-limit";

const MCP_INIT = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
const mcp = (headers: Record<string, string> = {}, body = MCP_INIT, method = "POST") =>
  new Request("https://worker.test/mcp", { method, headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: method === "POST" ? body : undefined });
const auth = { authorization: `Bearer ${TOKEN}` };
const json = (r: Response): Promise<any> => r.json();

describe("Worker HTTP surface (no database needed)", () => {
  afterEach(() => resetLocalRateLimits());

  it("serves a minimal health check without touching the database or revealing configuration", async () => {
    const res = await callWorker(new Request("https://worker.test/healthz"), makeEnv({ HYPERDRIVE: { connectionString: "postgresql://x:y@127.0.0.1:1/z" } }));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ status: "ok", service: "seba-textbook-mcp", version: "0.1.0" });
    expect(body).not.toMatch(/postgres|token|groq/i);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await callWorker(new Request("https://worker.test/healthz", { method: "POST" }), makeEnv())).status).toBe(405);
  });

  it("returns a JSON 404 for unknown paths", async () => {
    const res = await callWorker(new Request("https://worker.test/admin"), makeEnv());
    expect(res.status).toBe(404);
    expect((await json(res)).error.code).toBe("not_found");
  });

  it("requires a bearer token on /mcp", async () => {
    for (const h of [{}, { authorization: "Bearer wrong" }, { authorization: TOKEN }] as Array<Record<string, string>>) {
      const res = await callWorker(mcp(h), makeEnv());
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toContain("Bearer");
    }
    expect((await callWorker(mcp(auth), makeEnv())).status).toBe(200);
  });

  it("fails closed with 503 when authentication is required but the secret is missing", async () => {
    const res = await callWorker(mcp(auth), makeEnv({ MCP_AUTH_TOKEN: undefined }));
    expect(res.status).toBe(503);
    expect(await res.text()).not.toContain(TOKEN);
  });

  it("serves anonymous clients only when AUTH_MODE=none", async () => {
    expect((await callWorker(mcp(), makeEnv({ AUTH_MODE: "none", MCP_AUTH_TOKEN: undefined }))).status).toBe(200);
  });

  it("rate limits per client using the binding", async () => {
    let n = 0;
    const env = makeEnv({ RATE_LIMITER: { limit: async () => ({ success: ++n <= 2 }) } });
    const codes = [];
    for (let i = 0; i < 4; i++) codes.push((await callWorker(mcp(auth), env)).status);
    expect(codes).toEqual([200, 200, 429, 429]);
    const limited = await callWorker(mcp(auth), env);
    expect(limited.headers.get("retry-after")).toBe("30");
  });

  it("rejects oversized request bodies before parsing them", async () => {
    const res = await callWorker(mcp(auth, JSON.stringify({ pad: "x".repeat(70_000) })), makeEnv());
    expect(res.status).toBe(413);
  });

  it("only emits CORS headers for configured origins and lets preflight through without credentials", async () => {
    const env = makeEnv();
    const allowed = await callWorker(new Request("https://worker.test/mcp", { method: "OPTIONS", headers: { origin: "https://allowed.example", "access-control-request-method": "POST" } }), env);
    expect(allowed.status).toBeLessThan(300);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://allowed.example");
    const other = await callWorker(new Request("https://worker.test/mcp", { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } }), env);
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("does not offer GET streaming sessions or other verbs a stateless server cannot serve", async () => {
    const res = await callWorker(mcp(auth, "", "GET"), makeEnv());
    expect([405, 406]).toContain(res.status);
  });

  it("rejects malformed JSON-RPC without leaking internals", async () => {
    const res = await callWorker(mcp(auth, "{not json"), makeEnv());
    const text = await res.text();
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(text).not.toMatch(/at \w+ \(|node_modules|postgres/);
  });

  it("disables the chat endpoint unless Groq is configured, and still requires auth", async () => {
    const body = JSON.stringify({ message: "What is light?" });
    const post = (headers: Record<string, string>, env = makeEnv()) =>
      callWorker(new Request("https://worker.test/api/chat", { method: "POST", headers: { "content-type": "application/json", ...headers }, body }), env);
    expect((await post({})).status).toBe(401);
    const off = await post(auth);
    expect(off.status).toBe(503);
    expect((await json(off)).error.code).toBe("disabled");
    expect((await post(auth, makeEnv({ ENABLE_GROQ_ANSWERS: "true" }))).status).toBe(503);   // flag without key stays off
  });
});

const run = OWNER_DSN ? describe : describe.skip;

run("Groq-backed chat endpoint (real database, Groq network call stubbed)", () => {
  beforeAll(async () => { await setupDatabase(); });
  const env = () => makeEnv({ ENABLE_GROQ_ANSWERS: "true", GROQ_API_KEY: "gsk_test_key_do_not_leak", CONTENT_EXPOSURE: "excerpt" });
  const chat = (body: unknown, e = env()) =>
    callWorker(new Request("https://worker.test/api/chat", { method: "POST", headers: { "content-type": "application/json", ...auth }, body: JSON.stringify(body) }), e);
  const completion = (message: Record<string, unknown>) =>
    new Response(JSON.stringify({ model: "test-model", choices: [{ finish_reason: "stop", message }] }), { status: 200 });

  afterEach(() => vi.unstubAllGlobals());

  function stubGroq(replies: Array<(body: any) => Response>) {
    const calls: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://api.groq.test/openai/v1/chat/completions");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer gsk_test_key_do_not_leak");
      const body = JSON.parse(init.body as string);
      calls.push(body);
      return replies[Math.min(calls.length - 1, replies.length - 1)]!(body);
    }));
    return calls;
  }

  it("answers from retrieved passages and appends deterministic sources", async () => {
    const calls = stubGroq([() => completion({ content: "Light reflects off mirrors [S1]. It is also on page 77 of Some Other Book." })]);
    const res = await chat({ message: "What are the laws of reflection?", medium: "English" });
    expect(res.status).toBe(200);
    const out = await json(res);
    expect(out.grounded).toBe(true);
    expect(out.sources[0]).toMatchObject({ ref: "S1", title: "Science Textbook", class: "IX", chapter_title: "Light" });
    expect(out.answer).toMatch(/Sources:\n\[S1\] Science Textbook — Class IX, General Science \(English\), Chapter 1: Light, PDF p/);
    // the model request carries the passages as data, and excerpt mode asks for paraphrase
    expect(calls[0].messages[0].content).toMatch(/Paraphrase/);
    expect(calls[0].messages[1].content).toContain("<textbook_passages>");
    expect(calls[0].messages[1].content).toContain("laws of reflection");
    expect(JSON.stringify(out)).not.toContain("gsk_test_key_do_not_leak");
  });

  it("does not call Groq at all when the textbooks have nothing relevant", async () => {
    const calls = stubGroq([() => completion({ content: "never" })]);
    const out = await json(await chat({ message: "Explain quantum chromodynamics" }));
    expect(calls).toHaveLength(0);
    expect(out).toMatchObject({ grounded: false, sources: [], model: null });
  });

  it("replies in Assamese for Assamese questions and grounds on Assamese passages", async () => {
    const calls = stubGroq([() => completion({ content: "পোহৰৰ প্ৰতিফলন দৰ্পণত হয় [S1]।" })]);
    const out = await json(await chat({ message: "প্ৰতিফলন কি?" }));
    expect(calls[0].messages[1].content).toContain("Assamese");
    expect(out.answer).toContain("উৎস:");
    expect(out.sources[0].medium).toBe("Assamese");
  });

  it("summarises a chapter from its stored pages", async () => {
    const calls = stubGroq([() => completion({ content: "Chapter summary [S1] [S2] [S9]" })]);
    const out = await json(await chat({ message: "Summarise this chapter", task: "summarize_chapter", chapter_id: IDS.ch_light }));
    expect(calls[0].messages[1].content).toMatch(/Summarise the supplied chapter/);
    expect(out.sources.map((s: any) => s.ref)).toEqual(["S1", "S2"]);
    expect(out.dropped_citations).toEqual(["S9"]);
    expect(out.answer).not.toContain("S9");
    const bad = await chat({ message: "Summarise this chapter", task: "summarize_chapter" });
    expect(bad.status).toBe(400);
  });

  it("agentic mode lets the model call retrieval tools; sources come from what was actually returned", async () => {
    const calls = stubGroq([
      () => completion({ content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "search_textbook_content", arguments: JSON.stringify({ query: "echo", limit: 2 }) } }] }),
      () => completion({ content: "An echo is reflected sound [S1] [S4]." }),
    ]);
    const out = await json(await chat({ message: "What is an echo?", mode: "agentic" }));
    expect(calls[0].tools.map((t: any) => t.function.name)).toContain("search_textbook_content");
    expect(calls[0].tools.every((t: any) => t.function.name !== "answer_textbook_question")).toBe(true);
    const toolMessage = calls[1].messages.at(-1);
    expect(toolMessage.role).toBe("tool");
    expect(JSON.parse(toolMessage.content).passages[0].ref).toBe("S1");
    expect(out.tools_used).toEqual(["search_textbook_content"]);
    expect(out.sources[0]).toMatchObject({ ref: "S1", chapter_title: "Sound" });
    expect(out.dropped_citations).toEqual(["S4"]);
  });

  it("validates tool arguments produced by the model and feeds errors back instead of crashing", async () => {
    const calls = stubGroq([
      () => completion({ content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "search_textbook_content", arguments: JSON.stringify({ query: "x", limit: 9999 }) } }] }),
      () => completion({ content: "I could not search." }),
    ]);
    const out = await json(await chat({ message: "What is an echo?", mode: "agentic" }));
    expect(JSON.parse(calls[1].messages.at(-1).content).error).toMatch(/Invalid arguments/);
    expect(out.grounded).toBe(false);
  });

  it("surfaces Groq failures as safe errors without leaking the key or upstream text", async () => {
    stubGroq([() => new Response('{"error":{"message":"Invalid API Key gsk_test_key_do_not_leak"}}', { status: 401 })]);
    const res = await chat({ message: "What are the laws of reflection?" });
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toMatch(/gsk_test|Invalid API Key/);
    expect(JSON.parse(text).error.code).toBe("upstream_error");
  });

  it("falls back to the grounded pipeline when a model cannot do tool calling", async () => {
    stubGroq([
      (b) => (b.tools ? new Response('{"error":{"message":"tool_use_failed"}}', { status: 400 }) : completion({ content: "Fallback answer [S1]" })),
    ]);
    const out = await json(await chat({ message: "What are the laws of reflection?", mode: "agentic" }));
    expect(out.answer).toContain("Fallback answer");
    expect(out.grounded).toBe(true);
  });

  it("validates request bodies and size", async () => {
    stubGroq([() => completion({ content: "x" })]);
    expect((await chat({ message: "" })).status).toBe(400);
    expect((await chat({ message: "hi there", task: "nope" })).status).toBe(400);
    expect((await chat({ message: "hi there", class: "XII" })).status).toBe(400);
    const huge = await callWorker(new Request("https://worker.test/api/chat", { method: "POST", headers: { "content-type": "application/json", ...auth }, body: JSON.stringify({ message: "x".repeat(20_000) }) }), env());
    expect(huge.status).toBe(413);
    const notJson = await callWorker(new Request("https://worker.test/api/chat", { method: "POST", headers: auth, body: "nope" }), env());
    expect(notJson.status).toBe(400);
  });

  it("registers the optional MCP answer tool only when Groq is enabled", async () => {
    const { connect } = await import("../helpers/worker");
    const c = await connect(env());
    try {
      const names = (await c.listTools()).tools.map((t) => t.name);
      expect(names).toContain("answer_textbook_question");
      stubGroq([() => completion({ content: "MCP answer [S1]" })]);
      const r = await c.callTool({ name: "answer_textbook_question", arguments: { question: "What are the laws of reflection?", task: "answer" } });
      expect((r.structuredContent as any).sources[0].ref).toBe("S1");
    } finally { await c.close(); }
  });
});
