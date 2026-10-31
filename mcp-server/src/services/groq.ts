import { AppError } from "../utils/errors";
import { logEvent } from "../utils/log";

/**
 * Reusable Groq client (OpenAI-compatible Chat Completions + Responses API for remote MCP).
 * Knows nothing about textbooks or the database. Verified against https://console.groq.com/docs :
 *   - POST {base}/chat/completions with `tools` for local function calling
 *   - POST {base}/responses with a `{type:"mcp", server_url, headers, ...}` tool for remote MCP (beta, HTTPS only)
 * The model id is configuration; not every model supports every feature, so callers should treat
 * `GroqError` from tool calling as recoverable and fall back to a plain completion.
 */
export interface GroqToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type GroqMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: GroqToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface GroqToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatOptions {
  messages: GroqMessage[];
  tools?: GroqToolSpec[];
  toolChoice?: "auto" | "none" | "required";
  temperature?: number;
  maxTokens?: number;
}

export interface ChatResult {
  content: string;
  toolCalls: GroqToolCall[];
  finishReason: string | null;
  model: string;
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null;
}

export class GroqError extends AppError {
  constructor(message: string, public readonly upstreamStatus: number | null, public readonly kind: "auth" | "rate_limit" | "model" | "tool" | "network" | "other") {
    super("upstream_error", message, 502);
  }
}

export interface GroqConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  fetchImpl?: typeof fetch;
}

