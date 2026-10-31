# Ingestion guide (Ubuntu 24.04)

The ingestion engine is a separate local process. It needs: Python ≥ 3.10, Tesseract, PostgreSQL with pgvector, and outbound HTTPS to `*.sebaonline.org`.

## 1. Install

```bash
sudo apt update
sudo apt install -y python3-pip python3-venv tesseract-ocr tesseract-ocr-asm tesseract-ocr-ben tesseract-ocr-hin postgresql-client
tesseract --list-langs          # expect: asm ben eng hin ...
cd ingestion-engine
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
export PYTHONPATH=src           # or: pip install -e .   (provides the `seba-ingest` command)
```

Language packs: the `languages` seeder maps each medium to Tesseract packs (Assamese → `asm+eng`, Bengali/Manipuri → `ben+eng`, Hindi/Bodo/Nepali/Sanskrit → `hin+eng`, others `eng`).
Missing packs fall back to the ones installed, with a warning.

## 2. Database

Any PostgreSQL ≥ 14 with the `vector` extension (Neon supports it). Use an **owner** role here; the Worker gets a separate read-only role (see the [deployment guide](deployment-guide.md)).

```bash
# local example
sudo -u postgres psql -c "CREATE ROLE seba_owner LOGIN PASSWORD '<strong password>'" -c "CREATE DATABASE seba_textbooks OWNER seba_owner"
sudo -u postgres psql -d seba_textbooks -c "CREATE EXTENSION vector" -c "CREATE EXTENSION pg_trgm"   # needs the postgresql-16-pgvector package

cp .env.example .env     # edit DATABASE_URL=postgresql://seba_owner:...@127.0.0.1:5432/seba_textbooks
python -m seba_ingest migrate    # applies database/migrations/*.sql, tracked in schema_migrations
python -m seba_ingest seed       # languages (idempotent)
```

If an existing database already has these tables, review `database/migrations/0001_schema.sql` against it first; the migration creates (not alters) tables.

## 3. Discover, then ingest

```bash
python -m seba_ingest discover --dry-run | head     # parse the live catalogue, touch nothing
python -m seba_ingest discover                      # upsert textbooks + sources (idempotent; removed rows are flagged, not deleted)
python -m seba_ingest list --medium assamese --class IX
```

`discover` follows the catalogue page's iframe to `https://www.sebaonline.org/textbooks/textbooks.htm` and reads the table by **header names**, not column positions
(`discovery/seba_table.py`). If the site is redesigned, add an adapter class to `ADAPTERS`; if it returns no rows the run aborts without touching the database.

```bash
python -m seba_ingest ingest --id 120               # one book: serial (Sl. No.), UUID or title fragment
python -m seba_ingest ingest --id 120 --max-pages 10   # trial run; does not advance the persisted stage
python -m seba_ingest ingest --medium assamese --class IX --limit 5
python -m seba_ingest ingest --all                  # every PDF textbook (shared PDFs processed once)
python -m seba_ingest status                        # row counts, sources by status
python -m seba_ingest logs 120                      # recent ingestion_logs for the book
```

Exit code is non-zero if any selected book failed; other books are still processed.

### Verify the inserted records

```bash
psql "$DATABASE_URL" -c "select t.catalogue_serial, t.title, t.class_label, src.status, src.page_count,
  (select count(*) from chapters c where c.source_id=src.id) chapters,
  (select count(*) from textbook_chunks k where k.source_id=src.id) chunks
  from textbooks t join textbook_sources src on src.id=t.source_id where src.status='indexed' order by 1"
psql "$DATABASE_URL" -c "select extraction_method, count(*), round(avg(ocr_confidence)::numeric,1) from textbook_pages group by 1"
```

## 4. Stages, resume, incremental updates

Each source moves `pending → downloaded → extracted → chunked → embedded → done` (`textbook_sources.ingest_stage`). Every stage is idempotent, so just run the same command again after a crash or Ctrl-C:

| Interruption | What happens on re-run |
|---|---|
| download cut off | the `.part` file is resumed with an HTTP `Range` request |
| mid-extraction | extraction continues after the last contiguous stored page (pages are committed in batches of 25) |
| mid-embedding | only chunks without a vector for the configured model are embedded |
| book unchanged upstream | a conditional GET (`If-None-Match` / `If-Modified-Since`) returns 304; nothing is redone |
| book changed upstream | new `sha256` detected → old pages/chapters/chunks/embeddings are replaced |

