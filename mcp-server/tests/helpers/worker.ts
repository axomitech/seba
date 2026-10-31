import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import worker from "../../src/index";
import type { AppEnv } from "../../src/types/environment";
import { EMBED_MODEL, readerDsn, topicVector } from "./db";

export const TOKEN = "integration-test-token-0123456789abcdef";

export function makeEnv(over: Record<string, unknown> = {}): AppEnv {
  return {
    HYPERDRIVE: { connectionString: readerDsn() },
    RATE_LIMITER: { limit: async () => ({ success: true }) },   // rate limiting is tested separately
    APP_ENV: "test", AUTH_MODE: "required", MCP_AUTH_TOKEN: TOKEN,
    CONTENT_EXPOSURE: "full", EXCERPT_CHARS: "600", ALLOWED_ORIGINS: "https://allowed.example",
    ENABLE_GROQ_ANSWERS: "false", GROQ_MODEL: "test-model", GROQ_BASE_URL: "https://api.groq.test/openai/v1",
    EMBEDDINGS_ENABLED: "false", EMBEDDING_MODEL: EMBED_MODEL,
    ...over,
  } as unknown as AppEnv;
}

/** Fake Workers AI binding: deterministic embeddings matching the fixture vectors. */
export const fakeAi = { run: async (_m: string, input: { text: string[] }) => ({ shape: [1, 1024], data: [topicVector(input.text[0]!)] }) } as unknown as Ai;

const execCtx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

export const callWorker = (req: Request, env: AppEnv) => worker.fetch(req, env, execCtx);

export async function connect(env: AppEnv, token: string | null = TOKEN) {
  const client = new Client({ name: "integration", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL("https://worker.test/mcp"), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
    fetch: (url, init) => callWorker(new Request(url as string, init as RequestInit), env),
  });
  await client.connect(transport);
  return client;
}

export interface ToolOutcome<T = Record<string, any>> { isError: boolean; data: T; text: string }

export async function call<T = Record<string, any>>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<ToolOutcome<T>> {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as Array<{ type: string; text?: string }>).map((c) => c.text ?? "").join("");
  let data: unknown = r.structuredContent;
  if (!data) { try { data = JSON.parse(text); } catch { data = { raw: text }; } }
  return { isError: Boolean(r.isError), data: data as T, text };
}
