"""Integration tests against a real PostgreSQL + pgvector database (TEST_DATABASE_URL).
The 'remote' PDF host is a local HTTP server; everything else (PyMuPDF, Tesseract, SQL) is real."""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import psycopg2
import pytest

from conftest import LOREM, TEST_DSN, make_pdf
from seba_ingest.config import EMBEDDING_DIMENSIONS, Settings
from seba_ingest.database import db
from seba_ingest.discovery.models import CatalogueEntry
from seba_ingest.embeddings.providers import OllamaEmbeddings
from seba_ingest.pipeline import IngestOptions, Pipeline

pytestmark = pytest.mark.db


def entry(url, title="Science IX", cls="IX", medium="English", subject="General Science", serial=1, kind="pdf"):
    return CatalogueEntry(serial, title, cls, medium, subject, "Core", url, kind, "https://x/catalogue")


BOOK_PAGES = ([f"Chapter 1 Light\n{LOREM * 6}", LOREM * 6, f"EXERCISE 1.1\n\n1. What is light?\n\n2. Define reflection.",
               f"Chapter 2 Sound\n{LOREM * 6}", LOREM * 6])


@pytest.fixture()
def pipeline(repo, session, tmp_path):
    s = Settings(download_dir=tmp_path / "dl", ocr_enabled=False, request_delay=0, chunk_target_chars=600,
                 chunk_overlap_chars=50, embedding_batch=4)
    return lambda embedder=None: Pipeline(s, repo, session, embedder)


def one(repo, sql, params=()):
    with db.transaction(repo.conn) as cur:
        cur.execute(sql, params)
        return cur.fetchall()


def test_migrations_are_idempotent_and_schema_is_complete(pg):
    from seba_ingest.config import REPO_ROOT
    assert db.migrate(pg, REPO_ROOT / "database" / "migrations") == []
    cur = pg.cursor()
    cur.execute("select table_name from information_schema.tables where table_schema='public'")
    tables = {r[0] for r in cur.fetchall()}
    assert {"textbooks", "subjects", "languages", "textbook_sources", "chapters", "textbook_pages",
            "textbook_chunks", "textbook_embeddings", "ingestion_logs"} <= tables
    cur.execute("select extname from pg_extension")
    assert {"vector", "pg_trgm"} <= {r[0] for r in cur.fetchall()}
    for t in ("textbooks", "chapters", "textbook_pages", "textbook_chunks"):   # created_at + updated_at everywhere
        cur.execute("select column_name from information_schema.columns where table_name=%s", (t,))
        cols = {r[0] for r in cur.fetchall()}
        assert {"id", "created_at", "updated_at"} <= cols
    pg.commit()


def test_constraints(repo):
    repo.upsert_catalogue([entry("https://x/a.pdf")])
    with pytest.raises(psycopg2.errors.CheckViolation):
        with db.transaction(repo.conn) as cur:
            cur.execute("update textbooks set class_label='XI'")
    with pytest.raises(psycopg2.errors.ForeignKeyViolation):
        with db.transaction(repo.conn) as cur:
            cur.execute("insert into textbook_pages (source_id,pdf_page_index,extraction_method) values (gen_random_uuid(),1,'text')")


def test_catalogue_upsert_is_idempotent_and_shares_sources(repo):
    shared = "https://x/shared.pdf"
    entries = [entry(shared, "Reader", "IX", serial=1), entry(shared, "Reader", "X", serial=2),
               entry(None, "No link", serial=3, kind="none"), entry("https://x/a.rar", "Archive", serial=4, kind="archive"),
               entry("https://x/dir/", "Dir", serial=5, kind="html")]
    first = repo.upsert_catalogue(entries)
    second = repo.upsert_catalogue(entries)
    assert (first["new"], second["new"], second["updated"]) == (5, 0, 5)
    assert one(repo, "select count(*) from textbook_sources")[0]["count"] == 3          # shared PDF stored once
    st = {r["url_kind"]: r["status"] for r in one(repo, "select url_kind,status from textbook_sources")}
    assert st == {"pdf": "discovered", "archive": "unsupported", "html": "unavailable"}
    assert len(repo.find_textbooks("Reader")) == 2


def test_removed_rows_are_flagged_not_deleted(repo):
    repo.upsert_catalogue([entry(f"https://x/{i}.pdf", f"Book {i}", serial=i) for i in range(1, 5)])
    stats = repo.upsert_catalogue([entry(f"https://x/{i}.pdf", f"Book {i}", serial=i) for i in range(1, 4)])
    assert stats["removed"] == 1 and len(repo.find_textbooks()) == 3
    assert one(repo, "select count(*) from textbooks")[0]["count"] == 4
    # a suspiciously small listing must not mass-flag the catalogue
    assert repo.upsert_catalogue([entry("https://x/1.pdf", "Book 1", serial=1)])["removed"] == 0


