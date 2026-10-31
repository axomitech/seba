import { createMcpHandler } from "agents/mcp/server";
import { handleChat } from "./http/chat";
import { errorResponse, json, readLimitedText } from "./http/respond";
import { createSebaServer, SERVER_NAME, SERVER_VERSION } from "./mcp/create-server";
import { createToolContext } from "./mcp/tools/define";
import { readSettings, type AppEnv, type Settings } from "./types/environment";
import { authenticate } from "./utils/auth";
import { MAX_REQUEST_BYTES } from "./utils/limits";
import { errorSummary, logEvent } from "./utils/log";
import { allowRequest } from "./utils/rate-limit";

function corsFor(request: Request, settings: Settings) {
  const origin = request.headers.get("origin");
  if (!origin || !settings.allowedOrigins.includes(origin)) return false as const;
  return {
    origin,
    methods: "GET, POST, DELETE, OPTIONS",
    headers: "content-type, authorization, mcp-protocol-version, mcp-session-id, accept",
    exposeHeaders: "mcp-session-id",
    maxAge: 600,
  };
}

/** Checks that run before any handler: body size, authentication, rate limit. Returns a Response to stop, or the
 *  (possibly re-created) request to continue with. */
async function guard(request: Request, env: AppEnv, settings: Settings): Promise<Response | Request> {
  // Content-Length can be absent (chunked) or wrong, so also bound the bytes actually read.
  let req = request;
  if (request.method === "POST") {
    const text = await readLimitedText(request, MAX_REQUEST_BYTES);
    if (text === null) return errorResponse(413, "payload_too_large", "Request body too large");
    req = new Request(request, { body: text });
  }
  const auth = await authenticate(req, env, settings);
  if (!auth.ok) {
    return errorResponse(auth.status, auth.status === 401 ? "unauthorized" : "unavailable", auth.message,
      auth.status === 401 ? { "www-authenticate": 'Bearer realm="seba-textbook-mcp"' } : {});
  }
  if (!(await allowRequest(env, auth.clientKey))) {
    logEvent("warn", "rate_limited");
    return errorResponse(429, "rate_limited", "Too many requests. Please slow down.", { "retry-after": "30" });
  }
  return req;
}

export default {
  async fetch(incoming: Request, env: AppEnv, execCtx: ExecutionContext): Promise<Response> {
    let request = incoming;
    const url = new URL(request.url);
    const settings = readSettings(env);
    try {
      if (url.pathname === "/healthz") {
        // liveness only: no database access, no configuration details
        return request.method === "GET" || request.method === "HEAD"
          ? json({ status: "ok", service: SERVER_NAME, version: SERVER_VERSION })
          : errorResponse(405, "invalid_input", "Use GET", { allow: "GET, HEAD" });
      }

      if (url.pathname === "/mcp") {
        if (request.method !== "OPTIONS") {
          const checked = await guard(request, env, settings);
          if (checked instanceof Response) return checked;
          request = checked;
        }
        const ctx = createToolContext(env);
        const handler = createMcpHandler(() => createSebaServer(ctx), { route: "/mcp", corsOptions: corsFor(request, settings) });
        return await handler(request, env, execCtx);
      }

      if (url.pathname === "/api/chat") {
        if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { allow: "POST, OPTIONS" } });
        const checked = await guard(request, env, settings);
        if (checked instanceof Response) return checked;
        return await handleChat(checked, createToolContext(env));
      }

      return errorResponse(404, "not_found", "Not found");
    } catch (e) {
      logEvent("error", "unhandled", { path: url.pathname, ...errorSummary(e) });
      return errorResponse(500, "internal", "An internal error occurred.");
    }
  },
} satisfies ExportedHandler<AppEnv>;