export class GroqService {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly cfg: GroqConfig) {
    if (!cfg.apiKey) throw new GroqError("Groq is not configured", null, "auth");
    if (!cfg.model) throw new GroqError("GROQ_MODEL is not configured", null, "model");
    this.baseUrl = (cfg.baseUrl ?? "https://api.groq.com/openai/v1").replace(/\/+$/, "");
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  get model(): string {
    return this.cfg.model;
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    const retries = this.cfg.maxRetries ?? 2;
    let lastStatus: number | null = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), this.cfg.timeoutMs ?? 25_000);
      try {
        const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.cfg.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: ctl.signal,
        });
        lastStatus = res.status;
        if (res.ok) return await res.json();
        const detail = await res.text().catch(() => "");
        if ((res.status === 429 || res.status >= 500) && attempt < retries) {
          const wait = Math.min(Number(res.headers.get("retry-after")) || 0.5 * (attempt + 1), 4);
          await new Promise((r) => setTimeout(r, wait * 1000));
          continue;
        }
        logEvent("warn", "groq_error", { status: res.status });
        throw this.toError(res.status, detail);
      } catch (e) {
        if (e instanceof GroqError) throw e;
        if (attempt < retries) continue;
        logEvent("warn", "groq_network_error", { status: lastStatus });
        throw new GroqError("The language model service is unreachable.", null, "network");
      } finally {
        clearTimeout(timer);
      }
    }
    throw new GroqError("The language model service failed.", lastStatus, "other");
  }

  private toError(status: number, detail: string): GroqError {
    if (status === 401 || status === 403) return new GroqError("The language model credentials were rejected.", status, "auth");
    if (status === 429) return new GroqError("The language model is rate limited. Try again shortly.", status, "rate_limit");
    if (status === 404 || /model/i.test(detail) && status === 400) return new GroqError("The configured language model is not available.", status, "model");
    if (/tool/i.test(detail)) return new GroqError("The model could not complete the tool call.", status, "tool");
    return new GroqError(`The language model service returned an error (${status}).`, status, "other");
  }

  async chat(opts: ChatOptions): Promise<ChatResult> {
    const body: Record<string, unknown> = {
      model: this.cfg.model,
      messages: opts.messages,
      temperature: opts.temperature ?? 0.2,
      max_completion_tokens: opts.maxTokens ?? 1200,
    };
    if (opts.tools?.length) {
      body.tools = opts.tools;
      body.tool_choice = opts.toolChoice ?? "auto";
    }
    const json = (await this.post("/chat/completions", body)) as {
      model?: string;
      choices?: Array<{ finish_reason?: string; message?: { content?: string | null; tool_calls?: GroqToolCall[] } }>;
      usage?: ChatResult["usage"];
    };
    const choice = json.choices?.[0];
    if (!choice?.message) throw new GroqError("The language model returned an empty response.", null, "other");
    return {
      content: choice.message.content ?? "",
      toolCalls: choice.message.tool_calls ?? [],
      finishReason: choice.finish_reason ?? null,
      model: json.model ?? this.cfg.model,
      usage: json.usage ?? null,
    };
  }

  /**
   * Local function-calling loop: the model requests tools, `execute` runs them (here: the same
   * handlers that back the MCP tools), results are fed back until the model answers.
   */
  async runWithTools(
    messages: GroqMessage[],
    tools: GroqToolSpec[],
    execute: (name: string, args: unknown) => Promise<unknown>,
    opts: { maxSteps?: number; maxTokens?: number; toolResultChars?: number } = {},
  ): Promise<{ content: string; steps: number; toolsUsed: string[] }> {
    const convo = [...messages];
    const used: string[] = [];
    const maxSteps = opts.maxSteps ?? 4;
    for (let step = 1; step <= maxSteps + 1; step++) {
      const last = step > maxSteps;
      const res = await this.chat({ messages: convo, tools, toolChoice: last ? "none" : "auto", maxTokens: opts.maxTokens });
      if (res.toolCalls.length === 0 || last) return { content: res.content, steps: step, toolsUsed: used };
      convo.push({ role: "assistant", content: res.content || null, tool_calls: res.toolCalls });
      for (const call of res.toolCalls) {
        used.push(call.function.name);
        let output: unknown;
        try {
          output = await execute(call.function.name, JSON.parse(call.function.arguments || "{}"));
        } catch (e) {
          // tool errors go back to the model as data so it can retry or explain
          output = { error: e instanceof AppError ? e.message : "tool failed" };
        }
        convo.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(output).slice(0, opts.toolResultChars ?? 14000) });
      }
    }
    return { content: "", steps: maxSteps, toolsUsed: used };
  }

  /**
   * Remote MCP via the Responses API (beta): Groq connects to the MCP server itself. Only usable when the
   * MCP server is publicly reachable over HTTPS. `headers` carries the MCP bearer token and is redacted by Groq.
   */
  async respondWithRemoteMcp(opts: {
    input: string; instructions?: string; serverUrl: string; serverLabel: string;
    headers?: Record<string, string>; allowedTools?: string[];
  }): Promise<{ text: string; mcpCalls: string[] }> {
    if (!opts.serverUrl.startsWith("https://")) throw new AppError("invalid_input", "Remote MCP requires an HTTPS server URL");
    const json = (await this.post("/responses", {
      model: this.cfg.model,
      input: opts.input,
      ...(opts.instructions ? { instructions: opts.instructions } : {}),
      tools: [{
        type: "mcp", server_label: opts.serverLabel, server_url: opts.serverUrl, require_approval: "never",
        ...(opts.headers ? { headers: opts.headers } : {}),
        ...(opts.allowedTools ? { allowed_tools: opts.allowedTools } : {}),
      }],
    })) as { output?: Array<{ type: string; name?: string; role?: string; content?: Array<{ type: string; text?: string }> }> };
    const output = json.output ?? [];
    const msg = [...output].reverse().find((o) => o.type === "message" && o.role === "assistant");
    const text = msg?.content?.filter((c) => c.type === "output_text").map((c) => c.text ?? "").join("") ?? "";
    return { text, mcpCalls: output.filter((o) => o.type === "mcp_call").map((o) => o.name ?? "") };
  }

  /** Model ids available to this key (GET /models) - used by `npm run check:groq`. */
  async listModels(): Promise<string[]> {
    const res = await this.fetchImpl(`${this.baseUrl}/models`, { headers: { Authorization: `Bearer ${this.cfg.apiKey}` } });
    if (!res.ok) throw this.toError(res.status, "");
    const json = (await res.json()) as { data?: Array<{ id: string }> };
    return (json.data ?? []).map((m) => m.id);
  }
}
