# Deployment guide (Neon + Hyperdrive + Cloudflare Workers + Groq)

> **Nothing in this repository has been deployed.** The code is tested locally on the real `workerd` runtime; the steps below need *your* Cloudflare, Neon, Groq and GitHub accounts.
> Every command here is syntax-checked against the installed Wrangler 4.156, but the account-side steps (creating Hyperdrive, `wrangler deploy`, secrets) have not been run.

## Checklist: what only you can provide

| # | Item | Where it goes |
|---|---|---|
| 1 | Neon project + database with `vector` extension; **owner** connection string (direct, non-pooled) | `ingestion-engine/.env` → `DATABASE_URL` |
| 2 | A strong password for the read-only role `seba_mcp_reader` | `database/roles/create_reader.sql`, then Hyperdrive |
| 3 | Cloudflare account; `npx wrangler login` | local; CI uses an API token |
| 4 | Hyperdrive configuration ID | `HYPERDRIVE_ID` (env / GitHub variable), never committed |
| 5 | `MCP_AUTH_TOKEN` (you generate it: `openssl rand -hex 32`) | Worker secret; GitHub secret for the smoke test |
| 6 | Groq API key (optional) | Worker secret `GROQ_API_KEY` |
| 7 | GitHub repository; `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | GitHub Actions secrets (only if using the workflow) |
| 8 | Written permission/decision on serving full textbook text | `CONTENT_EXPOSURE` (default `excerpt`) |

## 1. Neon database

1. Create a Neon project and a database (e.g. `seba_textbooks`). Pick a region near your Cloudflare traffic and your ingestion machine.
2. Copy the **direct** connection string (not the `-pooler` host). Hyperdrive does its own pooling and Cloudflare's guidance is to give it the direct string. Keep `?sslmode=require`.
3. Enable the extensions as the owner: `psql "$OWNER_URL" -c 'CREATE EXTENSION IF NOT EXISTS vector' -c 'CREATE EXTENSION IF NOT EXISTS pg_trgm'` (the migration also does this).

## 2. Load data (from your Ubuntu machine)

```bash
cd ingestion-engine && source .venv/bin/activate && export PYTHONPATH=src
# .env: DATABASE_URL=<owner string from Neon>
python -m seba_ingest migrate && python -m seba_ingest seed
python -m seba_ingest discover
python -m seba_ingest ingest --id 120      # then more books; see docs/ingestion-guide.md
```

## 3. Read-only role for the Worker

```bash
READER_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=')"
psql "$OWNER_URL" -v ON_ERROR_STOP=1 -v reader_password="$READER_PASSWORD" -f database/roles/create_reader.sql
echo "postgresql://seba_mcp_reader:${READER_PASSWORD}@<neon-direct-host>/seba_textbooks?sslmode=require"   # keep private
```

The role has `SELECT` only on content tables (and non-sensitive columns of `textbook_sources`), `default_transaction_read_only=on`, and a 5 s `statement_timeout`.
Re-run the script after adding tables so grants stay current. Use a separate password from the owner's.

## 4. Hyperdrive

```bash
cd mcp-server && source ~/.nvm/nvm.sh && nvm use 22 && npm ci
npx wrangler login
npx wrangler hyperdrive create seba-textbook-db \
  --connection-string="postgresql://seba_mcp_reader:...@<neon-direct-host>/seba_textbooks?sslmode=require" \
  --caching-disabled
