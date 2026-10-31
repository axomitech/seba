from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class CatalogueEntry:
    """One row of the official catalogue, normalised but with the original URL kept verbatim."""
    serial: int | None
    title: str
    class_label: str          # 'IX' | 'X' | 'IX-X'
    medium: str               # as printed, whitespace-collapsed
    subject: str              # cleaned display name
    subject_type: str | None
    url: str | None           # href exactly as published (None when the row has no link)
    url_kind: str             # 'pdf' | 'archive' | 'html' | 'other' | 'none'
    discovered_from: str

    @property
    def grade_range(self) -> tuple[int, int]:
        return {"IX": (9, 9), "X": (10, 10), "IX-X": (9, 10)}[self.class_label]
