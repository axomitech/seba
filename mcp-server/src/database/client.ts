import pg from "pg";
import { AppError } from "../utils/errors";
import { errorSummary, logEvent } from "../utils/log";
import { DB_CONNECT_TIMEOUT_MS, DB_QUERY_TIMEOUT_MS } from "../utils/limits";

export interface Db {
  /** Always parameterised: callers pass SQL with $1..$n placeholders and a separate params array. */
  query<R extends object = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R[]>;
}

/**
 * Run `fn` with a fresh connection and always close it. On Workers the connection string comes from
 * `env.HYPERDRIVE.connectionString`; Hyperdrive pools the real upstream connections, so a short-lived
 * client per operation is the intended usage. Driver errors are logged by class/code only and
 * surfaced to callers as a generic "unavailable" error (they can contain host/user details).
 */
export async function withDb<T>(connectionString: string, fn: (db: Db) => Promise<T>): Promise<T> {
  const client = new pg.Client({
    connectionString,
    connectionTimeoutMillis: DB_CONNECT_TIMEOUT_MS,
    query_timeout: DB_QUERY_TIMEOUT_MS,
    statement_timeout: DB_QUERY_TIMEOUT_MS,
  });
  try {
    await client.connect();
  } catch (e) {
    logEvent("error", "db_connect_failed", errorSummary(e));
    throw new AppError("unavailable", "The textbook database is temporarily unavailable.", 503);
  }
  try {
    return await fn({
      query: async <R extends object>(sql: string, params: unknown[] = []) => {
        try {
          return (await client.query(sql, params)).rows as R[];
        } catch (e) {
          if (e instanceof AppError) throw e;
          logEvent("error", "db_query_failed", errorSummary(e));
          const code = (e as { code?: string }).code;
          if (code === "57014") throw new AppError("unavailable", "The query took too long. Try a narrower search.", 504);
          throw new AppError("unavailable", "The textbook database is temporarily unavailable.", 503);
        }
      },
    });
  } finally {
    await client.end().catch(() => undefined);
  }
}
