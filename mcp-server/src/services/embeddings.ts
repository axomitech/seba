import type { AppEnv, Settings } from "../types/environment";
import { AppError } from "../utils/errors";
import { errorSummary, logEvent } from "../utils/log";

/** Query embedding via the Workers AI binding. Must be the same model the ingestion engine used. */
export function makeQueryEmbedder(env: Partial<AppEnv>, settings: Settings): ((q: string) => Promise<number[]>) | undefined {
  const ai = env.AI;
  if (!settings.embeddingsEnabled || !ai) return undefined;
  return async (q: string) => {
    try {
      const out = (await ai.run(settings.embeddingModel as never, { text: [q] } as never)) as unknown;
      const o = out as { data?: number[][]; result?: { data?: number[][] } };
      const vec = o?.data?.[0] ?? o?.result?.data?.[0];
      if (!Array.isArray(vec) || vec.length !== 1024) throw new Error("unexpected embedding shape");
      return vec;
    } catch (e) {
      logEvent("error", "query_embedding_failed", errorSummary(e));
      throw new AppError("unavailable", "Semantic search is temporarily unavailable.", 503);
    }
  };
}
