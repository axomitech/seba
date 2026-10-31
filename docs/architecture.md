# Architecture

## Components and boundaries

| | Ingestion engine | MCP server | Groq service |
|---|---|---|---|
| Runs on | your Ubuntu machine / scheduled job | Cloudflare Workers | inside the Worker (optional) |
| Language | Python | TypeScript (strict) | TypeScript |
| DB role | owner (migrations, writes) | `seba_mcp_reader` (SELECT only) | none (receives evidence from a port) |
| Imports | none of the others | queries + services; **not** Groq | no database code |

Dependency direction in `mcp-server/src`: `tools → database/queries`, `services/tutor → services/groq` + a `RetrievalPort` interface.
Only `mcp/tools/answer-textbook-question.ts`, `http/chat.ts` and `services/tutor-factory.ts` know about Groq; the ten retrieval tools
work with Groq disabled or down. `services/retrieval-port.ts` adapts the database to the tutor's port.

## Database

`database/migrations/0001_schema.sql`. Content belongs to a **source file** (a URL), not to a catalogue row, because the official
page lists some PDFs under several rows (IX and X share a file; IX-X books). This is also what prevents duplicate ingestion.

```
languages ─┐
subjects  ─┼─► textbooks ──► textbook_sources ◄── chapters ◄── textbook_pages
           │   (catalogue row,    (URL, status,        │            (text, OCR confidence,
           │    class, medium)     sha256, stage)       └─► textbook_chunks ──► textbook_embeddings
                                                          (FTS tsvector, page range,   (vector(1024), per model)
                                                           body|exercise)
ingestion_logs (per run / stage / source)
```

| Brief's table | Table | Notes |
|---|---|---|
| textbooks | `textbooks` | title, class (`IX`/`X`/`IX-X`), subject, language, `medium_label` as printed, subject type, `source_id`, `catalogue_status` (`listed`/`removed`) |
| subjects, languages | `subjects`, `languages` | `subjects.name_key` normalises case/whitespace/`(E)`/NSQF variants; `languages` includes a pseudo-medium `all` for the catalogue's "All" |
| textbook_sources | `textbook_sources` | original URL (never rewritten), `url_kind`, HTTP validators for incremental updates, `ingest_stage`, `status`, `sha256`, `extraction_summary` |
| chapters | `chapters` | PDF page range, printed number, `detection_method` (`toc`/`heading`) |
| textbook_pages | `textbook_pages` | PDF page index + printed page label, `extraction_method` (`text`/`ocr`/`empty`), OCR confidence |
| textbook_chunks | `textbook_chunks` | page range, `chunk_kind`, generated `tsvector` (`simple` config: no stemming, safe for Assamese) + trigram index |
| textbook_embeddings | `textbook_embeddings` | `(chunk_id, model)` so a model change never touches chunks; HNSW cosine index |
| ingestion_logs | `ingestion_logs` | not readable by the Worker role |

UUID primary keys, FKs everywhere, `created_at`/`updated_at` with a trigger, PDFs never stored in PostgreSQL (only the ingestion machine's
`local_path`, which the Worker role cannot read).

## Retrieval

`search_textbook_content` runs, depending on configuration:

- **keyword**: `websearch_to_tsquery('simple', …)` (question words removed; ≤2 terms AND-ed, otherwise OR-ed and ranked by `ts_rank_cd`) **or** a trigram-indexed `ILIKE` substring match, which also covers Indic scripts where PostgreSQL's tokenizer splits words at vowel signs;
- **semantic**: pgvector cosine distance against `textbook_embeddings` for the query vector from Workers AI (`env.AI`, same model as ingestion);
- **hybrid**: reciprocal-rank fusion of both. `auto` = hybrid if semantic is enabled, else keyword. If the embedding service fails, hybrid silently degrades to keyword and says so in `notes`.

Measured on loopback with 149,500 synthetic chunks (≈ the whole catalogue): selective queries 7–31 ms, a deliberately common-term query 208 ms.
Neon adds network latency; every statement has an 8 s timeout and a 5 s role-level timeout.

## Hyperdrive vs the Neon serverless driver

**Chosen: Cloudflare Hyperdrive + `pg`**, as the brief prefers. Reasons: connection pooling managed at Cloudflare's edge; works with *any* PostgreSQL
(including the local database used for `wrangler dev` and CI via `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE`), so there is one code
path from laptop to production; standard `pg` semantics. The cost is one more Cloudflare resource to create. `@neondatabase/serverless`
(HTTP/WebSocket) would avoid Hyperdrive but ties the code to Neon and gives no local equivalent without extra shims.
All database access sits behind the 8-line `Db` interface in `src/database/client.ts`, so switching is a contained change.
Caching is disabled on the Hyperdrive config (`--caching-disabled`) so freshly ingested content is visible immediately.
Check Cloudflare's current Hyperdrive and Workers plan limits before launch; they were not verifiable offline.

