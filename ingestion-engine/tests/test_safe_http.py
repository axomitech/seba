import pytest

from seba_ingest.downloader.safe_http import DownloadError, SafeSession, UnsafeUrlError, UrlPolicy

PROD = UrlPolicy(allowed_domains=("sebaonline.org",))


@pytest.mark.parametrize("url", [
    "http://www.sebaonline.org/x.pdf",                  # plain http
    "ftp://www.sebaonline.org/x.pdf",
    "https://evil.example.com/x.pdf",                   # not allowlisted
    "https://sebaonline.org.evil.example.com/x.pdf",    # suffix trick
    "https://notsebaonline.org/x.pdf",
    "https://user:pw@www.sebaonline.org/x.pdf",         # credentials
    "https://169.254.169.254/latest/meta-data/",        # cloud metadata
    "https://localhost/x", "https://[::1]/x",
    "file:///etc/passwd",
])
def test_policy_rejects(url):
    with pytest.raises(UnsafeUrlError):
        PROD.check(url)


def test_policy_accepts_official_hosts_only_if_public(monkeypatch):
    import socket
    monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **k: [(2, 1, 6, "", ("203.0.113.9", 443))])
    # 203.0.113.0/24 is documentation space (not global) -> rejected even on an allowlisted host (DNS-pinning defence)
    with pytest.raises(UnsafeUrlError):
        PROD.check("https://www.sebaonline.org/a.pdf")
    monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **k: [(2, 1, 6, "", ("8.8.8.8", 443))])
    PROD.check("https://www.sebaonline.org/a.pdf")
    PROD.check("https://site.sebaonline.org/a.pdf")


def test_private_address_blocked_even_for_allowlisted_name(server):
    pol = UrlPolicy(allowed_domains=("127.0.0.1",), insecure_hosts=("127.0.0.1",))
    with pytest.raises(UnsafeUrlError, match="non-public"):
        pol.check(server.base + "/x")


def test_redirect_to_disallowed_host_is_blocked(server, session):
    with pytest.raises(UnsafeUrlError):
        session.request("GET", server.base + "/redirect?to=http://169.254.169.254/latest/meta-data/")


def test_redirect_loop_is_bounded(server, session):
    with pytest.raises(DownloadError, match="too many redirects"):
        session.request("GET", server.base + "/loop")
