# mcp-server

Stateless MCP server for Cloudflare Workers: `agents/mcp/server` `createMcpHandler` + `@modelcontextprotocol/server` (`McpServer.registerTool`) + Zod 4, PostgreSQL through Hyperdrive with `pg`. TypeScript strict (TS 7).
Needs **Node ≥ 22** (Wrangler 4); on this machine `nvm use 22`.

```
src/index.ts                    routes: /mcp  /api/chat  /healthz ; auth, rate limit, size cap, CORS
src/mcp/create-server.ts        McpServer factory (per request)
src/mcp/tools/*.ts              one file per tool + registry.ts (shared by MCP and the tutor)
src/mcp/schemas/tool-schemas.ts Zod input schemas
src/database/client.ts          withDb(): fresh pg.Client per operation, always closed, safe errors
src/database/queries/*.ts       parameterised SQL (textbooks, chapters, content)
src/services/                   textbook-search, present (exposure policy), citations, embeddings (Workers AI),
                                groq.ts (reusable client), prompts.ts, tutor.ts, retrieval-port.ts, tutor-factory.ts
src/http/                       chat endpoint, response helpers
src/resources, src/prompts      seba://about resource, answer_from_seba_textbooks prompt
scripts/                        render-config, smoke, check-groq, explore
```

## Develop

```bash
npm ci
cp .env.example .env              # CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE (read-only role) - read by Wrangler itself
cp .dev.vars.example .dev.vars    # MCP_AUTH_TOKEN, GROQ_API_KEY - Worker secrets for local dev
npx wrangler types                # generates worker-configuration.d.ts (git-ignored)
npm run dev                       # http://localhost:8788/mcp   (set ENABLE_GROQ_ANSWERS via --var if needed)
MCP_URL=http://localhost:8788/mcp MCP_TOKEN=$(grep MCP_AUTH_TOKEN .dev.vars | cut -d= -f2) npm run smoke
node scripts/explore.mjs http://localhost:8788/mcp "$TOKEN" search_textbook_content '{"query":"প্ৰতিফলন"}'
```

Create the read-only role first: `psql "$OWNER_URL" -v reader_password=... -f ../database/roles/create_reader.sql`.

## Test

```bash
npm run type-check
npm run test:unit                                  # 47 tests, no database
export TEST_DATABASE_URL=postgresql://owner:...@127.0.0.1:5432/seba_test   # scratch DB with vector + pg_trgm; the suite DROPs schema public
npm test                                           # 101 tests incl. 54 against PostgreSQL via the reader role
```

The integration tests apply the real migration, load fixtures, create a test reader role (`seba_reader_vitest`; roles are cluster-wide so the real role name is never touched),
then drive the Worker's `fetch` with the official MCP client (initialise, list, call every tool, error paths, auth, rate limit, CORS, Groq chat with the Groq network call stubbed, semantic path with a fake `AI` binding).
`npm run check:groq` and `npm run smoke` are for live endpoints and are not part of `npm test`.

## Tools

| Tool | Notes |
|---|---|
| `list_textbooks` | filters: class, subject, medium (incl. "All" books), subject_type, `indexed_only`; cursor pagination |
| `get_textbook_details` | metadata, official URL, status, counts, extraction quality |
| `search_textbooks` | trigram + ILIKE over title/subject |
| `get_chapters` / `get_chapter_content` | page ranges, detection method; size-based pagination |
| `search_textbook_content` | keyword / semantic / hybrid, provenance + citation per passage |
| `get_page_content` | by PDF index or printed number |
| `get_exercises` | heuristic exercise regions + best-effort question split |
| `get_book_pdf_url` | official URL only; never proxied |
| `compare_textbook_topics` | per-book passages for 2–6 books |
| `answer_textbook_question` | optional, Groq; registered only when enabled |

Errors are returned as `isError: true` with `{error:{code,message}}` (`invalid_input`, `not_found`, `unavailable`, `rate_limited`, `disabled`, `upstream_error`, `internal`). Input-schema violations are rejected by the SDK before the handler runs.
