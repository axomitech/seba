/**
 * Structured, allow-listed logging. Only primitive fields explicitly passed are logged;
 * never pass request bodies, passages, learner questions, tokens, or connection strings.
 */
const FORBIDDEN = /key|token|secret|password|authorization|connection|dsn|url/i;

export function logEvent(level: "info" | "warn" | "error", event: string, fields: Record<string, string | number | boolean | null | undefined> = {}): void {
  const safe: Record<string, unknown> = { level, event };
  for (const [k, v] of Object.entries(fields)) {
    if (FORBIDDEN.test(k)) continue;
    safe[k] = typeof v === "string" ? v.slice(0, 200) : v;
  }
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(JSON.stringify(safe));
}

/** Class/name only: error messages from drivers may embed connection details. */
export function errorSummary(e: unknown): { error_name: string; error_code?: string } {
  const err = e as { name?: string; code?: string };
  return { error_name: err?.name ?? "Error", ...(err?.code ? { error_code: String(err.code) } : {}) };
}
