from __future__ import annotations

import hashlib
import http.server
import os
import threading
from pathlib import Path

import pymupdf
import pytest

FIXTURES = Path(__file__).parent / "fixtures"
LOREM = ("Plants make food by photosynthesis. Chlorophyll in the leaves absorbs sunlight. "
         "Water and carbon dioxide are converted into glucose and oxygen. ")


def make_pdf(path: Path, pages: list[str] | None = None, toc: list[list] | None = None,
             image_pages: dict[int, str] | None = None) -> Path:
    """Create a small real PDF. `image_pages` maps page number -> text that is rasterised (scanned page)."""
    doc = pymupdf.open()
    pages = pages or [f"Page {i}. {LOREM * 4}" for i in range(1, 4)]
    for i, text in enumerate(pages, start=1):
        page = doc.new_page()
        if image_pages and i in image_pages:
            src = pymupdf.open()
            sp = src.new_page()
            sp.insert_textbox(pymupdf.Rect(50, 50, 550, 780), image_pages[i], fontsize=20)
            pix = sp.get_pixmap(dpi=150)
            page.insert_image(page.rect, stream=pix.tobytes("png"))
        else:
            page.insert_textbox(pymupdf.Rect(50, 50, 550, 780), text, fontsize=11)
    if toc:
        doc.set_toc(toc)
    doc.save(path)
    doc.close()
    return path


class _Handler(http.server.BaseHTTPRequestHandler):
    routes: dict[str, tuple[bytes, dict]] = {}
    hits: list[tuple[str, dict]] = []
    truncate: set[str] = set()

    def log_message(self, *a):  # silence
        pass

    def do_HEAD(self):
        self._serve(head=True)

    def do_GET(self):
        self._serve(head=False)

    def _serve(self, head: bool):
        _Handler.hits.append((self.path, dict(self.headers)))
        if self.path == "/loop":
            self.send_response(302); self.send_header("Location", "/loop"); self.end_headers(); return
        if self.path.startswith("/redirect"):
            self.send_response(302)
            self.send_header("Location", self.path.split("?to=", 1)[1])
            self.end_headers()
            return
        if self.path not in self.routes:
            self.send_response(404); self.end_headers(); return
        body, meta = self.routes[self.path]
        etag = '"%s"' % hashlib.md5(body).hexdigest()
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304); self.end_headers(); return
        status, start = 200, 0
        rng = self.headers.get("Range")
        if rng and rng.startswith("bytes="):
            start = int(rng[6:].split("-")[0]); status = 206
        chunk = body[start:]
        self.send_response(status)
        self.send_header("Content-Type", meta.get("type", "application/pdf"))
        self.send_header("ETag", etag)
        self.send_header("Last-Modified", "Wed, 03 May 2023 06:00:40 GMT")
        self.send_header("Content-Length", str(len(chunk)))
        self.end_headers()
        if not head:
            if self.path in self.truncate:
                chunk = chunk[: len(chunk) // 2]
            self.wfile.write(chunk)


@pytest.fixture()
def server():
    _Handler.routes, _Handler.hits, _Handler.truncate = {}, [], set()
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    class S:
        base = f"http://127.0.0.1:{httpd.server_address[1]}"
        routes = _Handler.routes
        hits = _Handler.hits
        truncate = _Handler.truncate

        def put(self, path: str, body: bytes, type: str = "application/pdf") -> str:
            _Handler.routes[path] = (body, {"type": type})
            return self.base + path

    yield S()
    httpd.shutdown()


@pytest.fixture()
def local_policy():
    from seba_ingest.downloader.safe_http import UrlPolicy
    return UrlPolicy(allowed_domains=("127.0.0.1",), insecure_hosts=("127.0.0.1",), allow_private_for=("127.0.0.1",))


@pytest.fixture()
def session(local_policy):
    from seba_ingest.downloader.safe_http import SafeSession
    return SafeSession(policy=local_policy, delay=0, retries=1)


# ---- database ------------------------------------------------------------------------------------
TEST_DSN = os.environ.get("TEST_DATABASE_URL")


@pytest.fixture(scope="session")
def pg():
    if not TEST_DSN:
        pytest.skip("TEST_DATABASE_URL not set")
    from seba_ingest.config import REPO_ROOT
    from seba_ingest.database import db
    conn = db.connect(TEST_DSN)
    with conn.cursor() as cur:
        cur.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
    conn.commit()
    db.migrate(conn, REPO_ROOT / "database" / "migrations")
    db.seed(conn, REPO_ROOT / "database" / "seeders")
    yield conn
    conn.close()


@pytest.fixture()
def repo(pg):
    from seba_ingest.database import db
    with pg.cursor() as cur:
        cur.execute("""TRUNCATE ingestion_logs, textbook_embeddings, textbook_chunks, textbook_pages, chapters,
                       textbooks, textbook_sources, subjects RESTART IDENTITY CASCADE""")
    pg.commit()
    log_conn = db.connect(TEST_DSN)
    yield db.Repository(pg, log_conn)
    log_conn.close()
