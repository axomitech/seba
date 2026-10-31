"""PostgreSQL access: migrations, seeders and the repository used by the pipeline."""
from __future__ import annotations

import json
import logging
import uuid
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterable, Iterator, Sequence

import psycopg2
import psycopg2.extras

from ..discovery.models import CatalogueEntry
from ..discovery.normalize import catalogue_key, language_code, subject_key

log = logging.getLogger(__name__)
psycopg2.extras.register_uuid()


def connect(dsn: str):
    if not dsn:
        raise RuntimeError("DATABASE_URL is not set")
    return psycopg2.connect(dsn)


@contextmanager
def transaction(conn) -> Iterator[Any]:
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    try:
        yield cur
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        cur.close()


def _sql_files(directory: Path) -> list[Path]:
    return sorted(p for p in directory.glob("*.sql"))


def migrate(conn, migrations_dir: Path) -> list[str]:
    """Apply pending migrations in filename order. Each file runs in its own transaction."""
    applied_now: list[str] = []
    with transaction(conn) as cur:
        cur.execute("""CREATE TABLE IF NOT EXISTS schema_migrations (
                         filename text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())""")
        cur.execute("SELECT filename FROM schema_migrations")
        done = {r["filename"] for r in cur.fetchall()}
    for path in _sql_files(migrations_dir):
        if path.name in done:
            continue
        log.info("applying migration %s", path.name)
        with transaction(conn) as cur:
            cur.execute(path.read_text(encoding="utf8"))
            cur.execute("INSERT INTO schema_migrations (filename) VALUES (%s)", (path.name,))
        applied_now.append(path.name)
    return applied_now


def seed(conn, seeders_dir: Path) -> list[str]:
    """Seeders are idempotent (ON CONFLICT DO NOTHING) and re-run safely."""
    ran = []
    for path in _sql_files(seeders_dir):
        with transaction(conn) as cur:
            cur.execute(path.read_text(encoding="utf8"))
        ran.append(path.name)
    return ran