# prints: id = <32 hex characters>   -> this is HYPERDRIVE_ID
```

Do not paste the connection string into issues, commits or shared shells. Rotating the password later: `npx wrangler hyperdrive update <id> --connection-string=...`.

## 5. Configure

`wrangler.jsonc` holds non-secret settings. Review these vars before the first deploy:

| Var | Default | Meaning |
|---|---|---|
| `AUTH_MODE` | `required` | `required` = bearer token on `/mcp` and `/api/chat` (fail-closed). `none` = public read-only. |
| `CONTENT_EXPOSURE` | `excerpt` | `excerpt` truncates text to `EXCERPT_CHARS`; `full` returns whole pages/chapters. Change only after permission is confirmed. |
| `ALLOWED_ORIGINS` | `""` | Comma-separated browser origins for CORS. |
| `ENABLE_GROQ_ANSWERS` | `false` | Needs `GROQ_API_KEY` secret too. |
| `GROQ_MODEL` | `llama-3.3-70b-versatile` | Verify with `npm run check:groq`. |
| `EMBEDDINGS_ENABLED` | `false` | Needs the `ai` binding and embeddings in the database (section 10). |

`ratelimits[0].namespace_id` must be unique within your Cloudflare account; the default `41001` is arbitrary. Limit: 60 requests / 60 s per client key / location.

## 6. Deploy

```bash
export HYPERDRIVE_ID=<id from step 4>
npm run type-check && npm test        # tests need TEST_DATABASE_URL for the DB suites (see mcp-server/README.md)
npm run deploy                         # renders wrangler.deploy.jsonc (gitignored) and runs wrangler deploy
```

Wrangler prints `https://seba-textbook-mcp.<account-subdomain>.workers.dev`. The MCP endpoint is that URL + `/mcp`.

## 7. Secrets

```bash
openssl rand -hex 32                          # generate; store in your password manager
npx wrangler secret put MCP_AUTH_TOKEN -c wrangler.deploy.jsonc
npx wrangler secret put GROQ_API_KEY -c wrangler.deploy.jsonc    # only if enabling Groq
```

Until `MCP_AUTH_TOKEN` exists, `/mcp` answers **503** (fail-closed) rather than serving anonymously.

## 8. Verify

```bash
curl -s https://<worker>.workers.dev/healthz                                   # {"status":"ok",...}
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<worker>.workers.dev/mcp   # 401 without token
MCP_URL=https://<worker>.workers.dev/mcp MCP_TOKEN=<token> npm run smoke       # initialise, list, call tools
```

Opening `/mcp` in a browser is not a valid test; it speaks MCP over POST. Use the Inspector:

```bash
npx @modelcontextprotocol/inspector@latest
```

Choose transport **Streamable HTTP**, URL `https://<worker>.workers.dev/mcp`, add header `Authorization: Bearer <token>`, Connect → Tools → List Tools, then call `list_textbooks` (`indexed_only: true`), `search_textbook_content`, `get_page_content`.
Confirm results come from your database (titles/pages you ingested) and carry `citation` and `source_pdf_url`. Check Workers → Logs for `tool_call` lines (no query text is logged).

## 9. GitHub Actions

`.github/workflows/ci-deploy.yml` runs both test suites against a pgvector Postgres service on every PR/push, and deploys from `main` only.

1. Push the repository to GitHub; protect `main` (require PRs and the `ingestion-engine` and `mcp-server` checks).
2. Repository **secrets**: `CLOUDFLARE_API_TOKEN` (create from the "Edit Cloudflare Workers" template and add Hyperdrive/Workers permissions needed for deploy), `CLOUDFLARE_ACCOUNT_ID`, `MCP_AUTH_TOKEN` (only for the post-deploy smoke test).
3. Repository **variables**: `HYPERDRIVE_ID`, `MCP_URL` (e.g. `https://seba-textbook-mcp.<sub>.workers.dev/mcp`).
4. Create a GitHub **environment** named `production` (add required reviewers if you want manual approval).
5. Worker runtime secrets (`MCP_AUTH_TOKEN`, `GROQ_API_KEY`) are set once with `wrangler secret put`; the workflow deliberately never handles them.

Alternative: Cloudflare's Git integration (Workers → Settings → Builds). Build command `npm ci && npx wrangler types`, deploy command `node scripts/render-config.mjs && npx wrangler deploy -c wrangler.deploy.jsonc`, root directory `mcp-server`, build variable `HYPERDRIVE_ID`.
The workflow file has been YAML-parsed but not executed.

