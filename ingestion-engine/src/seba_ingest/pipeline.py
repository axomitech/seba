"""Orchestration of the ingestion stages for one source file, with resume and incremental updates.

Stage order (sources.ingest_stage): pending < downloaded < extracted < chunked < embedded < done
Every stage is idempotent, so re-running after a crash resumes where it stopped:
  * download     resumes `.part` files; a conditional GET (ETag / Last-Modified) detects upstream changes
  * extraction   continues after the last contiguous stored page
  * chunking     is deterministic and replaces the source's chunks
  * embedding    only embeds chunks that have no vector for the configured model
"""
from __future__ import annotations

import logging
import traceback
import uuid
from dataclasses import dataclass, field
from pathlib import Path

from .chapter_parser.parser import chapter_for_page, identify_chapters
from .chunking.chunker import PageInput, chunk_pages
from .config import Settings
from .database.db import Repository
from .discovery.seba_table import discover_catalogue
from .downloader.download import download_pdf
from .downloader.safe_http import SafeSession
from .embeddings.providers import EmbeddingProvider
from .extraction.pdf import iter_pages, printed_page_candidates

log = logging.getLogger(__name__)
STAGES = ["pending", "downloaded", "extracted", "chunked", "embedded", "done"]


def _rank(stage: str) -> int:
    return STAGES.index(stage)


@dataclass
class IngestOptions:
    force: bool = False            # re-extract, re-chunk and re-embed even if up to date
    redownload: bool = False       # ignore the local copy and fetch again
    rechunk: bool = False          # keep stored pages, redo chapters + chunks (+ missing embeddings)
    ocr: bool = True
    embed: bool = True
    max_pages: int | None = None   # for quick trials only; marks the run as partial
    page_batch: int = 25


@dataclass
class IngestResult:
    source_id: uuid.UUID
    url: str
    outcome: str                   # 'indexed' | 'unchanged' | 'skipped' | 'failed'
    detail: str = ""
    counts: dict = field(default_factory=dict)


