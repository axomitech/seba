"""Page-aware, chapter-aware chunking with exercise detection.

Chunks never cross a chapter boundary or switch between 'body' and 'exercise' content, and every chunk
records the PDF page range it came from so citations stay exact.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

# Heading lines that open an exercise/question region (English, Assamese, Bengali, Hindi).
EXERCISE_START = re.compile(
    r"^\s*(exercise|exercises|review exercise|review questions?|questions?|let us do|think and answer|"
    r"activity|activities|assignment|try these|"
    r"অনুশীলনী|অনুশীলন|প্ৰশ্নাৱলী|প্রশ্নাবলী|প্ৰশ্ন|অভ্যাস|"
    r"अभ्यास|प्रश्नावली|प्रश्न)\b", re.I)
# A numbered section heading ("2.3 Newton's laws") or a "Summary"/"Key points" line ends an exercise region.
EXERCISE_END = re.compile(r"^\s*(\d+\.\d+(?!\d)\s+[A-Za-zঀ-৿ऀ-ॿ]|summary\b|key points\b|points to remember|সাৰাংশ|সারাংশ|सारांश)", re.I)
SENT_SPLIT = re.compile(r"(?<=[.!?।॥])\s+")


@dataclass
class PageInput:
    index: int
    text: str
    chapter_ordinal: int | None


@dataclass
class Chunk:
    chunk_index: int
    chapter_ordinal: int | None
    page_start: int
    page_end: int
    kind: str
    content: str

    @property
    def token_estimate(self) -> int:
        # script-agnostic rough estimate: Indic scripts tokenise at ~2 chars/token, latin at ~4
        indic = sum(1 for c in self.content if ord(c) >= 0x0900)
        return max(1, (len(self.content) - indic) // 4 + indic // 2)


def _units(text: str, max_len: int) -> list[tuple[str, str]]:
    """Split a page into (kind_hint, text) units: paragraphs, with oversized ones split by sentence."""
    out: list[tuple[str, str]] = []
    for para in re.split(r"\n\s*\n", text):
        para = re.sub(r"[ \t]*\n[ \t]*", " ", para).strip()
        if not para:
            continue
        if len(para) <= max_len:
            out.append(("", para))
            continue
        buf = ""
        for sent in SENT_SPLIT.split(para):
            while len(sent) > max_len:  # no sentence boundary: hard split on whitespace
                cut = sent.rfind(" ", 0, max_len)
                cut = cut if cut > max_len // 2 else max_len
                out.append(("", sent[:cut].strip()))
                sent = sent[cut:].strip()
            if buf and len(buf) + 1 + len(sent) > max_len:
                out.append(("", buf))
                buf = sent
            else:
                buf = f"{buf} {sent}".strip()
        if buf:
            out.append(("", buf))
    return out


def chunk_pages(pages: list[PageInput], target: int = 1200, overlap: int = 150) -> list[Chunk]:
    chunks: list[Chunk] = []
    cur_text: list[str] = []
    cur_len = 0
    cur_pages: list[int] = []
    cur_chapter: int | None = None
    cur_kind = "body"
    in_exercise = False

    def flush(carry_overlap: bool) -> None:
        nonlocal cur_text, cur_len, cur_pages
        if not cur_text:
            return
        content = "\n".join(cur_text).strip()
        if content:
            chunks.append(Chunk(len(chunks), cur_chapter, min(cur_pages), max(cur_pages), cur_kind, content))
        tail = ""
        if carry_overlap and overlap > 0 and content:
            tail = content[-overlap:]
            sp = tail.find(" ")
            tail = tail[sp + 1:] if 0 <= sp < len(tail) - 1 else tail
        cur_text, cur_len = ([tail], len(tail)) if tail else ([], 0)
        cur_pages = [chunks[-1].page_end] if tail and chunks else []

    for page in pages:
        if page.chapter_ordinal != cur_chapter:
            flush(False)
            cur_chapter, in_exercise = page.chapter_ordinal, False
        for _, unit in _units(page.text, target):
            first_line = unit.split("\n", 1)[0][:120]
            kind = cur_kind
            if EXERCISE_START.match(first_line):
                in_exercise = True
            elif in_exercise and EXERCISE_END.match(first_line):
                in_exercise = False
            kind = "exercise" if in_exercise else "body"
            if kind != cur_kind:
                flush(False)
                cur_kind = kind
            if cur_len and cur_len + len(unit) + 1 > target:
                flush(True)
            cur_text.append(unit)
            cur_len += len(unit) + 1
            cur_pages.append(page.index)
    flush(False)
    # drop chunks that are only carried-over overlap with no new text
    return [c for c in chunks if c.content.strip()]
