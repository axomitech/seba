"""Page-level text extraction with OCR fallback (PyMuPDF + Tesseract)."""
from __future__ import annotations

import logging
import re
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator

import pymupdf

from ..ocr.tesseract import OcrUnavailable, ocr_png, resolve_languages

log = logging.getLogger(__name__)


@dataclass
class ExtractedPage:
    index: int                      # 1-based PDF page index
    text: str
    method: str                     # 'text' | 'ocr' | 'empty'
    ocr_confidence: float | None = None
    printed_page: str | None = None


_LATIN1_SYMBOLS_OK = set("¡¢£¤¥¦§¨©ª«¬®¯°±²³´µ¶·¸¹º»¼½¾¿×÷")  # plausible in normal English/maths text


def _is_suspicious(ch: str) -> bool:
    o = ord(ch)
    if ch == "\ufffd" or 0xE000 <= o <= 0xF8FF:
        return True
    if o < 32 and ch not in "\n\t\r":
        return True
    if 0xC0 <= o <= 0xFF and ch not in "×÷":            # accented Latin letters (À-ÿ)
        return True
    return (0x100 <= o <= 0x24F or 0x2C0 <= o <= 0x2DF   # Latin Extended, spacing modifiers (˘ ˚ ˛ ˝)
            or 0xFB00 <= o <= 0xFB4F                       # ligature glyphs (ﬂ ﬁ)
            or 0x2200 <= o <= 0x22FF or o in (0x2020, 0x2021, 0x2030, 0x2202, 0x221E))


def garbage_ratio(text: str) -> float:
    """Share of non-space characters that signal a broken font mapping.

    SEBA's Assamese/Bengali/Bodo books are often typeset in legacy 8-bit fonts: the PDF text layer
    then holds Latin-1/Mac-Roman look-alike glyphs (e.g. '¸1˘ ’¸˜œ˚˛±') instead of Unicode Indic text.
    Such pages have a very high density of accented-Latin, modifier and ligature characters, which
    normal English prose does not.
    """
    chars = [c for c in text if not c.isspace()]
    if not chars:
        return 0.0
    return sum(1 for c in chars if _is_suspicious(c)) / len(chars)


GARBAGE_THRESHOLD = 0.12


def needs_ocr(text: str, min_chars: int, has_images: bool) -> bool:
    visible = len(re.sub(r"\s+", "", text))
    if visible < min_chars:
        return True if has_images or visible == 0 else False
    return garbage_ratio(text) > GARBAGE_THRESHOLD


def clean_text(text: str) -> str:
    text = text.replace("\x00", "").replace("­", "")
    text = re.sub(r"[ \t]+\n", "\n", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


# Unicode-aware: \d also matches Assamese/Bengali/Devanagari digits and int() converts them.
_NUM_LINE = re.compile(r"^\s*(\d{1,4})\s*$")
_NUM_START = re.compile(r"^\s*(\d{1,4})\s+\D")      # '32 Running header'
_NUM_END = re.compile(r"\D\s+(\d{1,4})\s*$")        # 'Running header 33'
_CANDIDATE_RES = (_NUM_LINE, _NUM_START, _NUM_END)


def printed_page_candidates(texts: list[str]) -> dict[int, str]:
    """Detect printed page numbers: a number-only first/last line, accepted only for pages that
    agree with the dominant (printed - pdf_index) offset, so stray digits never become page labels."""
    cands: dict[int, int] = {}
    for i, t in enumerate(texts, start=1):
        lines = [l for l in t.splitlines() if l.strip()]
        found = None
        for line in (lines[-1:] + lines[:1]):
            for rx in _CANDIDATE_RES:
                m = rx.search(line) if rx is _NUM_END else rx.match(line)
                if m:
                    found = int(m.group(1))
                    break
            if found is not None:
                break
        if found is not None:
            cands[i] = found
    if len(cands) < 3:
        return {}
    offset, count = Counter(n - i for i, n in cands.items()).most_common(1)[0]
    if count < max(3, 0.3 * len(cands)):
        return {}
    return {i: str(n) for i, n in cands.items() if n - i == offset}


def iter_pages(pdf_path: Path, *, ocr_enabled: bool, ocr_languages: str, dpi: int, min_chars: int,
               ocr_workers: int = 2, start_at: int = 1, max_pages: int | None = None) -> Iterator[ExtractedPage]:
    """Yield pages in order. Embedded text is used when usable; otherwise the page is rasterised and OCR'd.
    Printed page labels are NOT set here (they need the whole book); see `printed_page_candidates`."""
    ocr_ok = ocr_enabled
    langs = ""
    if ocr_ok:
        try:
            langs = resolve_languages(ocr_languages)
        except OcrUnavailable as exc:
            log.warning("OCR disabled: %s", exc)
            ocr_ok = False

    with pymupdf.open(pdf_path) as doc, ThreadPoolExecutor(max_workers=max(1, ocr_workers)) as pool:
        last = doc.page_count if max_pages is None else min(doc.page_count, start_at - 1 + max_pages)
        window: list[tuple[int, str, bytes | None]] = []

        def flush() -> Iterator[ExtractedPage]:
            futures = [(i, t, pool.submit(ocr_png, png, langs) if png else None) for i, t, png in window]
            window.clear()
            for i, text, fut in futures:
                if fut is None:
                    yield ExtractedPage(i, text, "text" if text else "empty")
                    continue
                try:
                    res = fut.result()
                except Exception as exc:
                    log.warning("OCR failed on page %d: %s", i, exc)
                    yield ExtractedPage(i, text, "text" if text else "empty")
                    continue
                ocr_text = clean_text(res.text)
                # keep whichever is more informative; embedded garbage is replaced by OCR
                use_ocr = len(ocr_text) > len(text) or garbage_ratio(text) > GARBAGE_THRESHOLD
                if use_ocr and ocr_text:
                    yield ExtractedPage(i, ocr_text, "ocr", res.confidence)
                else:
                    yield ExtractedPage(i, text, "text" if text else "empty")

        for pno in range(start_at, last + 1):
            page = doc.load_page(pno - 1)
            text = clean_text(page.get_text("text", sort=True))
            png = None
            if ocr_ok and needs_ocr(text, min_chars, bool(page.get_images(full=False))):
                png = page.get_pixmap(dpi=dpi).tobytes("png")
            window.append((pno, text, png))
            if len(window) >= max(1, ocr_workers) * 2:
                yield from flush()
        yield from flush()
