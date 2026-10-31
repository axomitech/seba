"""Chapter identification: PDF outline (TOC) first, printed-heading heuristics second.

Returns an empty list when neither is reliable. We never invent chapters.
"""
from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

import pymupdf


@dataclass
class ChapterSpan:
    ordinal: int
    title: str
    start_page: int
    end_page: int
    chapter_number: str | None
    method: str  # 'toc' | 'heading'


# "Chapter 3", "Unit IV", "Lesson 2", Assamese অধ্যায়/পাঠ, Bengali অধ্যায়, Hindi अध्याय/पाठ/इकाई
_WORD = r"(?:chapter|unit|lesson|ch\.?|অধ্যায়|পাঠ|पाठ|अध्याय|इकाई|ইউনিট)"
_NUM = r"(\d{1,2}|[ivxIVX]{1,5}|[০-৯]{1,2}|[०-९]{1,2})"
HEADING_RE = re.compile(rf"^\s*{_WORD}\s*[-–:.]?\s*{_NUM}\b\s*[-–:.]?\s*(.*)$", re.I)
LEADING_NUM_RE = re.compile(r"^\s*(\d{1,2})\s*[.)\-–:]\s*\S")
FRONT_BACK_RE = re.compile(r"^\s*(cover|contents?|table of contents|preface|foreword|index|glossary|"
                           r"acknowledg|bibliography|answers?|about the)", re.I)
DOTTED_PAGE_RE = re.compile(r"(\.{3,}|…|\s)\d{1,4}\s*$")


def _number_from_title(title: str) -> str | None:
    m = HEADING_RE.match(title)
    if m:
        return m.group(1)
    m = LEADING_NUM_RE.match(title)
    return m.group(1) if m else None


def from_toc(toc: list[list], page_count: int) -> list[ChapterSpan]:
    """toc rows are [level, title, page]. Use the shallowest level that yields >= 2 usable entries."""
    rows = [(lvl, str(t).strip(), int(p)) for lvl, t, p in toc if str(t).strip() and 1 <= int(p) <= page_count]
    for level in sorted({lvl for lvl, _, _ in rows}):
        picked = [(t, p) for lvl, t, p in rows if lvl == level]
        # drop consecutive duplicates (same title+page)
        dedup = [x for i, x in enumerate(picked) if i == 0 or x != picked[i - 1]]
        if len(dedup) >= 2:
            return _spans(dedup, page_count, "toc")
    return []


def _spans(items: list[tuple[str, int]], page_count: int, method: str) -> list[ChapterSpan]:
    items = sorted(items, key=lambda x: x[1])
    spans: list[ChapterSpan] = []
    for i, (title, start) in enumerate(items):
        nxt = items[i + 1][1] if i + 1 < len(items) else page_count + 1
        # chapters sharing a start page: the earlier one collapses to that single page
        end = max(start, nxt - 1)
        spans.append(ChapterSpan(i + 1, title, start, end, _number_from_title(title), method))
    return spans


def from_headings(page_texts: list[str]) -> list[ChapterSpan]:
    """Scan the first lines of each page for 'Chapter N ...' style headings with ascending numbers."""
    found: list[tuple[str, int, str]] = []
    for pno, text in enumerate(page_texts, start=1):
        lines = [l.strip() for l in text.splitlines() if l.strip()][:6]
        for i, line in enumerate(lines):
            m = HEADING_RE.match(line)
            if not m or DOTTED_PAGE_RE.search(line) and "." * 3 in line:
                continue
            rest = m.group(2).strip()
            if not rest and i + 1 < len(lines):      # title on the next line
                rest = lines[i + 1]
            title = f"{line.split(rest)[0].strip()} {rest}".strip() if rest and rest in line else \
                    (f"{line} {rest}".strip() if rest else line)
            found.append((title[:200], pno, m.group(1)))
            break
    # a contents page lists many headings on one page; keep a page only once and require >= 2 chapters
    seen_pages, uniq = set(), []
    for item in found:
        if item[1] not in seen_pages:
            seen_pages.add(item[1])
            uniq.append(item)
    if len(uniq) < 2:
        return []
    spans = _spans([(t, p) for t, p, _ in uniq], len(page_texts), "heading")
    for s, (_, _, num) in zip(spans, uniq):
        s.chapter_number = num
    return spans


def plausible_title(title: str) -> bool:
    """Reject outline entries that are really file names left behind by the typesetting software,
    e.g. 'Saral Azomia Sahitya_Bhag_1_Class_IX_Inside_72 Page_Final' or 'Blank Page'."""
    t = title.strip()
    return not (t.count("_") >= 2 or re.search(r"(_|\b)final\b", t, re.I) or re.fullmatch(r"blank( page)?", t, re.I))


def identify_chapters(pdf_path: Path, page_texts: list[str]) -> list[ChapterSpan]:
    with pymupdf.open(pdf_path) as doc:
        toc = [row for row in doc.get_toc(simple=True) if plausible_title(str(row[1]))]
        spans = from_toc(toc, doc.page_count)
    body = [s for s in spans if not FRONT_BACK_RE.match(s.title)]
    if len(body) >= 2:
        for i, s in enumerate(body, start=1):
            s.ordinal = i
        return body
    return from_headings(page_texts)


def chapter_for_page(spans: list[ChapterSpan], page: int) -> ChapterSpan | None:
    cur = None
    for s in spans:
        if s.start_page <= page <= s.end_page:
            cur = s  # later chapters win when ranges touch on a shared start page
    return cur
