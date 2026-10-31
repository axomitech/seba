# SEBA Textbook MCP

Read-only [Model Context Protocol](https://modelcontextprotocol.io) server over the official Class IX–X textbooks of the
Board of Secondary Education, Assam (SEBA / ASSEB Division-I), plus the local pipeline that builds the index.
Catalogue: <https://site.sebaonline.org/textbook>.

```
 SEBA catalogue ──► ingestion-engine (Python, Ubuntu)            mcp-server (TypeScript, Cloudflare Workers)
 site.sebaonline.org   discover → download → validate → extract      /mcp  Streamable HTTP, 10 read-only tools
                       → OCR → chapters → chunks → embeddings   ──►  /api/chat  optional Groq tutor (en/as)
                                   │                                  /healthz
                                   ▼                                       ▲
                       PostgreSQL + pgvector (Neon) ◄── Hyperdrive ────────┘   Groq = LLM only, never in retrieval
```

| Directory | What it is |
|---|---|
| [ingestion-engine/](ingestion-engine/README.md) | Python 3.10+ CLI `seba-ingest`: discovery adapters, safe downloader, PyMuPDF + Tesseract extraction, chapter parser, chunker, embedding providers, PostgreSQL repository. Runs locally, never in a Worker. |
| [mcp-server/](mcp-server/README.md) | Cloudflare Worker: MCP tools, Groq service, auth, rate limiting, Hyperdrive/`pg` access. |
| [database/](database/) | `migrations/` (schema), `seeders/` (languages), `roles/` (read-only Worker role). |
| [docs/](docs/) | [architecture](docs/architecture.md) · [ingestion guide](docs/ingestion-guide.md) · [deployment guide](docs/deployment-guide.md) · [MCP client configuration](docs/mcp-client-configuration.md) |
| [.github/workflows/](.github/workflows/ci-deploy.yml) | CI (both test suites) and deploy-on-`main`. |

## Status: what is verified and what is not

Verified by actually running it on this machine (Ubuntu 24.04, Node 22, Python 3.12, PostgreSQL 16 + pgvector 0.8.7):

- **Live discovery** of the official catalogue: 245 unique rows (227 PDF, 16 `.rar`, 1 web-page link, 1 row with no link). Re-running is idempotent.
- **Live ingestion** of 3 real SEBA books (Assamese medium, 274 pages, 599 chunks), including OCR of legacy-font pages. See [limitations](#known-limitations).
- **85 Python tests** (real PyMuPDF, real Tesseract, real PostgreSQL/pgvector) and **101 TypeScript tests** (real PostgreSQL through the least-privilege reader role, real MCP client over the Worker's `fetch`) pass.
- The Worker **runs on the real `workerd` runtime** (`wrangler dev`), serves `/mcp`, and a smoke test passes against real ingested data. `wrangler deploy --dry-run` bundles it (1.5 MiB / 275 KiB gzip).

**Not done / not verified** (needs credentials or an account only the owner has):

- **Not deployed.** No Cloudflare, Neon, Hyperdrive or GitHub access was available. Nothing here claims a live URL. Follow the [deployment guide](docs/deployment-guide.md).
- **Groq has not been called live** (no API key). The client is unit-tested against Groq's documented request/response shapes with a fake `fetch`; run `npm run check:groq` with your key to verify the model, tool calling and Assamese output.
- **Workers AI / semantic search is untested against the real service.** The vector path is tested with a deterministic fake embedding binding and real pgvector queries. Cloudflare's documentation did not specify the bge-m3 response schema, so the client validates shape and the 1024 dimension at runtime.
- **The GitHub Actions workflow has only been YAML-validated**, not run.
- **Only 3 of 227 PDFs are ingested.** Full ingestion is a multi-hour OCR job; see the [ingestion guide](docs/ingestion-guide.md).

## Quick start (local)

```bash
# 1. database (any PostgreSQL 14+ with pgvector; Neon works)
cd ingestion-engine && cp .env.example .env     # set DATABASE_URL (owner role)
pip install -r requirements.txt && sudo apt install tesseract-ocr tesseract-ocr-asm tesseract-ocr-ben tesseract-ocr-hin
export PYTHONPATH=src
python -m seba_ingest migrate && python -m seba_ingest seed
python -m seba_ingest discover                  # reads the official catalogue
python -m seba_ingest ingest --id 120 --max-pages 10   # one book, trial run (serial 120 = Saral Asomiya Sahitya)

# 2. MCP server
cd ../mcp-server && source ~/.nvm/nvm.sh && nvm use 22 && npm ci
cp .env.example .env && cp .dev.vars.example .dev.vars    # reader DSN + MCP_AUTH_TOKEN
npm run dev                                               # http://localhost:8788/mcp
MCP_URL=http://localhost:8788/mcp MCP_TOKEN=... npm run smoke
```

Full steps (Neon, Hyperdrive, secrets, deploy, Inspector, clients) are in [docs/](docs/).

## Tools

`list_textbooks` · `get_textbook_details` · `search_textbooks` · `get_chapters` · `get_chapter_content` · `search_textbook_content` ·
`get_page_content` · `get_exercises` · `get_book_pdf_url` · `compare_textbook_topics` — plus the optional Groq-backed
`answer_textbook_question` (registered only when `ENABLE_GROQ_ANSWERS=true` and `GROQ_API_KEY` is set). Every passage carries
textbook, class, subject, medium, chapter, PDF page, printed page (when known), a deterministic `citation` string and the official PDF URL.

## Known limitations

- **Legacy fonts.** Many Assamese/Bengali/Bodo PDFs have an embedded text layer in 8-bit legacy fonts (e.g. `¸1˘ ’¸˜œ˚˛±`). The extractor detects this and OCRs those pages (`asm+eng`, ~90 % mean word confidence on the sample), so OCR errors occur; quality is exposed as `extraction.method` / `ocr_confidence`.
- **Chapters are heuristic.** PDF outlines were absent or only held file names in all 3 sample books. Heading detection found 6 lessons (numbered 2, 5, 6, 8, 9, 11) in one book and missed the rest, and found none in the other two; this is surfaced as `chapter_quality` and an empty list is returned rather than guesses.
- **Exercises** are detected from headings (`Exercise`, `অনুশীলনী`, `प्रश्नावली` …) and the question split is best-effort.
- **16 catalogue entries are `.rar` PageMaker archives** and cannot be indexed; one row links to a 403 directory page and one has no link. They stay listed with an explicit `content_status`.
- **SEBA's TLS chain is incomplete** (the server omits the Sectigo intermediate). The public intermediate is shipped in `ingestion-engine/certs/` and added to the trust store; verification is never disabled. If the site changes certificate authority, replace it.
- `academic_session` is part of the brief but the catalogue does not publish it, so it is always `null`.
- Embeddings are fixed at **1024 dimensions** (bge-m3). Other sizes need a migration.
- Public redistribution of textbook text is **off by default** (`CONTENT_EXPOSURE=excerpt`). See [copyright](docs/architecture.md#copyright-and-content-exposure).
- The Worker compatibility date is `2026-10-30`, one day earlier than the brief's date, because the installed `workerd` rejects newer dates.
# seba
# seba
# seba
