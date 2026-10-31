/** Bindings, vars and secrets of the Worker. Secrets never appear in wrangler.jsonc. */
export interface AppEnv {
  HYPERDRIVE: Hyperdrive;
  RATE_LIMITER?: RateLimit;
  /** Optional Workers AI binding, only needed for semantic query embeddings. */
  AI?: Ai;

  APP_ENV: string;
  AUTH_MODE: string;
  CONTENT_EXPOSURE: string;
  EXCERPT_CHARS: string;
  ALLOWED_ORIGINS: string;
  ENABLE_GROQ_ANSWERS: string;
  GROQ_MODEL: string;
  GROQ_BASE_URL: string;
  EMBEDDINGS_ENABLED: string;
  EMBEDDING_MODEL: string;

  /** secret: bearer token required on /mcp and /api/chat when AUTH_MODE=required */
  MCP_AUTH_TOKEN?: string;
  /** secret: Groq API key (only for the optional answer tool / chat endpoint) */
  GROQ_API_KEY?: string;
}

export interface Settings {
  authRequired: boolean;
  contentExposure: "full" | "excerpt";
  excerptChars: number;
  allowedOrigins: string[];
  groqEnabled: boolean;
  groqModel: string;
  groqBaseUrl: string;
  embeddingsEnabled: boolean;
  embeddingModel: string;
  appEnv: string;
}

function int(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export function readSettings(env: Partial<AppEnv>): Settings {
  const flag = (v: string | undefined) => (v ?? "").trim().toLowerCase() === "true";
  return {
    // fail closed: anything other than the literal "none" requires authentication
    authRequired: (env.AUTH_MODE ?? "required").trim().toLowerCase() !== "none",
    // fail closed: anything other than the literal "full" is excerpt-only
    contentExposure: (env.CONTENT_EXPOSURE ?? "excerpt").trim().toLowerCase() === "full" ? "full" : "excerpt",
    excerptChars: int(env.EXCERPT_CHARS, 600, 100, 4000),
    allowedOrigins: (env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    groqEnabled: flag(env.ENABLE_GROQ_ANSWERS) && Boolean(env.GROQ_API_KEY),
    groqModel: (env.GROQ_MODEL ?? "").trim(),
    groqBaseUrl: (env.GROQ_BASE_URL ?? "https://api.groq.com/openai/v1").replace(/\/+$/, ""),
    embeddingsEnabled: flag(env.EMBEDDINGS_ENABLED) && Boolean(env.AI),
    embeddingModel: (env.EMBEDDING_MODEL ?? "@cf/baai/bge-m3").trim(),
    appEnv: env.APP_ENV ?? "production",
  };
}