## 10. Optional: Groq

1. Create a key at <https://console.groq.com/keys>.
2. `cd mcp-server && GROQ_API_KEY=... GROQ_MODEL=llama-3.3-70b-versatile npm run check:groq` → verifies the key, that the model exists for your account, that tool calling returns a `tool_call`, and that an Assamese prompt yields Assamese script. Change `GROQ_MODEL` if a check fails (not all models behave the same).
3. Set `"ENABLE_GROQ_ANSWERS": "true"` in `wrangler.jsonc`, `npx wrangler secret put GROQ_API_KEY`, redeploy. `answer_textbook_question` now appears in `tools/list`.
4. Test grounded answers:

```bash
curl -s https://<worker>.workers.dev/api/chat -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"message":"What are the laws of reflection?","class":"IX","medium":"English","response_language":"english"}'
curl -s https://<worker>.workers.dev/api/chat -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"message":"পোহৰৰ প্ৰতিফলন কি?","task":"explain","response_language":"assamese"}'
```

Body fields: `message`, `task` (`answer`|`summarize_chapter`|`explain`|`practice_questions`|`mcq`|`math_steps`), `class`, `subject`, `medium`, `textbook_id`, `chapter_id` (required for `summarize_chapter`),
`response_language` (`auto`|`english`|`assamese`), `mode` (`grounded` default | `agentic` = model calls the retrieval tools). The response has `answer`, `grounded`, `sources[]` (built from database metadata), `dropped_citations[]`.
A question with no relevant indexed passages returns a fixed "not found in the textbooks" message **without calling Groq**.

## 11. Optional: semantic search

1. Ingest with a 1024-d model, ideally Workers AI bge-m3: `EMBEDDING_PROVIDER=cloudflare` + `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` (Workers AI) in `ingestion-engine/.env`, then `ingest --all` (embeds missing chunks).
2. Add to `wrangler.jsonc`: `"ai": { "binding": "AI" }` and set `"EMBEDDINGS_ENABLED": "true"` (`EMBEDDING_MODEL` must equal the ingestion model). Note `wrangler dev` runs AI bindings remotely and needs a login.
3. `search_textbook_content` with `mode: "auto"` becomes hybrid. Untested against the live Workers AI service; the first call will reveal any response-shape mismatch (reported as "Semantic search is temporarily unavailable" and logged as `query_embedding_failed`; keyword search keeps working).

## 12. Operations

| Task | Command |
|---|---|
| Live logs | `npx wrangler tail seba-textbook-mcp` |
| Roll back a bad deploy | `npx wrangler rollback [version-id]` |
| Rotate `MCP_AUTH_TOKEN` | `npx wrangler secret put MCP_AUTH_TOKEN` (clients must update) |
| Rotate DB password | `ALTER ROLE seba_mcp_reader PASSWORD '...'` then `npx wrangler hyperdrive update <id> --connection-string=...` |
| Rotate Groq key | create new key at Groq, `npx wrangler secret put GROQ_API_KEY`, delete old key |
| Change Groq model | edit `GROQ_MODEL`, `npm run check:groq`, redeploy |
| New textbooks / changed PDFs | rerun `discover` + `ingest --all` on the ingestion machine; no Worker redeploy needed |
| Custom domain | add a route in the Cloudflare dashboard; `createMcpHandler` only auto-restricts `Host` for `workers.dev`/localhost, so rely on your zone's access rules or set `allowedHostnames` in `src/index.ts` |

Free-tier notes (check Cloudflare's current limits page): 10 ms CPU per request is for Worker CPU, not time waiting on PostgreSQL/Groq. The bundle is 1.5 MiB (275 KiB gzipped).
A tool call opens one pooled-by-Hyperdrive connection per database operation; heavy work (OCR, PDF parsing, embedding of books) never runs in the Worker.
