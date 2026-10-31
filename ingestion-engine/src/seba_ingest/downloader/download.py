"""PDF download with resume, conditional requests, size cap and validation."""
from __future__ import annotations

import hashlib
import logging
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import unquote, urlsplit

import pymupdf
import requests

from .safe_http import DownloadError, SafeSession

log = logging.getLogger(__name__)


class InvalidPdfError(DownloadError):
    pass


@dataclass
class DownloadResult:
    path: Path | None
    not_modified: bool = False
    sha256: str | None = None
    size: int | None = None
    etag: str | None = None
    last_modified: str | None = None
    page_count: int | None = None


def local_name(url: str) -> str:
    """Stable, filesystem-safe file name derived from the URL."""
    base = unquote(urlsplit(url).path.rsplit("/", 1)[-1]) or "book.pdf"
    base = re.sub(r"[^A-Za-z0-9._-]+", "_", base)[:80]
    return f"{hashlib.sha1(url.encode()).hexdigest()[:10]}_{base}"


def validate_pdf(path: Path) -> int:
    """Return page count or raise InvalidPdfError. Checks magic bytes, structure and encryption."""
    with path.open("rb") as fh:
        if fh.read(5) != b"%PDF-":
            raise InvalidPdfError("file does not start with %PDF-")
    try:
        with pymupdf.open(path) as doc:
            if doc.needs_pass:
                raise InvalidPdfError("PDF is password protected")
            if doc.page_count < 1:
                raise InvalidPdfError("PDF has no pages")
            doc.load_page(0)
            return doc.page_count
    except InvalidPdfError:
        raise
    except Exception as exc:  # pymupdf raises its own FileDataError etc.
        raise InvalidPdfError(f"unreadable PDF: {exc}") from exc


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def download_pdf(session: SafeSession, url: str, dest_dir: Path, max_bytes: int,
                 etag: str | None = None, last_modified: str | None = None,
                 existing: Path | None = None) -> DownloadResult:
    """Download `url` into dest_dir.

    * If `existing` is a file and the server confirms (304) the validators are unchanged, nothing is fetched.
    * An interrupted `<name>.part` is resumed with a Range request when the server honours it.
    """
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / local_name(url)
    part = dest.with_suffix(dest.suffix + ".part")

    cond: dict[str, str] = {}
    if existing and existing.is_file():
        if etag:
            cond["If-None-Match"] = etag
        if last_modified:
            cond["If-Modified-Since"] = last_modified

    resume_from = part.stat().st_size if part.is_file() else 0
    headers = dict(cond)
    if resume_from:
        headers["Range"] = f"bytes={resume_from}-"
        if etag:
            headers["If-Range"] = etag
    resp = session.request("GET", url, headers=headers, stream=True)
    try:
        if resp.status_code == 304 and existing:
            return DownloadResult(path=existing, not_modified=True, etag=etag, last_modified=last_modified)
        if resp.status_code not in (200, 206):
            raise DownloadError(f"GET {url} -> HTTP {resp.status_code}")
        ctype = resp.headers.get("Content-Type", "").lower()
        if "html" in ctype:
            raise InvalidPdfError(f"server returned HTML instead of a PDF (Content-Type {ctype!r})")
        declared = int(resp.headers.get("Content-Length") or 0)
        total_expected = declared + (resume_from if resp.status_code == 206 else 0)
        if total_expected and total_expected > max_bytes:
            raise DownloadError(f"file is {total_expected} bytes, exceeds limit {max_bytes}")
        mode = "ab" if resp.status_code == 206 else "wb"
        written = resume_from if resp.status_code == 206 else 0
        try:
            with part.open(mode) as fh:
                for block in resp.iter_content(1 << 16):
                    written += len(block)
                    if written > max_bytes:
                        raise DownloadError(f"download exceeded limit {max_bytes} bytes")
                    fh.write(block)
        except requests.RequestException as exc:
            # connection dropped mid-body: keep the .part file; the next run resumes it with a Range request
            raise DownloadError(f"incomplete download (connection interrupted: {exc.__class__.__name__}); will resume") from exc
        if total_expected and written != total_expected:
            # keep the .part so the next run can resume it
            raise DownloadError(f"incomplete download: got {written} of {total_expected} bytes")
        new_etag, new_lm = resp.headers.get("ETag"), resp.headers.get("Last-Modified")
    finally:
        resp.close()

    try:
        pages = validate_pdf(part)
    except InvalidPdfError:
        part.unlink(missing_ok=True)
        raise
    part.replace(dest)
    return DownloadResult(path=dest, sha256=sha256_file(dest), size=dest.stat().st_size,
                          etag=new_etag, last_modified=new_lm, page_count=pages)
