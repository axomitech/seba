import pytest

from seba_ingest.discovery.normalize import (catalogue_key, classify_url, clean_subject, collapse_ws,
                                             language_code, normalize_class, subject_key)


@pytest.mark.parametrize("raw,exp", [("IX", "IX"), ("X", "X"), (" ix ", "IX"), ("IX-X", "IX-X"), ("IX & X", "IX-X"),
                                     ("Class 10", "X"), ("9", "IX"), ("XI", None), ("", None)])
def test_normalize_class(raw, exp):
    assert normalize_class(raw) == exp


def test_subject_variants_share_a_key():
    variants = ["AGRICULTURE &    HORTICULTURE NSQF ( E)", "AGRICULTURE & HORTICULTURE", "Agriculture & Horticulture NSQF (E)"]
    assert len({subject_key(v) for v in variants}) == 1
    assert subject_key("ASSAMESE (E)") == subject_key("Assamese (E)") == subject_key("Assamese  ( E)")
    assert subject_key("Assamese MIL") != subject_key("Assamese (E)")  # different subjects stay different


def test_clean_subject():
    assert clean_subject("SOCIAL SCIENCE") == "Social Science"
    assert clean_subject("COMMERCE (E )") == "Commerce"
    assert clean_subject("IT/ITeS NSQF ( E)") == "IT/ITeS"
    assert clean_subject("General Mathematics") == "General Mathematics"


def test_language_code_and_whitespace():
    assert language_code("HINDI") == language_code(" Hindi ") == "hindi"
    assert collapse_ws("a \xa0 b\n c") == "a b c"


@pytest.mark.parametrize("url,kind", [("https://x.org/a/b.PDF", "pdf"), ("https://x.org/a/b.rar", "archive"),
                                      ("https://x.org/textbooks/class-10/", "html"), ("https://x.org/a/b", "other"),
                                      (None, "none"), ("", "none")])
def test_classify_url(url, kind):
    assert classify_url(url) == kind


def test_catalogue_key_is_stable_and_discriminating():
    a = catalogue_key("Beehive", "IX", "All", "English", "Core", "https://x/y.pdf")
    assert a == catalogue_key(" Beehive ", "IX", "ALL", "ENGLISH (E)", "core", "https://x/y.pdf")
    assert a != catalogue_key("Beehive", "X", "All", "English", "Core", "https://x/y.pdf")
