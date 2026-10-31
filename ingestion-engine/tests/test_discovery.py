from pathlib import Path

from seba_ingest.discovery.seba_table import SebaCatalogueAdapter, discover_catalogue, map_headers

FIX = Path(__file__).parent / "fixtures"
WRAPPER_URL = "https://site.sebaonline.org/textbook"
FRAME_URL = "https://www.sebaonline.org/textbooks/textbooks.htm"


def fake_fetch(url: str) -> str:
    return {WRAPPER_URL: (FIX / "seba_catalogue_wrapper.html").read_text(encoding="utf8"),
            FRAME_URL: (FIX / "seba_catalogue_frame.html").read_text(encoding="utf8")}[url]


def by_serial(entries):
    return {e.serial: e for e in entries}


def test_follows_iframe_and_parses_real_catalogue_rows():
    entries = discover_catalogue(WRAPPER_URL, fake_fetch)
    # 7 distinct rows + the Footprints row listed twice on the real site -> deduplicated to one
    assert len(entries) == 8
    e = by_serial(entries)
    beehive = e[1]
    assert (beehive.title, beehive.class_label, beehive.medium, beehive.subject, beehive.subject_type) == \
        ("Beehive", "IX", "All", "English", "Core")
    assert beehive.url == "https://site.sebaonline.org/textbooks/class-9/English_Beehive%20Class%20IX.pdf"
    assert beehive.url_kind == "pdf" and beehive.discovered_from == FRAME_URL


def test_irregular_rows_are_represented_honestly():
    e = by_serial(discover_catalogue(WRAPPER_URL, fake_fetch))
    assert e[10].url is None and e[10].url_kind == "none"          # empty href="" on the live site
    assert e[135].url_kind == "html"                                # links to a directory listing, not a PDF
    rar = e[159]
    assert rar.url_kind == "archive" and rar.class_label == "IX-X" and " " in rar.url  # original URL preserved verbatim
    assert e[256].medium == "GARO"
    assert e[10].title == "General Science Class IX"                # internal whitespace collapsed


def test_column_order_is_not_assumed():
    html = """<table><tr><th>Download</th><th>Subject Name</th><th>Class</th><th>Name of the Textbook</th>
             <th>Medium</th><th>Subject Type</th><th>Sl. No.</th></tr>
             <tr><td><a href="/b.pdf">x</a></td><td>PHYSICS</td><td>X</td><td>Bhautik</td><td>Hindi</td><td>Core</td><td>7</td></tr></table>"""
    soup = __import__("bs4").BeautifulSoup(html, "html.parser")
    [e] = SebaCatalogueAdapter().parse_tables(soup, "https://www.sebaonline.org/p/")
    assert (e.serial, e.title, e.class_label, e.medium, e.subject, e.subject_type) == (7, "Bhautik", "X", "Hindi", "Physics", "Core")
    assert e.url == "https://www.sebaonline.org/b.pdf"


def test_header_mapping_prefers_subject_type_over_subject():
    m = map_headers(["Sl. No.", "Name of the Textbook", "Class", "Medium", "Subject Name", "Subject Type", "Download"])
    assert m == {"serial": 0, "title": 1, "class": 2, "medium": 3, "subject": 4, "subject_type": 5, "download": 6}


def test_inline_catalogue_without_iframe_still_parses():
    entries = SebaCatalogueAdapter().discover(FRAME_URL, lambda u: fake_fetch(FRAME_URL))
    assert len(entries) == 9  # raw rows, dedup happens in discover_catalogue


def test_unknown_layout_yields_no_rows_instead_of_garbage():
    assert SebaCatalogueAdapter().discover("https://x/", lambda u: "<html><table><tr><td>hello</td></tr></table></html>") == []
