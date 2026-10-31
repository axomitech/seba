#!/usr/bin/env bash
# Small end-to-end sample: migrate, seed, discover, ingest ONE small real book (first 15 pages), show the result.
# Requires DATABASE_URL (in .env or the environment) pointing at a database where you may create tables.
set -euo pipefail
cd "$(dirname "$0")/.."
export PYTHONPATH=src
python3 -m seba_ingest migrate
python3 -m seba_ingest seed
python3 -m seba_ingest discover
python3 -m seba_ingest list --id 120               # serial 120 = Saral Asomiya Sahitya (1.8 MB, Assamese)
python3 -m seba_ingest ingest --id 120 --max-pages 15
python3 -m seba_ingest status
python3 -m seba_ingest logs 120 -n 8
echo "Now run the rest of the book:  python3 -m seba_ingest ingest --id 120"
