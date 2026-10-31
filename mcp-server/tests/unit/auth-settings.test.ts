import { beforeEach, describe, expect, it } from "vitest";
import { authenticate, safeEqual } from "../../src/utils/auth";
import { allowRequest, resetLocalRateLimits } from "../../src/utils/rate-limit";
import { readSettings } from "../../src/types/environment";
import { AppError, toSafeError } from "../../src/utils/errors";
import { logEvent } from "../../src/utils/log";
import { vi } from "vitest";

const TOKEN = "t".repeat(32);
const req = (h: Record<string, string> = {}) => new Request("https://x/mcp", { method: "POST", headers: h });

describe("settings fail closed", () => {
  it("requires auth unless AUTH_MODE is exactly 'none'", () => {
    expect(readSettings({}).authRequired).toBe(true);
    expect(readSettings({ AUTH_MODE: "off" }).authRequired).toBe(true);
    expect(readSettings({ AUTH_MODE: "NONE " }).authRequired).toBe(false);
  });
  it("is excerpt-only unless CONTENT_EXPOSURE is 'full'", () => {
    expect(readSettings({}).contentExposure).toBe("excerpt");
    expect(readSettings({ CONTENT_EXPOSURE: "yes" }).contentExposure).toBe("excerpt");
    expect(readSettings({ CONTENT_EXPOSURE: "Full" }).contentExposure).toBe("full");
  });
  it("only enables Groq when flag AND key are present", () => {
    expect(readSettings({ ENABLE_GROQ_ANSWERS: "true" }).groqEnabled).toBe(false);
    expect(readSettings({ ENABLE_GROQ_ANSWERS: "true", GROQ_API_KEY: "k" }).groqEnabled).toBe(true);
    expect(readSettings({ GROQ_API_KEY: "k" }).groqEnabled).toBe(false);
  });
  it("clamps numeric settings", () => {
    expect(readSettings({ EXCERPT_CHARS: "999999" }).excerptChars).toBe(4000);
    expect(readSettings({ EXCERPT_CHARS: "abc" }).excerptChars).toBe(600);
  });
});

describe("authentication", () => {
  const s = readSettings({});
  it("refuses everything (503) when auth is required but no token is configured", async () => {
    for (const env of [{}, { MCP_AUTH_TOKEN: "" }, { MCP_AUTH_TOKEN: "short" }]) {
      const r = await authenticate(req({ authorization: "Bearer short" }), env, s);
      expect(r).toMatchObject({ ok: false, status: 503 });
    }
  });
  it("accepts the right bearer token and rejects wrong, missing and malformed ones", async () => {
    const env = { MCP_AUTH_TOKEN: TOKEN };
    expect(await authenticate(req({ authorization: `Bearer ${TOKEN}` }), env, s)).toMatchObject({ ok: true });
    for (const h of [{} as Record<string, string>, { authorization: "Bearer nope" }, { authorization: TOKEN }, { authorization: `Basic ${TOKEN}` }, { authorization: `Bearer ${TOKEN} extra` }]) {
      expect(await authenticate(req(h), env, s)).toMatchObject({ ok: false, status: 401 });
    }
  });
  it("derives a client key that does not reveal the token", async () => {
    const r = await authenticate(req({ authorization: `Bearer ${TOKEN}` }), { MCP_AUTH_TOKEN: TOKEN }, s);
    expect(r.ok && r.clientKey).toMatch(/^[0-9a-f]{16}$/);
  });
  it("allows anonymous access only in explicit public mode", async () => {
    expect(await authenticate(req(), {}, readSettings({ AUTH_MODE: "none" }))).toMatchObject({ ok: true });
  });
  it("compares secrets without early exit on length", async () => {
    expect(await safeEqual("abc", "abc")).toBe(true);
    expect(await safeEqual("abc", "abcd")).toBe(false);
    expect(await safeEqual("", "")).toBe(true);
  });
});

describe("rate limiting", () => {
  beforeEach(() => resetLocalRateLimits());
  it("enforces a per-key window locally and isolates keys", async () => {
    const t = 1_000_000;
    for (let i = 0; i < 60; i++) expect(await allowRequest({}, "a", t)).toBe(true);
    expect(await allowRequest({}, "a", t + 10)).toBe(false);
    expect(await allowRequest({}, "b", t + 10)).toBe(true);
    expect(await allowRequest({}, "a", t + 61_000)).toBe(true);      // window rolled over
  });
  it("uses the Cloudflare binding when present", async () => {
    const env = { RATE_LIMITER: { limit: async ({ key }: { key: string }) => ({ success: key !== "blocked" }) } };
    expect(await allowRequest(env as never, "ok")).toBe(true);
    expect(await allowRequest(env as never, "blocked")).toBe(false);
  });
});

describe("error and log hygiene", () => {
  it("never leaks internal error text to clients", () => {
    const internal = new Error("connect ECONNREFUSED postgres://user:secret@10.0.0.5/db");
    expect(JSON.stringify(toSafeError(internal))).not.toMatch(/secret|postgres|10\.0/);
    expect(toSafeError(new AppError("not_found", "Textbook not found"))).toEqual({ code: "not_found", message: "Textbook not found" });
  });
  it("drops secret-looking fields from logs", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    logEvent("info", "x", { tool: "t", api_key: "sk-123", authorization: "Bearer abc", connection_string: "postgres://u:p@h/d", ms: 5 });
    const line = String(spy.mock.calls[0]![0]);
    spy.mockRestore();
    expect(line).toContain('"tool":"t"');
    expect(line).not.toMatch(/sk-123|Bearer|postgres/);
  });
});
