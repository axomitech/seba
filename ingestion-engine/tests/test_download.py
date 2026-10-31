import pytest

from conftest import make_pdf
from seba_ingest.downloader.download import InvalidPdfError, download_pdf, local_name, sha256_file, validate_pdf
from seba_ingest.downloader.safe_http import DownloadError


@pytest.fixture()
def pdf_bytes(tmp_path):
    return make_pdf(tmp_path / "src.pdf").read_bytes()


def test_download_validates_and_hashes(server, session, tmp_path, pdf_bytes):
    url = server.put("/book.pdf", pdf_bytes)
    res = download_pdf(session, url, tmp_path / "dl", 10_000_000)
    assert res.path.is_file() and res.page_count == 3 and res.size == len(pdf_bytes)
    assert res.sha256 == sha256_file(res.path) and res.etag
    assert not list((tmp_path / "dl").glob("*.part"))


def test_conditional_request_skips_unchanged_file(server, session, tmp_path, pdf_bytes):
    url = server.put("/book.pdf", pdf_bytes)
    first = download_pdf(session, url, tmp_path / "dl", 10_000_000)
    again = download_pdf(session, url, tmp_path / "dl", 10_000_000, etag=first.etag,
                         last_modified=first.last_modified, existing=first.path)
    assert again.not_modified and again.path == first.path


def test_changed_file_is_refetched(server, session, tmp_path, pdf_bytes):
    url = server.put("/book.pdf", pdf_bytes)
    first = download_pdf(session, url, tmp_path / "dl", 10_000_000)
    new = make_pdf(tmp_path / "new.pdf", pages=["changed edition"]).read_bytes()
    server.put("/book.pdf", new)
    res = download_pdf(session, url, tmp_path / "dl", 10_000_000, etag=first.etag, existing=first.path)
    assert not res.not_modified and res.sha256 != first.sha256 and res.page_count == 1


def test_interrupted_download_resumes_with_range(server, session, tmp_path):
    pdf_bytes = make_pdf(tmp_path / "big.pdf", pages=[("lorem ipsum %d " % i) * 60 for i in range(400)]).read_bytes()
    assert len(pdf_bytes) > 150_000  # must exceed urllib3's 64 KB read size so partial data is written
    url = server.put("/book.pdf", pdf_bytes)
    server.truncate.add("/book.pdf")
    with pytest.raises(DownloadError, match="incomplete"):
        download_pdf(session, url, tmp_path / "dl", 10_000_000)
    part = next((tmp_path / "dl").glob("*.part"))
    assert 0 < part.stat().st_size < len(pdf_bytes)
    server.truncate.clear()
    res = download_pdf(session, url, tmp_path / "dl", 10_000_000)
    assert res.sha256 == __import__("hashlib").sha256(pdf_bytes).hexdigest()
    assert any(h.get("Range") for _, h in server.hits), "second attempt should have sent a Range header"


def test_html_error_page_is_rejected(server, session, tmp_path):
    url = server.put("/book.pdf", b"<html>403 forbidden</html>", type="text/html")
    with pytest.raises(InvalidPdfError, match="HTML"):
        download_pdf(session, url, tmp_path / "dl", 10_000_000)


def test_non_pdf_bytes_with_pdf_mime_are_rejected(server, session, tmp_path):
    url = server.put("/book.pdf", b"PK\x03\x04 this is a zip, not a pdf")
    with pytest.raises(InvalidPdfError, match="%PDF"):
        download_pdf(session, url, tmp_path / "dl", 10_000_000)
    assert not list((tmp_path / "dl").glob("*"))


def test_size_limit_enforced(server, session, tmp_path, pdf_bytes):
    url = server.put("/book.pdf", pdf_bytes)
    with pytest.raises(DownloadError, match="exceeds limit"):
        download_pdf(session, url, tmp_path / "dl", 100)


def test_corrupt_pdf_rejected(tmp_path):
    bad = tmp_path / "bad.pdf"
    bad.write_bytes(b"%PDF-1.7\nthis is not really a pdf")
    with pytest.raises(InvalidPdfError):
        validate_pdf(bad)


def test_local_name_is_stable_and_safe():
    n = local_name("https://www.sebaonline.org/textbooks/a b/Charukalar Rengani_IX&X.pdf")
    assert n == local_name("https://www.sebaonline.org/textbooks/a b/Charukalar Rengani_IX&X.pdf")
    assert "/" not in n and " " not in n and "&" not in n
