import shutil

import pytest

from conftest import LOREM, make_pdf
from seba_ingest.extraction.pdf import garbage_ratio, iter_pages, needs_ocr, printed_page_candidates

MOJIBAKE = "¸1˘ ’¸˜œ˚˛± ¸±ø˝Ó¡… ¡ÛÀÏ¡ˇ±“ ’±˝±“ ﬂ¡˘ ‡1˜ ·“Î¡ˇ ‚È¡ﬂ¡ ‰¡‡ ÂÈƒ¡Ù¡Èƒ Ê“ﬂ¡ Á¡1 È¡Ú Í¡· Ï¡— Ó¡˘ Ô1"
needs_tesseract = pytest.mark.skipif(not shutil.which("tesseract"), reason="tesseract not installed")


def test_garbage_detection_separates_legacy_font_text_from_normal_text():
    assert garbage_ratio(MOJIBAKE) > 0.3
    assert garbage_ratio(LOREM) == 0
    assert garbage_ratio("সৰল অসমীয়া সাহিত্য") == 0           # real Unicode Assamese is fine
    assert garbage_ratio("25° C, 3 × 4 ÷ 2 = 6, ± 0.5, x²") < 0.12   # normal maths/science symbols
    assert garbage_ratio("�� text") > 0.4


def test_needs_ocr_rules():
    assert needs_ocr("", 40, has_images=False)
    assert needs_ocr("12", 40, has_images=True)
    assert not needs_ocr("Fig. 1", 40, has_images=False)      # short caption page without images
    assert not needs_ocr(LOREM, 40, has_images=True)
    assert needs_ocr(MOJIBAKE * 3, 40, has_images=False)


def test_text_pdf_uses_embedded_text(tmp_path):
    pdf = make_pdf(tmp_path / "t.pdf")
    pages = list(iter_pages(pdf, ocr_enabled=True, ocr_languages="eng", dpi=150, min_chars=40))
    assert [p.index for p in pages] == [1, 2, 3]
    assert all(p.method == "text" and "photosynthesis" in p.text for p in pages)


@needs_tesseract
def test_scanned_page_is_ocrd_with_real_tesseract(tmp_path):
    pdf = make_pdf(tmp_path / "scan.pdf", pages=["x", "y"], image_pages={2: "Photosynthesis converts light energy into chemical energy in green plants."})
    pages = list(iter_pages(pdf, ocr_enabled=True, ocr_languages="eng", dpi=200, min_chars=40))
    scanned = pages[1]
    assert scanned.method == "ocr" and scanned.ocr_confidence and scanned.ocr_confidence > 60
    assert "photosynthesis" in scanned.text.lower() and "green plants" in scanned.text.lower()


def test_ocr_disabled_leaves_scanned_page_empty(tmp_path):
    pdf = make_pdf(tmp_path / "scan.pdf", pages=["x", "y"], image_pages={2: "some scanned words here"})
    pages = list(iter_pages(pdf, ocr_enabled=False, ocr_languages="eng", dpi=150, min_chars=40))
    assert pages[1].method == "empty" and pages[1].text == ""


def test_resume_start_and_max_pages(tmp_path):
    pdf = make_pdf(tmp_path / "t.pdf", pages=[f"p{i} {LOREM}" for i in range(1, 8)])
    pages = list(iter_pages(pdf, ocr_enabled=False, ocr_languages="eng", dpi=100, min_chars=40, start_at=4, max_pages=2))
    assert [p.index for p in pages] == [4, 5]


def test_printed_page_numbers_follow_dominant_offset_only():
    texts = [f"body text {i}\n{i - 2}" if i > 2 else "cover" for i in range(1, 12)]   # printed = index - 2
    texts[5] = "some text\n999"                                                      # stray number: must be ignored
    labels = printed_page_candidates(texts)
    assert labels[3] == "1" and labels[10] == "8" and 6 not in labels
    assert printed_page_candidates(["a", "b", "7"]) == {}                            # not enough evidence


def test_printed_page_in_running_header_and_unicode_digits():
    assert printed_page_candidates(["x", "x", "x"]) == {}
    hdr = [f"{n} Saral Sahitya\nbody" for n in range(5, 12)]
    assert printed_page_candidates(hdr)[1] == "5"
    assert printed_page_candidates([f"৩{d} সৰল অসমীয়া\nbody" for d in "0123456"])[1] == "30"
