from conftest import LOREM, make_pdf
from seba_ingest.chapter_parser.parser import (chapter_for_page, from_headings, from_toc, identify_chapters,
                                               plausible_title)


def test_toc_chapters_with_page_ranges_and_numbers(tmp_path):
    pages = [LOREM] * 12
    toc = [[1, "Contents", 2], [1, "Chapter 1 Matter in Our Surroundings", 3], [1, "Chapter 2 Is Matter Pure?", 7],
           [2, "2.1 Mixtures", 8], [1, "3. Atoms and Molecules", 10]]
    spans = identify_chapters(make_pdf(tmp_path / "b.pdf", pages, toc=toc), pages)
    assert [(s.title, s.start_page, s.end_page, s.chapter_number, s.method) for s in spans] == [
        ("Chapter 1 Matter in Our Surroundings", 3, 6, "1", "toc"),
        ("Chapter 2 Is Matter Pure?", 7, 9, "2", "toc"),
        ("3. Atoms and Molecules", 10, 12, "3", "toc")]
    assert [s.ordinal for s in spans] == [1, 2, 3]
    assert chapter_for_page(spans, 8).ordinal == 2 and chapter_for_page(spans, 1) is None


def test_file_name_bookmarks_are_not_chapters(tmp_path):
    # real example from a SEBA PDF: the outline only holds typesetting file names
    toc = [[1, "Cover pages_saral asomiya sahitya_IX_Final", 1], [1, "Saral Azomia Sahitya_Bhag_1_Class_IX_Inside_72 Page_Final", 2]]
    assert not plausible_title(toc[1][1]) and not plausible_title("Blank Page")
    assert identify_chapters(make_pdf(tmp_path / "b.pdf", [LOREM] * 4, toc=toc), [LOREM] * 4) == []


def test_heading_fallback_english_and_indic():
    texts = ["Cover", "Contents\nChapter 1 ........ 3\nChapter 2 ........ 9", "Chapter 1\nLight\nbody", "body", "body",
             "CHAPTER 2: Sound\nbody", "body", "Unit 3 Heat\nbody"]
    spans = from_headings(texts)
    assert [(s.chapter_number, s.start_page, s.end_page) for s in spans] == [("1", 3, 5), ("2", 6, 7), ("3", 8, 8)]
    assert spans[0].title.startswith("Chapter 1") and "Light" in spans[0].title
    assert spans[0].method == "heading"
    indic = from_headings(["পাঠ-১ অকণমানি\nbody", "body", "পাঠ-২ শংকৰদেৱ\nbody"])
    assert [s.chapter_number for s in indic] == ["১", "২"]


def test_no_chapters_is_an_honest_empty_result():
    assert from_headings(["just prose", "more prose", "Chapter 1 only one"]) == []
    assert from_toc([[1, "Only one", 1]], 10) == []
