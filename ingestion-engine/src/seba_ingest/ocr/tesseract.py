"""Tesseract OCR via the CLI (no Python binding needed)."""
from __future__ import annotations

import functools
import logging
import shutil
import subprocess
from dataclasses import dataclass

log = logging.getLogger(__name__)


class OcrUnavailable(RuntimeError):
    pass


@dataclass
class OcrResult:
    text: str
    confidence: float | None  # mean word confidence 0-100, None if unknown


@functools.lru_cache(maxsize=1)
def installed_languages() -> frozenset[str]:
    exe = shutil.which("tesseract")
    if not exe:
        return frozenset()
    out = subprocess.run([exe, "--list-langs"], capture_output=True, text=True, timeout=20)
    return frozenset(line.strip() for line in out.stdout.splitlines()[1:] if line.strip())


def resolve_languages(requested: str) -> str:
    """Keep only installed language packs; fall back to eng; raise if tesseract is missing."""
    have = installed_languages()
    if not have:
        raise OcrUnavailable("tesseract binary not found or has no language data")
    wanted = [l for l in requested.split("+") if l in have]
    if len(wanted) != len(requested.split("+")):
        missing = set(requested.split("+")) - set(wanted)
        log.warning("tesseract language packs missing: %s (install tesseract-ocr-<code>)", ",".join(sorted(missing)))
    return "+".join(wanted) if wanted else ("eng" if "eng" in have else sorted(have)[0])


def ocr_png(png: bytes, languages: str, timeout: float = 120.0) -> OcrResult:
    """OCR one PNG image. Uses TSV output to compute a mean confidence."""
    exe = shutil.which("tesseract")
    if not exe:
        raise OcrUnavailable("tesseract binary not found")
    proc = subprocess.run([exe, "stdin", "stdout", "-l", languages, "--psm", "3", "tsv"],
                          input=png, capture_output=True, timeout=timeout)
    if proc.returncode != 0:
        raise RuntimeError(f"tesseract failed: {proc.stderr.decode(errors='replace')[:300]}")
    return parse_tsv(proc.stdout.decode("utf8", errors="replace"))


def parse_tsv(tsv: str) -> OcrResult:
    lines: dict[tuple[str, str, str], list[str]] = {}
    confs: list[float] = []
    for row in tsv.splitlines()[1:]:
        cols = row.split("\t")
        if len(cols) < 12 or cols[0] != "5":  # level 5 = word
            continue
        word = cols[11].strip()
        if not word:
            continue
        lines.setdefault((cols[2], cols[3], cols[4]), []).append(word)
        try:
            c = float(cols[10])
            if c >= 0:
                confs.append(c)
        except ValueError:
            pass
    # group lines into blocks (block, paragraph) so paragraphs stay separated by a blank line
    out: list[str] = []
    last_par = None
    for (block, par, _line), words in lines.items():
        if last_par is not None and (block, par) != last_par:
            out.append("")
        out.append(" ".join(words))
        last_par = (block, par)
    return OcrResult(text="\n".join(out).strip(), confidence=sum(confs) / len(confs) if confs else None)