## Security model

| Concern | Control |
|---|---|
| Authentication | Bearer token (`MCP_AUTH_TOKEN` secret), constant-time comparison. **Fails closed**: `AUTH_MODE` must be exactly `none` to be public; if auth is required and no ≥16-char token is configured, every request gets 503. |
| Rate limiting | Workers Rate Limiting binding per client key (token digest, else IP). Approximate and per-location by Cloudflare's design; local fallback window for dev/tests. |
| Input validation | Zod schemas on every tool (UUID ids, bounded integers, enums, length limits); cursor decoding is strictly validated; 64 KiB request cap enforced on bytes actually read; 16 KiB for chat. |
| SQL injection | Caller data only ever reaches the database as bind parameters (`$n`); LIKE wildcards escaped; no table/column/SQL parameters exist. Covered by tests with injection payloads. |
| Least privilege | Reader role: `SELECT` on content tables and non-sensitive columns of `textbook_sources`; no write, no `ingestion_logs`, no `local_path`; `default_transaction_read_only=on`. |
| SSRF | The Worker never fetches caller-supplied URLs (only the fixed Groq base URL from config). The ingestion downloader: https only, host allowlist (`sebaonline.org` and subdomains), all resolved IPs must be global, every redirect hop re-checked, size cap, timeouts. Caveat: resolution happens before connect, so DNS rebinding between check and connect is not fully excluded. |
| Error handling | Only `AppError` messages reach clients; everything else is `internal` with a generic message. Driver errors (which can contain hosts/users) are logged by class and code only. |
| Secrets | `GROQ_API_KEY`, `MCP_AUTH_TOKEN` are Worker secrets; DB credentials live in Hyperdrive; `.env`, `.dev.vars` are git-ignored; log fields matching `key|token|secret|password|url|…` are dropped. |
| Prompt injection | Retrieved text is delimited as data, the system prompt says to ignore instructions inside it, model-chosen tool arguments are re-validated with the same Zod schemas, and `[S#]` citations are validated against what was retrieved. |
| CORS | No CORS headers unless the request `Origin` is listed in `ALLOWED_ORIGINS`. Non-browser MCP clients are unaffected. |
| MCP is read-only | Tool annotations declare `readOnlyHint`; no ingestion, upload or SQL tools exist. |

## Groq integration

Verified against Groq's documentation at implementation time:

- Models (production): `llama-3.1-8b-instant`, `llama-3.3-70b-versatile`, `openai/gpt-oss-120b`, `openai/gpt-oss-20b`; the tool-use table lists all of them with local tool use, parallel tool use only for the Llama models. `GROQ_MODEL` is configuration (default `llama-3.3-70b-versatile`), and `npm run check:groq` confirms the model exists for *your* key and that tool calling and Assamese output work.
- **Local tool calling** via `/chat/completions` (`tools`, `tool_calls`, `role: tool`) is the supported default: `/api/chat` with `"mode":"agentic"` lets the model call the same validated tool handlers the MCP server exposes (in-process, no network hop), with fallback to the deterministic pipeline if a model cannot do tool calling.
- **Remote MCP** exists in beta via the Responses API (`tools:[{type:"mcp", server_url, headers,…}]`, HTTPS only, supported models incl. the four above). `GroqService.respondWithRemoteMcp` implements the documented request; it needs a publicly reachable HTTPS `/mcp` and passes the bearer token in `headers`. It is implemented and unit-tested at the request level but not used by default, because retrieval-then-generate gives deterministic citations.
- Tasks: grounded answer, chapter summary, concept explanation, practice questions, MCQs, step-by-step maths; `response_language` = `auto` | `english` | `assamese`.
- Citations: the model cites `[S1]…`; application code removes unknown handles and appends the "Sources" list from database metadata.

## Copyright and content exposure

The textbooks are SEBA/ASSEB publications. This project stores extracted text locally and in your database, keeps the official URL on every result and never proxies or mirrors PDFs.
Whether you may *serve* extracted text publicly is a legal question this repository cannot answer. Therefore `CONTENT_EXPOSURE` defaults to **`excerpt`**
(passages truncated to `EXCERPT_CHARS`, questions not split, Groq asked to paraphrase), and `AUTH_MODE` defaults to `required`.
Switch to `full` only after you have confirmed the permission (for a private, authenticated deployment for your own tutor this may be appropriate; confirm with SEBA/ASSEB).
The downloader does not bypass any access control: a 403 directory page is recorded as unavailable, and a polite 1 s delay and a descriptive User-Agent are used. No `robots.txt` exists on the SEBA hosts (404).