Other commands:

```bash
python -m seba_ingest ingest --all --retry-failed   # only sources whose last attempt failed
python -m seba_ingest reprocess --id 120            # force re-extraction + re-chunk + re-embed (re-OCRs)
python -m seba_ingest reprocess --id 120 --redownload
python -m seba_ingest rechunk --all                 # keep stored pages; redo chapters/chunks (after changing the parser or chunk size)
python -m seba_ingest ingest --all --no-ocr         # skip OCR (scanned/legacy-font pages stay empty or garbled)
```

Scheduled refresh (weekly) with cron or a systemd timer: `discover && ingest --all` — unchanged books cost one conditional request each (1 s politeness delay).

## 5. Embeddings (optional, for semantic search)

Default is `EMBEDDING_PROVIDER=none` (keyword search only). Groq has no embedding API and is not an option here. Choose a **1024-dimension** model:

| Provider | Settings | Notes |
|---|---|---|
| `cloudflare` | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` (Workers AI), `EMBEDDING_MODEL=@cf/baai/bge-m3` | Same model the Worker uses for the query vector. **Not tested live** here. |
| `ollama` | `EMBEDDING_BASE_URL=http://127.0.0.1:11434`, `EMBEDDING_MODEL=bge-m3` | Local; vectors only comparable if the Worker also embeds with bge-m3. |
| `openai` | `EMBEDDING_BASE_URL`, `EMBEDDING_API_KEY`, `EMBEDDING_MODEL` | Any OpenAI-compatible endpoint returning 1024-d vectors. |

The query vector in the Worker and the stored vectors **must come from the same model**. To change models: set the new `EMBEDDING_MODEL` and run `ingest --all` (embeds the missing ones, keyed by model),
then `DELETE FROM textbook_embeddings WHERE model = '<old>'` and update the Worker's `EMBEDDING_MODEL`.

## 6. What to expect (measured on this repository's test run)

- Sample book "Saral Asomiya Sahitya" (73 pages, legacy-font Assamese): 71 pages needed OCR, ≈ 2.5 minutes with 2 OCR workers (`ocr_workers`), mean word confidence ≈ 90 %. Pages with only decorative content stay `empty`.
- OCR is CPU-bound; a full run over all 227 PDFs was **not** performed. Budget hours, run it under `tmux`/systemd, and rely on resume.
- Output of OCR on Assamese is good but not perfect (conjuncts, punctuation, headers/footers are included in the page text). Check `ocr_confidence` and the `extraction_summary.pages_by_method` per book.
- Heading-based chapter detection is incomplete on literature readers (see `extraction_summary.chapter_quality`).

## 7. Maintenance

| Task | How |
|---|---|
| Update the catalogue | `discover` (new rows added, vanished rows flagged `catalogue_status='removed'`; a truncated page cannot mass-flag — needs ≥ 50 % of existing rows) |
| Re-run a changed PDF | `ingest --id …` (conditional GET) or `reprocess --id … --redownload` |
| Superseded/removed PDFs | rows flagged `removed` disappear from the Worker's tools; delete content with `DELETE FROM textbook_sources WHERE id = …` (cascades) |
| Rebuild embeddings | section 5 |
| Rotate database credentials | change `DATABASE_URL`; for the Worker see the deployment guide |
| SEBA certificate chain | `ingestion-engine/certs/sectigo-dv-r36-intermediate.pem` (expires 2036). Replace if SEBA changes CA; override with `SEBA_EXTRA_CA_FILES`. TLS verification is never disabled. |

## 8. Tests

```bash
export TEST_DATABASE_URL=postgresql://seba_owner:...@127.0.0.1:5432/seba_test   # an empty scratch database with vector + pg_trgm; the test DROPs schema public
python -m pytest -q          # 85 tests; DB tests are skipped when TEST_DATABASE_URL is unset
```

Sample data: `tests/fixtures/seba_catalogue_*.html` are real rows from the live catalogue (including the irregular ones); PDFs are generated by the tests with PyMuPDF.
A small end-to-end sample is `scripts/sample_workflow.sh`.
