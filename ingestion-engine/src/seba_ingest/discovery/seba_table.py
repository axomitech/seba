"""Adapter for the SEBA textbook catalogue.

Observed structure (verified against the live site):
  https://site.sebaonline.org/textbook  ->  page body holds an <iframe> whose src is
  https://www.sebaonline.org/textbooks/textbooks.htm, which contains one big
  <table id="tblstudentData"> with columns Sl. No. | Name of the Textbook | Class | Medium |
  Subject Name | Subject Type | Download (an <a> per row).

Nothing here depends on column *order*: columns are located by header text through
HEADER_ALIASES, and iframes are followed generically, so a reshuffled table or a catalogue
that is inlined (no iframe) still works. New site layouts should get a new adapter class
registered in ADAPTERS rather than edits here.
"""
from __future__ import annotations

import logging
from typing import Callable, Protocol
from urllib.parse import urljoin

from bs4 import BeautifulSoup

from .models import CatalogueEntry
from .normalize import classify_url, clean_subject, collapse_ws, normalize_class

log = logging.getLogger(__name__)

HEADER_ALIASES: dict[str, tuple[str, ...]] = {
    "serial": ("sl. no", "sl no", "s.no", "sr. no", "serial"),
    "title": ("name of the textbook", "textbook", "book name", "title", "name of the book"),
    "class": ("class", "grade"),
    "medium": ("medium", "language"),
    "subject": ("subject name", "subject"),
    "subject_type": ("subject type", "type"),
    "download": ("download", "link", "pdf"),
}
# Order matters: "subject type" must be matched before the shorter "subject".
_MATCH_ORDER = ("serial", "subject_type", "subject", "title", "class", "medium", "download")

Fetch = Callable[[str], str]


class DiscoveryAdapter(Protocol):
    name: str

    def discover(self, catalogue_url: str, fetch: Fetch) -> list[CatalogueEntry]: ...


def map_headers(cells: list[str]) -> dict[str, int]:
    mapping: dict[str, int] = {}
    for idx, text in enumerate(cells):
        t = collapse_ws(text).lower()
        for field in _MATCH_ORDER:
            if field in mapping:
                continue
            if any(t == a or (len(a) > 4 and a in t) for a in HEADER_ALIASES[field]):
                mapping[field] = idx
                break
    return mapping


class SebaCatalogueAdapter:
    name = "seba-iframe-table"
    max_iframe_depth = 2

    def discover(self, catalogue_url: str, fetch: Fetch) -> list[CatalogueEntry]:
        entries: list[CatalogueEntry] = []
        self._walk(catalogue_url, fetch, entries, depth=0, seen=set())
        return entries

    def _walk(self, url: str, fetch: Fetch, out: list[CatalogueEntry], depth: int, seen: set[str]) -> None:
        if url in seen:
            return
        seen.add(url)
        html = fetch(url)
        soup = BeautifulSoup(html, "html.parser")
        found = self.parse_tables(soup, url)
        out.extend(found)
        log.info("%s: %d catalogue rows", url, len(found))
        if depth < self.max_iframe_depth:
            for frame in soup.find_all("iframe"):
                src = (frame.get("src") or "").strip()
                if src:
                    # code blocks (<pre><code>) may carry escaped iframe text; real iframes only here
                    self._walk(urljoin(url, src), fetch, out, depth + 1, seen)

    def parse_tables(self, soup: BeautifulSoup, page_url: str) -> list[CatalogueEntry]:
        entries: list[CatalogueEntry] = []
        for table in soup.find_all("table"):
            rows = table.find_all("tr")
            header_idx, mapping = None, {}
            for i, tr in enumerate(rows[:5]):
                m = map_headers([c.get_text(" ") for c in tr.find_all(["td", "th"])])
                if {"title", "class", "subject"} <= m.keys():
                    header_idx, mapping = i, m
                    break
            if header_idx is None:
                continue
            for tr in rows[header_idx + 1:]:
                cells = tr.find_all(["td", "th"])
                entry = self._row(cells, mapping, page_url)
                if entry:
                    entries.append(entry)
        return entries

    @staticmethod
    def _row(cells, mapping: dict[str, int], page_url: str) -> CatalogueEntry | None:
        def text(field: str) -> str:
            i = mapping.get(field)
            return collapse_ws(cells[i].get_text(" ")) if i is not None and i < len(cells) else ""

        title, class_raw, subject_raw = text("title"), text("class"), text("subject")
        if not title or not class_raw:
            return None
        class_label = normalize_class(class_raw)
        if class_label is None:
            log.warning("skipping row %r: unrecognised class %r", title, class_raw)
            return None
        href = None
        di = mapping.get("download")
        if di is not None and di < len(cells):
            a = cells[di].find("a", href=True)
            raw = a["href"].strip() if a else ""
            # the catalogue has "CLICK HERE" links with an empty href (row 10): that is no link at all
            if raw and not raw.startswith("#") and not raw.lower().startswith(("javascript:", "mailto:")):
                href = urljoin(page_url, raw)
        serial = text("serial")
        return CatalogueEntry(
            serial=int(serial) if serial.isdigit() else None,
            title=title,
            class_label=class_label,
            medium=text("medium") or "Unknown",
            subject=clean_subject(subject_raw or title),
            subject_type=text("subject_type") or None,
            url=href,
            url_kind=classify_url(href),
            discovered_from=page_url,
        )


ADAPTERS: dict[str, DiscoveryAdapter] = {SebaCatalogueAdapter.name: SebaCatalogueAdapter()}


def discover_catalogue(catalogue_url: str, fetch: Fetch, adapter: str = SebaCatalogueAdapter.name) -> list[CatalogueEntry]:
    """Run an adapter and drop exact duplicates (the site lists some rows twice)."""
    entries = ADAPTERS[adapter].discover(catalogue_url, fetch)
    seen, unique = set(), []
    for e in entries:
        k = (e.title.lower(), e.class_label, e.medium.lower(), e.subject.lower(), e.subject_type, e.url)
        if k in seen:
            log.info("duplicate catalogue row ignored: %s (%s)", e.title, e.class_label)
            continue
        seen.add(k)
        unique.append(e)
    return unique