class Repository:
    def __init__(self, conn, log_conn=None):
        self.conn = conn
        # logs go through a separate autocommit connection so they survive rollbacks
        self.log_conn = log_conn or conn

    # ---- ingestion logging -------------------------------------------------------------------
    def log(self, run_id: uuid.UUID, stage: str, message: str, *, level: str = "info",
            source_id=None, textbook_id=None, details: dict | None = None) -> None:
        try:
            with self.log_conn.cursor() as cur:
                cur.execute(
                    """INSERT INTO ingestion_logs (run_id, source_id, textbook_id, stage, level, message, details)
                       VALUES (%s,%s,%s,%s,%s,%s,%s)""",
                    (run_id, source_id, textbook_id, stage, level, message[:2000], json.dumps(details or {})))
            if self.log_conn is not self.conn:
                self.log_conn.commit()
        except Exception:  # logging must never break ingestion
            log.exception("could not write ingestion log")
            if self.log_conn is not self.conn:
                self.log_conn.rollback()

    # ---- catalogue ---------------------------------------------------------------------------
    def upsert_catalogue(self, entries: Sequence[CatalogueEntry]) -> dict[str, int]:
        stats = {"new": 0, "updated": 0, "sources": 0, "removed": 0}
        seen_keys: list[str] = []
        with transaction(self.conn) as cur:
            for e in entries:
                lang_code = language_code(e.medium)
                cur.execute("""INSERT INTO languages (code, name) VALUES (%s, %s)
                               ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code RETURNING id""",
                            (lang_code, e.medium.title() if e.medium.isupper() else e.medium))
                language_id = cur.fetchone()["id"]
                cur.execute("""INSERT INTO subjects (name_key, name) VALUES (%s, %s)
                               ON CONFLICT (name_key) DO UPDATE SET name_key = EXCLUDED.name_key RETURNING id""",
                            (subject_key(e.subject), e.subject))
                subject_id = cur.fetchone()["id"]
                source_id = None
                if e.url:
                    status = {"pdf": "discovered", "archive": "unsupported", "html": "unavailable",
                              "other": "unsupported"}[e.url_kind]
                    cur.execute("""INSERT INTO textbook_sources (url, url_kind, status, discovered_from)
                                   VALUES (%s,%s,%s,%s)
                                   ON CONFLICT (url) DO UPDATE SET discovered_from = EXCLUDED.discovered_from
                                   RETURNING id, (xmax = 0) AS inserted""",
                                (e.url, e.url_kind, status, e.discovered_from))
                    row = cur.fetchone()
                    source_id = row["id"]
                    stats["sources"] += int(row["inserted"])
                key = catalogue_key(e.title, e.class_label, e.medium, e.subject, e.subject_type, e.url)
                seen_keys.append(key)
                gmin, gmax = e.grade_range
                cur.execute("""INSERT INTO textbooks (catalogue_key, catalogue_serial, title, class_label, grade_min,
                                   grade_max, subject_id, language_id, medium_label, subject_type, source_id)
                               VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                               ON CONFLICT (catalogue_key) DO UPDATE SET
                                   catalogue_serial = EXCLUDED.catalogue_serial,
                                   catalogue_status = 'listed', source_id = EXCLUDED.source_id
                               RETURNING (xmax = 0) AS inserted""",
                            (key, e.serial, e.title, e.class_label, gmin, gmax, subject_id, language_id,
                             e.medium, e.subject_type, source_id))
                stats["new" if cur.fetchone()["inserted"] else "updated"] += 1
            # rows that vanished from the catalogue are flagged, never deleted. Guard against a
            # truncated page: only flag when the new listing is at least half the size of the old one.
            cur.execute("SELECT count(*) AS n FROM textbooks WHERE catalogue_status = 'listed'")
            if entries and len(seen_keys) >= 0.5 * cur.fetchone()["n"]:
                cur.execute("""UPDATE textbooks SET catalogue_status = 'removed'
                               WHERE catalogue_status = 'listed' AND NOT (catalogue_key = ANY(%s))""", (seen_keys,))
                stats["removed"] = cur.rowcount
        return stats

    def find_textbooks(self, ident: str | None = None, *, class_label=None, medium=None, subject=None,
                       title=None, limit=None) -> list[dict]:
        where, params = ["t.catalogue_status = 'listed'"], []
        if ident:
            if ident.isdigit():
                where.append("t.catalogue_serial = %s"); params.append(int(ident))
            else:
                try:
                    params.append(uuid.UUID(ident)); where.append("t.id = %s")
                except ValueError:
                    where.append("t.title ILIKE %s"); params.append(f"%{ident}%")
        if class_label:
            where.append("t.class_label = %s"); params.append(class_label)
        if medium:
            where.append("(l.code = %s OR l.name ILIKE %s)"); params += [language_code(medium), medium]
        if subject:
            where.append("s.name ILIKE %s"); params.append(f"%{subject}%")
        if title:
            where.append("t.title ILIKE %s"); params.append(f"%{title}%")
        sql = f"""SELECT t.id, t.catalogue_serial, t.title, t.class_label, l.code AS language_code,
                         l.ocr_lang, s.name AS subject, t.source_id,
                         src.url, src.url_kind, src.status AS source_status, src.ingest_stage
                  FROM textbooks t JOIN languages l ON l.id = t.language_id JOIN subjects s ON s.id = t.subject_id
                  LEFT JOIN textbook_sources src ON src.id = t.source_id
                  WHERE {' AND '.join(where)} ORDER BY t.catalogue_serial NULLS LAST, t.title"""
        if limit:
            sql += f" LIMIT {int(limit)}"
        with transaction(self.conn) as cur:
            cur.execute(sql, params)
            return list(cur.fetchall())

    # ---- sources -----------------------------------------------------------------------------
    def get_source(self, source_id) -> dict:
        with transaction(self.conn) as cur:
            cur.execute("SELECT * FROM textbook_sources WHERE id = %s", (source_id,))
            return cur.fetchone()

    def update_source(self, source_id, **fields) -> None:
        if not fields:
            return
        for k in ("extraction_summary",):
            if k in fields:
                fields[k] = json.dumps(fields[k])
        sets = ", ".join(f"{k} = %s" for k in fields)
        with transaction(self.conn) as cur:
            cur.execute(f"UPDATE textbook_sources SET {sets} WHERE id = %s", [*fields.values(), source_id])

    def reset_content(self, source_id) -> None:
        """Delete derived content for a source (chunks -> embeddings cascade)."""
        with transaction(self.conn) as cur:
            for table in ("textbook_chunks", "textbook_pages", "chapters"):
                cur.execute(f"DELETE FROM {table} WHERE source_id = %s", (source_id,))

    # ---- pages -------------------------------------------------------------------------------
    def existing_page_indexes(self, source_id) -> set[int]:
        with transaction(self.conn) as cur:
            cur.execute("SELECT pdf_page_index FROM textbook_pages WHERE source_id = %s", (source_id,))
            return {r["pdf_page_index"] for r in cur.fetchall()}

    def insert_pages(self, source_id, pages: Iterable) -> None:
        rows = [(source_id, p.index, p.text, len(p.text), p.method, p.ocr_confidence) for p in pages]
        if not rows:
            return
        with transaction(self.conn) as cur:
            psycopg2.extras.execute_values(
                cur, """INSERT INTO textbook_pages (source_id, pdf_page_index, content, char_count,
                                                    extraction_method, ocr_confidence) VALUES %s
                        ON CONFLICT (source_id, pdf_page_index) DO UPDATE SET content = EXCLUDED.content,
                            char_count = EXCLUDED.char_count, extraction_method = EXCLUDED.extraction_method,
                            ocr_confidence = EXCLUDED.ocr_confidence""", rows)

    def load_pages(self, source_id) -> list[dict]:
        with transaction(self.conn) as cur:
            cur.execute("""SELECT pdf_page_index, content, extraction_method FROM textbook_pages
                           WHERE source_id = %s ORDER BY pdf_page_index""", (source_id,))
            return list(cur.fetchall())

    def set_printed_pages(self, source_id, labels: dict[int, str]) -> None:
        with transaction(self.conn) as cur:
            cur.execute("UPDATE textbook_pages SET printed_page = NULL WHERE source_id = %s", (source_id,))
            if labels:
                psycopg2.extras.execute_values(
                    cur, f"""UPDATE textbook_pages p SET printed_page = v.label
                             FROM (VALUES %s) AS v(idx, label)
                             WHERE p.source_id = '{uuid.UUID(str(source_id))}' AND p.pdf_page_index = v.idx""",
                    list(labels.items()), template="(%s::int, %s::text)")

    # ---- chapters / chunks -------------------------------------------------------------------
    def replace_chapters(self, source_id, spans: Sequence) -> dict[int, uuid.UUID]:
        with transaction(self.conn) as cur:
            cur.execute("UPDATE textbook_pages SET chapter_id = NULL WHERE source_id = %s", (source_id,))
            cur.execute("DELETE FROM chapters WHERE source_id = %s", (source_id,))
            ids: dict[int, uuid.UUID] = {}
            for s in spans:
                cur.execute("""INSERT INTO chapters (source_id, ordinal, chapter_number, title, start_page, end_page,
                                                     detection_method) VALUES (%s,%s,%s,%s,%s,%s,%s) RETURNING id""",
                            (source_id, s.ordinal, s.chapter_number, s.title, s.start_page, s.end_page, s.method))
                ids[s.ordinal] = cur.fetchone()["id"]
                cur.execute("""UPDATE textbook_pages SET chapter_id = %s
                               WHERE source_id = %s AND pdf_page_index BETWEEN %s AND %s""",
                            (ids[s.ordinal], source_id, s.start_page, s.end_page))
            return ids

    def replace_chunks(self, source_id, chunks: Sequence, chapter_ids: dict[int, uuid.UUID]) -> None:
        with transaction(self.conn) as cur:
            cur.execute("DELETE FROM textbook_chunks WHERE source_id = %s", (source_id,))
            rows = [(source_id, chapter_ids.get(c.chapter_ordinal), c.chunk_index, c.page_start, c.page_end,
                     c.kind, c.content, c.token_estimate) for c in chunks]
            if rows:
                psycopg2.extras.execute_values(
                    cur, """INSERT INTO textbook_chunks (source_id, chapter_id, chunk_index, page_start, page_end,
                                                         chunk_kind, content, token_estimate) VALUES %s""", rows)

    def chunks_missing_embeddings(self, source_id, model: str, limit: int) -> list[dict]:
        with transaction(self.conn) as cur:
            cur.execute("""SELECT c.id, c.content FROM textbook_chunks c
                           LEFT JOIN textbook_embeddings e ON e.chunk_id = c.id AND e.model = %s
                           WHERE c.source_id = %s AND e.chunk_id IS NULL ORDER BY c.chunk_index LIMIT %s""",
                        (model, source_id, limit))
            return list(cur.fetchall())

    def insert_embeddings(self, model: str, ids: Sequence, vectors: Sequence[Sequence[float]]) -> None:
        rows = [(cid, model, "[" + ",".join(f"{x:.7g}" for x in v) + "]") for cid, v in zip(ids, vectors)]
        with transaction(self.conn) as cur:
            psycopg2.extras.execute_values(
                cur, """INSERT INTO textbook_embeddings (chunk_id, model, embedding) VALUES %s
                        ON CONFLICT (chunk_id, model) DO UPDATE SET embedding = EXCLUDED.embedding""",
                rows, template="(%s, %s, %s::vector)")

    def stats(self) -> dict[str, Any]:
        with transaction(self.conn) as cur:
            out: dict[str, Any] = {}
            for t in ("textbooks", "textbook_sources", "chapters", "textbook_pages", "textbook_chunks",
                      "textbook_embeddings", "ingestion_logs"):
                cur.execute(f"SELECT count(*) AS n FROM {t}")
                out[t] = cur.fetchone()["n"]
            cur.execute("SELECT status, count(*) AS n FROM textbook_sources GROUP BY status ORDER BY status")
            out["sources_by_status"] = {r["status"]: r["n"] for r in cur.fetchall()}
            return out
