import type { AppEnv } from "../types/environment";

/**
 * Rate limiting. Production uses Cloudflare's Rate Limiting binding (approximate, per location).
 * Without the binding (local dev/tests) a small in-isolate fixed window is used. Both are
 * best-effort protections for free-tier budgets, not strict quotas.
 */
const WINDOW_MS = 60_000;
const LOCAL_LIMIT = 60;
const buckets = new Map<string, { start: number; count: number }>();

export async function allowRequest(env: Partial<AppEnv>, key: string, now = Date.now()): Promise<boolean> {
  if (env.RATE_LIMITER) {
    const { success } = await env.RATE_LIMITER.limit({ key });
    return success;
  }
  const b = buckets.get(key);
  if (!b || now - b.start >= WINDOW_MS) {
    if (buckets.size > 5000) buckets.clear();
    buckets.set(key, { start: now, count: 1 });
    return true;
  }
  b.count += 1;
  return b.count <= LOCAL_LIMIT;
}

export function resetLocalRateLimits(): void {
  buckets.clear();
}
