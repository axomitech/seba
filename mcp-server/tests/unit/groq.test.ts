import { describe, expect, it, vi } from "vitest";
import { GroqError, GroqService } from "../../src/services/groq";

/** These tests exercise our HTTP contract with Groq's documented API using a fake fetch.
 *  They do NOT prove the live API accepts the request: see `npm run check:groq` for that. */
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
const completion = (message: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ok({ model: "m1", choices: [{ finish_reason: "stop", message }], usage: { total_tokens: 7 }, ...extra });

const make = (fetchImpl: typeof fetch, over: Record<string, unknown> = {}) =>
  new GroqService({ apiKey: "gsk_secret_key", model: "llama-3.3-70b-versatile", fetchImpl, maxRetries: 2, ...over });

describe("GroqService", () => {
  it("sends an OpenAI-compatible chat completion request", async () => {
    const f = vi.fn(async () => completion({ content: "hello" }));
    const res = await make(f as never).chat({ messages: [{ role: "user", content: "hi" }], maxTokens: 50 });
    expect(res.content).toBe("hello");
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer gsk_secret_key");
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ model: "llama-3.3-70b-versatile", max_completion_tokens: 50 });
    expect(body.tools).toBeUndefined();
  });

  it("does not require a hard-coded model: it uses the configured id", async () => {
    const f = vi.fn(async () => completion({ content: "x" }));
    await make(f as never, { model: "openai/gpt-oss-120b" }).chat({ messages: [{ role: "user", content: "hi" }] });
    expect(JSON.parse(((f.mock.calls[0] as unknown[])[1] as RequestInit).body as string).model).toBe("openai/gpt-oss-120b");
    expect(() => new GroqService({ apiKey: "", model: "m" })).toThrow(GroqError);
    expect(() => new GroqService({ apiKey: "k", model: "" })).toThrow(GroqError);
  });

  it("retries 429/5xx then succeeds, but not auth errors", async () => {
    let n = 0;
    const flaky = vi.fn(async () => (++n < 3 ? new Response("{}", { status: n === 1 ? 429 : 503, headers: { "retry-after": "0" } }) : completion({ content: "finally" })));
    expect((await make(flaky as never).chat({ messages: [{ role: "user", content: "x" }] })).content).toBe("finally");
    expect(flaky).toHaveBeenCalledTimes(3);
    const denied = vi.fn(async () => new Response('{"error":{"message":"Invalid API Key gsk_secret_key"}}', { status: 401 }));
    await expect(make(denied as never).chat({ messages: [{ role: "user", content: "x" }] })).rejects.toMatchObject({ kind: "auth" });
    expect(denied).toHaveBeenCalledTimes(1);
  });

  it("never puts the API key or upstream error text into thrown messages", async () => {
    const f = vi.fn(async () => new Response('{"error":{"message":"bad key gsk_secret_key"}}', { status: 401 }));
    const err = await make(f as never).chat({ messages: [{ role: "user", content: "x" }] }).then(() => null, (e: Error) => e);
    expect(err).toBeInstanceOf(GroqError);
    expect(String(err?.message)).not.toContain("gsk_secret_key");
  });

  it("classifies model-not-found and gives up after retries on persistent 5xx", async () => {
    const missing = vi.fn(async () => new Response('{"error":{"message":"model_not_found"}}', { status: 404 }));
    await expect(make(missing as never).chat({ messages: [{ role: "user", content: "x" }] })).rejects.toMatchObject({ kind: "model" });
    const down = vi.fn(async () => new Response("{}", { status: 503, headers: { "retry-after": "0" } }));
    await expect(make(down as never).chat({ messages: [{ role: "user", content: "x" }] })).rejects.toBeInstanceOf(GroqError);
    expect(down).toHaveBeenCalledTimes(3);
  });

  it("runs a tool-calling loop: executes tools, feeds results back, returns the final answer", async () => {
    const calls: unknown[] = [];
    const f = vi.fn()
      .mockResolvedValueOnce(completion({ content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "search_textbook_content", arguments: '{"query":"light"}' } }] }))
      .mockResolvedValueOnce(completion({ content: "Light is [S1]." }));
    const out = await make(f as never).runWithTools(
      [{ role: "user", content: "what is light" }],
      [{ type: "function", function: { name: "search_textbook_content", description: "d", parameters: { type: "object" } } }],
      async (name, args) => { calls.push([name, args]); return { passages: [] }; },
    );
    expect(out).toMatchObject({ content: "Light is [S1].", toolsUsed: ["search_textbook_content"] });
    expect(calls).toEqual([["search_textbook_content", { query: "light" }]]);
    const second = JSON.parse(((f.mock.calls[1] as unknown[])[1] as RequestInit).body as string);
    expect(second.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "c1" });
    expect(second.messages.at(-2).tool_calls[0].id).toBe("c1");
  });

  it("reports tool failures and malformed arguments back to the model instead of crashing", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(completion({ content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "x", arguments: "{not json" } }] }))
      .mockResolvedValueOnce(completion({ content: "sorry" }));
    const out = await make(f as never).runWithTools([{ role: "user", content: "q" }], [], async () => "never");
    expect(out.content).toBe("sorry");
    const toolMsg = JSON.parse(((f.mock.calls[1] as unknown[])[1] as RequestInit).body as string).messages.at(-1);
    expect(JSON.parse(toolMsg.content)).toHaveProperty("error");
  });

  it("bounds the number of tool rounds", async () => {
    const f = vi.fn(async () => completion({ content: "", tool_calls: [{ id: "c", type: "function", function: { name: "t", arguments: "{}" } }] }));
    const out = await make(f as never).runWithTools([{ role: "user", content: "q" }], [], async () => ({}), { maxSteps: 2 });
    expect(out.steps).toBeLessThanOrEqual(3);
    expect(f.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it("builds a remote-MCP request for the Responses API and extracts the final text", async () => {
    const f = vi.fn(async () => ok({ output: [{ type: "mcp_list_tools" }, { type: "mcp_call", name: "search_textbook_content" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "answer" }] }] }));
    const res = await make(f as never).respondWithRemoteMcp({
      input: "q", serverUrl: "https://example.workers.dev/mcp", serverLabel: "seba", headers: { Authorization: "Bearer t" }, allowedTools: ["search_textbook_content"],
    });
    expect(res).toEqual({ text: "answer", mcpCalls: ["search_textbook_content"] });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.groq.com/openai/v1/responses");
    expect(JSON.parse(init.body as string).tools[0]).toMatchObject({ type: "mcp", server_label: "seba", require_approval: "never", allowed_tools: ["search_textbook_content"] });
    await expect(make(f as never).respondWithRemoteMcp({ input: "q", serverUrl: "http://insecure/mcp", serverLabel: "s" })).rejects.toThrow(/HTTPS/);
  });
});
