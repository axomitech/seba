import type { Db } from "../database/client";
import type { TextbookFilters } from "../database/queries/sql";
import { fuse, keywordSearch, semanticSearch, type PassageRow, type SearchMode, type SearchOptions } from "../database/queries/content";
import type { Settings } from "../types/environment";
import { errorSummary, logEvent } from "../utils/log";
import { normalizeQuery } from "../utils/text";
import { AppError } from "../utils/errors";

export interface ContentSearchInput {
  query: string;
  filters: TextbookFilters;
  limit: number;
  mode: SearchMode | "auto";
  kind?: "body" | "exercise";
  perBook?: number;
  chapterId?: string;
}

export interface ContentSearchResult {
  rows: PassageRow[];
  mode_used: SearchMode;
  notes: string[];
}

export interface SearchDeps {
  db: Db;
  settings: Settings;
  embedQuery?: (q: string) => Promise<number[]>;
}

/**
 * Retrieval entry point shared by MCP tools and the optional tutor. Chooses keyword, semantic or
 * hybrid search depending on what is configured, and degrades to keyword search when the embedding
 * service is unavailable. Contains no LLM logic.
 */
export async function searchContent(deps: SearchDeps, input: ContentSearchInput): Promise<ContentSearchResult> {
  const query = normalizeQuery(input.query);
  const opts: SearchOptions = {
    filters: input.filters, limit: input.limit, kind: input.kind, perBook: input.perBook, chapterId: input.chapterId,
  };
  const notes: string[] = [];
  const canSemantic = Boolean(deps.embedQuery);
  let mode: SearchMode = input.mode === "auto" ? (canSemantic ? "hybrid" : "keyword") : input.mode;

  if (mode !== "keyword" && !canSemantic) {
    notes.push(`${mode} search is not enabled on this server; used keyword search.`);
    mode = "keyword";
  }
  if (mode === "keyword") {
    return { rows: await keywordSearch(deps.db, query, opts), mode_used: "keyword", notes };
  }
  let vector: number[];
  try {
    vector = await deps.embedQuery!(query);
  } catch (e) {
    if (input.mode === "semantic") throw e;
    logEvent("warn", "semantic_fallback", errorSummary(e));
    notes.push("Semantic search was unavailable; used keyword search.");
    return { rows: await keywordSearch(deps.db, query, opts), mode_used: "keyword", notes };
  }
  const wide = { ...opts, limit: Math.min(opts.limit * 3, 60) };
  if (mode === "semantic") {
    return { rows: (await semanticSearch(deps.db, vector, deps.settings.embeddingModel, opts)), mode_used: "semantic", notes };
  }
  const [kw, sem] = await Promise.all([keywordSearch(deps.db, query, wide), semanticSearch(deps.db, vector, deps.settings.embeddingModel, wide)]);
  if (sem.length === 0) notes.push("No stored embeddings matched the filters; results are keyword-only.");
  return { rows: fuse([kw, sem], opts.limit, opts.perBook), mode_used: sem.length ? "hybrid" : "keyword", notes };
}

export function assertQuery(q: string): string {
  const n = normalizeQuery(q);
  if ([...n].length < 2) throw new AppError("invalid_input", "Query is too short");
  return n;
}
