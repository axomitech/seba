import type { AppEnv, Settings } from "../types/environment";

const enc = new TextEncoder();

async function digest(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

/** Constant-time comparison of two secrets (compares fixed-length SHA-256 digests). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([digest(a), digest(b)]);
  let diff = 0;
  for (let i = 0; i < da.length; i++) diff |= da[i]! ^ db[i]!;
  return diff === 0;
}

export type AuthResult =
  | { ok: true; clientKey: string }
  | { ok: false; status: 401 | 503; message: string };

/**
 * Bearer-token authentication. Fails CLOSED: when authentication is required but no token is
 * configured, every request is refused with 503 instead of silently opening the service.
 */
export async function authenticate(request: Request, env: Partial<AppEnv>, settings: Settings): Promise<AuthResult> {
  if (!settings.authRequired) {
    return { ok: true, clientKey: request.headers.get("cf-connecting-ip") ?? "anonymous" };
  }
  const expected = env.MCP_AUTH_TOKEN;
  if (!expected || expected.length < 16) {
    return { ok: false, status: 503, message: "Server authentication is not configured" };
  }
  const header = request.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(header);
  if (!m || !(await safeEqual(m[1]!, expected))) {
    return { ok: false, status: 401, message: "Unauthorized" };
  }
  // per-client key without exposing the token: first 16 hex chars of its digest
  const d = await digest(m[1]!);
  return { ok: true, clientKey: [...d.slice(0, 8)].map((b) => b.toString(16).padStart(2, "0")).join("") };
}