class Pipeline:
    def __init__(self, settings: Settings, repo: Repository, session: SafeSession,
                 embedder: EmbeddingProvider | None):
        self.s, self.repo, self.session, self.embedder = settings, repo, session, embedder
        self.run_id = uuid.uuid4()

    # ---- discovery ---------------------------------------------------------------------------
    def discover(self) -> dict:
        entries = discover_catalogue(self.s.catalogue_url, self.session.get_text)
        if not entries:
            raise RuntimeError("discovery found no catalogue rows; refusing to touch the database "
                               "(the site layout may have changed - add/adjust a discovery adapter)")
        stats = self.repo.upsert_catalogue(entries)
        stats["rows_discovered"] = len(entries)
        by_kind: dict[str, int] = {}
        for e in entries:
            by_kind[e.url_kind] = by_kind.get(e.url_kind, 0) + 1
        stats["by_url_kind"] = by_kind
        self.repo.log(self.run_id, "discover", f"discovered {len(entries)} rows", details=stats)
        return stats

    # ---- ingestion ---------------------------------------------------------------------------
    def ingest_textbook(self, tb: dict, opts: IngestOptions) -> IngestResult:
        sid, url = tb["source_id"], tb["url"]
        if sid is None:
            return IngestResult(None, "", "skipped", "catalogue row has no download link")
        if tb["url_kind"] != "pdf":
            self.repo.log(self.run_id, "select", f"skipping non-PDF source ({tb['url_kind']})",
                          level="warning", source_id=sid, details={"url": url})
            return IngestResult(sid, url, "skipped", f"unsupported source type: {tb['url_kind']}")
        try:
            return self._ingest(sid, url, tb.get("ocr_lang") or "eng", opts)
        except Exception as exc:
            log.error("ingestion failed for %s: %s", url, exc)
            detail = "".join(traceback.format_exception_only(type(exc), exc)).strip()
            self.repo.conn.rollback()
            self.repo.update_source(sid, status="failed", last_error=detail[:1000])
            self.repo.log(self.run_id, "error", detail, level="error", source_id=sid,
                          details={"traceback": traceback.format_exc()[-3000:]})
            return IngestResult(sid, url, "failed", detail)

    def _ingest(self, sid, url: str, ocr_lang: str, opts: IngestOptions) -> IngestResult:
        repo, s = self.repo, self.s
        src = repo.get_source(sid)
        stage = src["ingest_stage"]
        repo.update_source(sid, status="processing", last_error=None)
        local = Path(src["local_path"]) if src["local_path"] else None
        local = local if local and local.is_file() and not opts.redownload else None

        # 1. download / conditional re-check ------------------------------------------------------
        repo.log(self.run_id, "download", "checking source", source_id=sid, details={"url": url})
        res = download_pdf(self.session, url, s.download_dir, s.max_pdf_bytes,
                           etag=src["http_etag"], last_modified=src["http_last_modified"], existing=local)
        changed = False
        if res.not_modified:
            path = res.path
        else:
            path = res.path
            changed = src["sha256"] != res.sha256
            repo.update_source(sid, local_path=str(path), sha256=res.sha256, content_length=res.size,
                               http_etag=res.etag, http_last_modified=res.last_modified,
                               page_count=res.page_count, downloaded_at=_now())
            repo.log(self.run_id, "download", "downloaded" + (" (content changed)" if changed else " (same content)"),
                     source_id=sid, details={"bytes": res.size, "pages": res.page_count, "sha256": res.sha256})
        repo.update_source(sid, last_checked_at=_now())
        page_count = repo.get_source(sid)["page_count"]
        # a trial run (--max-pages) never advances the persisted stage, so a later full run
        # still extracts the remaining pages
        partial = bool(opts.max_pages and (page_count or 0) > opts.max_pages)

        if changed and src["sha256"] is not None:
            repo.reset_content(sid)
            stage = "downloaded"
        if opts.force:
            repo.reset_content(sid)
            stage = "downloaded"
        if _rank(stage) < _rank("downloaded"):
            stage = "downloaded"
        repo.update_source(sid, ingest_stage=stage)

        if opts.rechunk and not opts.force and _rank(stage) >= _rank("extracted"):
            stage = "extracted"
        fresh = _rank(stage) < _rank("chunked") or opts.rechunk
        counts: dict = {}
        # 2. extraction (resumable) --------------------------------------------------------------
        if _rank(stage) < _rank("extracted"):
            have = repo.existing_page_indexes(sid)
            if have and have != set(range(1, len(have) + 1)):
                repo.reset_content(sid)
                have = set()
            start = len(have) + 1
            limit = opts.max_pages
            batch = []
            n_new = 0
            for page in iter_pages(path, ocr_enabled=opts.ocr and s.ocr_enabled, ocr_languages=ocr_lang,
                                   dpi=s.ocr_dpi, min_chars=s.ocr_min_chars, ocr_workers=s.ocr_workers,
                                   start_at=start, max_pages=(limit - len(have)) if limit else None):
                batch.append(page)
                n_new += 1
                if len(batch) >= opts.page_batch:
                    repo.insert_pages(sid, batch)
                    repo.log(self.run_id, "extract", f"stored pages up to {page.index}", source_id=sid)
                    batch = []
            repo.insert_pages(sid, batch)
            repo.log(self.run_id, "extract", f"extracted {n_new} pages", source_id=sid)
            if not partial:
                stage = "extracted"
                repo.update_source(sid, ingest_stage=stage)
            fresh = True

        # 3+4. chapters and chunks ---------------------------------------------------------------
        if fresh and (_rank(stage) >= _rank("extracted") or partial):
            pages = repo.load_pages(sid)
            texts = [p["content"] for p in pages]
            repo.set_printed_pages(sid, printed_page_candidates(texts))
            spans = identify_chapters(path, texts)
            chapter_ids = repo.replace_chapters(sid, spans)
            inputs = []
            for p in pages:
                ch = chapter_for_page(spans, p["pdf_page_index"])
                inputs.append(PageInput(p["pdf_page_index"], p["content"], ch.ordinal if ch else None))
            chunks = chunk_pages(inputs, s.chunk_target_chars, s.chunk_overlap_chars)
            repo.replace_chunks(sid, chunks, chapter_ids)
            if not partial:
                stage = "chunked"
                repo.update_source(sid, ingest_stage=stage)
            counts.update(chapters=len(spans), chunks=len(chunks))
            counts["chapter_quality"] = chapter_quality(spans)
            repo.log(self.run_id, "chunk", f"{len(spans)} chapters, {len(chunks)} chunks", source_id=sid)

        # 5. embeddings (only missing ones) ------------------------------------------------------
        if self.embedder and opts.embed and (_rank(stage) >= _rank("chunked") or partial):
            total = 0
            while True:
                batch = repo.chunks_missing_embeddings(sid, self.embedder.model, s.embedding_batch)
                if not batch:
                    break
                vecs = self.embedder.embed([c["content"][:6000] for c in batch])
                repo.insert_embeddings(self.embedder.model, [c["id"] for c in batch], vecs)
                total += len(batch)
            counts["embedded"] = total
            if not partial:
                stage = "embedded"
                repo.update_source(sid, ingest_stage=stage)
            repo.log(self.run_id, "embed", f"embedded {total} chunks", source_id=sid,
                     details={"model": self.embedder.model})

        embeds_pending = bool(self.embedder and opts.embed and stage != "embedded")
        complete = _rank(stage) >= _rank("chunked") and not partial
        if complete and not embeds_pending:
            stage = "done"
        summary = self._summary(sid)
        summary["partial"] = partial          # trial run: only the first pages are stored/searchable
        summary["pages_extracted"] = sum(summary["pages_by_method"].values())
        if "chapter_quality" in counts:
            summary["chapter_quality"] = counts["chapter_quality"]
        repo.update_source(sid, ingest_stage=stage, extraction_summary=summary,
                           status="indexed" if (_rank(stage) >= _rank("chunked") or partial) else "downloaded",
                           indexed_at=_now() if complete else None)
        outcome = "partial" if partial else ("indexed" if fresh or counts else "unchanged")
        return IngestResult(sid, url, outcome, "", {**counts, **summary})

    def _summary(self, sid) -> dict:
        with_cur = self.repo.conn.cursor()
        with_cur.execute("""SELECT extraction_method, count(*) FROM textbook_pages WHERE source_id = %s
                            GROUP BY extraction_method""", (sid,))
        by_method = dict(with_cur.fetchall())
        with_cur.close()
        self.repo.conn.commit()
        return {"pages_by_method": by_method}


def chapter_quality(spans) -> dict:
    """Report how trustworthy chapter boundaries are. TOC-derived chapters are authoritative; heading
    heuristics can miss chapters (their pages then fall into the previous chapter), which shows up as gaps
    in the printed chapter numbers."""
    if not spans:
        return {"method": None, "status": "none"}
    method = spans[0].method
    nums = []
    for sp in spans:
        try:
            nums.append(int(sp.chapter_number)) if sp.chapter_number else None
        except ValueError:
            pass
    gaps = [] if method == "toc" or len(nums) < 2 else sorted(set(range(1, max(nums) + 1)) - set(nums))
    return {"method": method, "status": "complete" if not gaps else "partial", "missing_numbers": gaps}


def _now():
    from datetime import datetime, timezone
    return datetime.now(timezone.utc)
