import type { z } from "zod";
import type { Db } from "../../database/client";
import { withDb } from "../../database/client";
import type { AppEnv, Settings } from "../../types/environment";
import { readSettings } from "../../types/environment";
import { makeQueryEmbedder } from "../../services/embeddings";
import { AppError } from "../../utils/errors";

export interface ToolContext {
  env: AppEnv;
  settings: Settings;
  /** open a short-lived database connection for the duration of `fn` */
  withDb<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  embedQuery?: (q: string) => Promise<number[]>;
}

export function createToolContext(env: AppEnv, opts: { connectionString?: string } = {}): ToolContext {
  const settings = readSettings(env);
  const cs = opts.connectionString ?? env.HYPERDRIVE?.connectionString;
  return {
    env,
    settings,
    withDb: (fn) => {
      if (!cs) throw new AppError("unavailable", "The textbook database is not configured.", 503);
      return withDb(cs, fn);
    },
    embedQuery: makeQueryEmbedder(env, settings),
  };
}

export interface ToolDef<S extends z.ZodObject = z.ZodObject> {
  name: string;
  title: string;
  description: string;
  inputSchema: S;
  /** only registered when this returns true (e.g. Groq tool needs a configured key) */
  enabled?: (ctx: ToolContext) => boolean;
  run(ctx: ToolContext, input: z.infer<S>): Promise<Record<string, unknown>>;
}

export function defineTool<S extends z.ZodObject>(def: ToolDef<S>): ToolDef<S> {
  return def;
}
