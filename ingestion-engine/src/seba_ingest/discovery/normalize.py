"""Normalisation of free-text catalogue fields. Pure functions, unit tested."""
from __future__ import annotations

import hashlib
import re
from urllib.parse import urlsplit

_WS = re.compile(r"\s+")
# markers that carry no subject meaning: "(E)" = elective flag, "NSQF"/"NSFQ" (typo on the site)
_SUBJECT_NOISE = re.compile(r"\(\s*e\s*\)|\bnsqf\b|\bnsfq\b", re.I)
_ACRONYM_FIXES = {"it/ites": "IT/ITeS", "ai": "AI", "mil": "MIL"}


def collapse_ws(text: str) -> str:
    return _WS.sub(" ", text.replace("\xa0", " ")).strip()


def normalize_class(raw: str) -> str | None:
    s = collapse_ws(raw).upper().replace("CLASS", "").strip()
    s = re.sub(r"\s*(&|AND|,|/|–|—|-)\s*", "-", s)
    return {"IX": "IX", "9": "IX", "X": "X", "10": "X", "IX-X": "IX-X", "9-10": "IX-X"}.get(s)


def subject_key(raw: str) -> str:
    cleaned = _SUBJECT_NOISE.sub(" ", raw.lower())
    cleaned = re.sub(r"[()]", " ", cleaned)
    return collapse_ws(cleaned)


def clean_subject(raw: str) -> str:
    """Display name: noise markers removed, whitespace collapsed, ALL-CAPS title-cased."""
    cleaned = collapse_ws(re.sub(r"\(\s*\)", "", _SUBJECT_NOISE.sub(" ", raw)))
    if cleaned.isupper() or cleaned.islower():
        cleaned = cleaned.title()
    words = [(_ACRONYM_FIXES.get(w.lower(), w)) for w in cleaned.split(" ")]
    return " ".join(words)


def language_code(medium: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", collapse_ws(medium).lower()).strip("-")


def classify_url(url: str | None) -> str:
    if not url:
        return "none"
    path = urlsplit(url).path.lower()
    if path.endswith(".pdf"):
        return "pdf"
    if path.endswith((".rar", ".zip", ".7z")):
        return "archive"
    if path.endswith(("/", ".htm", ".html", ".php", ".aspx")):
        return "html"
    return "other"


def catalogue_key(title: str, class_label: str, medium: str, subject: str,
                  subject_type: str | None, url: str | None) -> str:
    parts = [collapse_ws(title).lower(), class_label, collapse_ws(medium).lower(),
             subject_key(subject), (subject_type or "").lower(), url or ""]
    return hashlib.sha1("|".join(parts).encode("utf8")).hexdigest()
