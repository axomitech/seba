# ingestion-engine

Local pipeline that turns the official SEBA textbook catalogue into a searchable PostgreSQL + pgvector index. Full guide: [../docs/ingestion-guide.md](../docs/ingestion-guide.md).

```
src/seba_ingest/
  discovery/        seba_table.py (header-driven adapter, follows the catalogue iframe), normalize.py, models.py
  downloader/       safe_http.py (https/allowlist/SSRF/redirect checks), download.py (resume, conditional GET, validation)
  extraction/       pdf.py (PyMuPDF; legacy-font detection; OCR fallback; printed page numbers)
  ocr/              tesseract.py (CLI, TSV confidence)
  chapter_parser/   parser.py (PDF outline → heading heuristics; never invents chapters)
  chunking/         chunker.py (page/chapter aware, exercise detection)
  embeddings/       providers.py (none | cloudflare | openai | ollama; 1024-d)
  database/         db.py (migrations, seeders, repository)
  pipeline.py       stages + resume;  cli.py  `seba-ingest`
```

Commands: `migrate`, `seed`, `discover [--dry-run]`, `list`, `ingest`, `reprocess`, `rechunk`, `status`, `logs`. Selection: `--id <serial|uuid|title>`, `--all`, `--class`, `--medium`, `--subject`, `--limit`, `--retry-failed`.

```bash
pip install -r requirements.txt && export PYTHONPATH=src
python -m seba_ingest migrate && python -m seba_ingest seed && python -m seba_ingest discover
python -m seba_ingest ingest --id 120
export TEST_DATABASE_URL=...scratch db... && python -m pytest -q    # 85 tests (DB tests skip without the variable)
```