def test_full_ingest_then_unchanged_rerun(server, repo, pipeline, tmp_path):
    url = server.put("/sci.pdf", make_pdf(tmp_path / "b.pdf", BOOK_PAGES,
                                          toc=[[1, "Chapter 1 Light", 1], [1, "Chapter 2 Sound", 4]]).read_bytes())
    repo.upsert_catalogue([entry(url)])
    p = pipeline()
    [tb] = repo.find_textbooks()
    res = p.ingest_textbook(tb, IngestOptions(embed=False))
    assert res.outcome == "indexed", res.detail
    src = repo.get_source(tb["source_id"])
    assert (src["status"], src["ingest_stage"], src["page_count"]) == ("indexed", "done", 5)
    assert src["sha256"] and src["url"] == url
    assert one(repo, "select count(*) from textbook_pages")[0]["count"] == 5
    chapters = one(repo, "select ordinal,title,start_page,end_page from chapters order by ordinal")
    assert [(c["start_page"], c["end_page"]) for c in chapters] == [(1, 3), (4, 5)]
    ex = one(repo, "select page_start, content from textbook_chunks where chunk_kind='exercise'")
    assert ex and "What is light?" in ex[0]["content"] and ex[0]["page_start"] == 3
    # every page is linked to its chapter
    assert one(repo, "select count(*) from textbook_pages where chapter_id is null")[0]["count"] == 0
    # full-text search works with page references
    hit = one(repo, """select c.page_start, ch.title from textbook_chunks c join chapters ch on ch.id=c.chapter_id
                       where c.content_tsv @@ plainto_tsquery('simple','chlorophyll') order by c.chunk_index limit 1""")
    assert hit and hit[0]["title"] == "Chapter 1 Light"
    before = one(repo, "select id from textbook_chunks order by chunk_index")
    again = p.ingest_textbook(tb, IngestOptions(embed=False))
    assert again.outcome == "unchanged"
    assert one(repo, "select id from textbook_chunks order by chunk_index") == before    # no duplicate/rebuilt content
    assert one(repo, "select count(*) from textbook_pages")[0]["count"] == 5


def test_updated_upstream_pdf_replaces_content(server, repo, pipeline, tmp_path):
    url = server.put("/sci.pdf", make_pdf(tmp_path / "v1.pdf", BOOK_PAGES).read_bytes())
    repo.upsert_catalogue([entry(url)])
    p = pipeline(); [tb] = repo.find_textbooks()
    p.ingest_textbook(tb, IngestOptions(embed=False))
    old_sha = repo.get_source(tb["source_id"])["sha256"]
    server.put("/sci.pdf", make_pdf(tmp_path / "v2.pdf", ["second edition only page " + LOREM]).read_bytes())
    res = p.ingest_textbook(tb, IngestOptions(embed=False))
    assert res.outcome == "indexed" and repo.get_source(tb["source_id"])["sha256"] != old_sha
    assert one(repo, "select count(*) from textbook_pages")[0]["count"] == 1
    assert "second edition" in one(repo, "select content from textbook_pages")[0]["content"]


def test_resume_after_interruption_continues_from_last_stored_page(server, repo, pipeline, tmp_path):
    pdf = make_pdf(tmp_path / "b.pdf", [f"page {i} {LOREM}" for i in range(1, 9)])
    url = server.put("/b.pdf", pdf.read_bytes())
    repo.upsert_catalogue([entry(url)])
    p = pipeline(); [tb] = repo.find_textbooks()
    partial = p.ingest_textbook(tb, IngestOptions(embed=False, max_pages=3))        # simulated interruption
    assert partial.outcome == "partial"
    summary = repo.get_source(tb["source_id"])["extraction_summary"]
    assert summary["partial"] is True and summary["pages_extracted"] == 3      # surfaced to MCP clients
    assert repo.get_source(tb["source_id"])["ingest_stage"] == "downloaded"
    assert sorted(repo.existing_page_indexes(tb["source_id"])) == [1, 2, 3]
    stored_ids = one(repo, "select id from textbook_pages order by pdf_page_index")
    done = p.ingest_textbook(tb, IngestOptions(embed=False))
    assert done.outcome == "indexed" and repo.get_source(tb["source_id"])["ingest_stage"] == "done"
    assert repo.get_source(tb["source_id"])["extraction_summary"]["partial"] is False
    assert sorted(repo.existing_page_indexes(tb["source_id"])) == list(range(1, 9))
    assert one(repo, "select id from textbook_pages order by pdf_page_index limit 3") == stored_ids  # first pages untouched


def test_failures_are_recorded_and_do_not_stop_other_books(server, repo, pipeline, tmp_path):
    good = server.put("/good.pdf", make_pdf(tmp_path / "g.pdf").read_bytes())
    bad = server.put("/bad.pdf", b"<html>not a pdf</html>", type="text/html")
    repo.upsert_catalogue([entry(bad, "Bad", serial=1), entry(good, "Good", serial=2)])
    p = pipeline()
    results = [p.ingest_textbook(tb, IngestOptions(embed=False)) for tb in repo.find_textbooks()]
    assert [r.outcome for r in results] == ["failed", "indexed"]
    bad_src = one(repo, "select status,last_error from textbook_sources where url=%s", (bad,))[0]
    assert bad_src["status"] == "failed" and "HTML" in bad_src["last_error"]
    errs = one(repo, "select level,stage from ingestion_logs where level='error'")
    assert errs and errs[0]["stage"] == "error"
    # a later run with the file fixed succeeds (retry)
    server.put("/bad.pdf", make_pdf(tmp_path / "fix.pdf").read_bytes())
    assert p.ingest_textbook(repo.find_textbooks("Bad")[0], IngestOptions(embed=False)).outcome == "indexed"


def test_unsupported_sources_are_skipped_with_reason(repo, pipeline):
    repo.upsert_catalogue([entry("https://x/a.rar", "Archive", kind="archive"), entry(None, "No link", serial=2, kind="none")])
    p = pipeline()
    out = {tb["title"]: p.ingest_textbook(tb, IngestOptions()) for tb in repo.find_textbooks()}
    assert out["Archive"].outcome == "skipped" and "archive" in out["Archive"].detail
    assert out["No link"].outcome == "skipped"


def test_embeddings_stored_incrementally_and_searchable_with_pgvector(server, repo, pipeline, tmp_path):
    state = {"calls": 0}

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a): pass

        def do_POST(self):
            texts = json.loads(self.rfile.read(int(self.headers["Content-Length"])))["input"]
            state["calls"] += 1
            vs = []
            for t in texts:   # deterministic fake model: axis 0 = mentions light, axis 1 = mentions sound
                v = [0.0] * EMBEDDING_DIMENSIONS
                v[0], v[1], v[2] = float("light" in t.lower()), float("sound" in t.lower()), 0.01
                vs.append(v)
            raw = json.dumps({"embeddings": vs}).encode()
            self.send_response(200); self.send_header("Content-Length", str(len(raw))); self.end_headers(); self.wfile.write(raw)

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        url = server.put("/sci.pdf", make_pdf(tmp_path / "b.pdf", BOOK_PAGES).read_bytes())
        repo.upsert_catalogue([entry(url)])
        emb = OllamaEmbeddings(f"http://127.0.0.1:{httpd.server_address[1]}", "stub-model")
        emb._url = f"http://127.0.0.1:{httpd.server_address[1]}/api/embed"
        p = pipeline(emb); [tb] = repo.find_textbooks()
        p.ingest_textbook(tb, IngestOptions())
        n_chunks = one(repo, "select count(*) from textbook_chunks")[0]["count"]
        assert one(repo, "select count(*) from textbook_embeddings")[0]["count"] == n_chunks
        assert repo.get_source(tb["source_id"])["ingest_stage"] == "done"
        calls = state["calls"]
        p.ingest_textbook(tb, IngestOptions())                 # nothing missing -> no embedding calls
        assert state["calls"] == calls
        q = "[1," + ",".join(["0"] * (EMBEDDING_DIMENSIONS - 1)) + "]"   # "light" direction
        top = one(repo, """select c.content from textbook_embeddings e join textbook_chunks c on c.id=e.chunk_id
                           where e.model='stub-model' order by e.embedding <=> %s::vector limit 1""", (q,))
        assert "light" in top[0]["content"].lower()
    finally:
        httpd.shutdown()


def test_reader_role_is_read_only_and_cannot_see_operational_data(pg, repo):
    from seba_ingest.config import REPO_ROOT
    repo.upsert_catalogue([entry("https://x/a.pdf")])
    import subprocess
    r = subprocess.run(["psql", TEST_DSN, "-v", "ON_ERROR_STOP=1", "-v", "reader_password=test-pass-123", "-v", "reader_role=seba_reader_pytest", "-f",
                        str(REPO_ROOT / "database" / "roles" / "create_reader.sql")], capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    from urllib.parse import urlsplit
    u = urlsplit(TEST_DSN)
    rd = psycopg2.connect(host=u.hostname, port=u.port, dbname=u.path.strip("/"), user="seba_reader_pytest", password="test-pass-123")
    c = rd.cursor()
    c.execute("select count(*) from textbooks"); assert c.fetchone()[0] == 1
    c.execute("select url, status from textbook_sources"); assert c.fetchall()
    for bad in ("select local_path from textbook_sources", "select * from ingestion_logs",
                "insert into languages (code,name) values ('x','x')", "delete from textbooks"):
        rd.rollback()
        with pytest.raises((psycopg2.errors.InsufficientPrivilege, psycopg2.errors.ReadOnlySqlTransaction)):
            c.execute(bad)
    rd.rollback()
    c.execute("show default_transaction_read_only"); assert c.fetchone()[0] == "on"
    rd.close()
