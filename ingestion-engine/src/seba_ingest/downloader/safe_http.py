"""SSRF-resistant HTTP client for fetching catalogue pages and PDFs.

Rules enforced on the initial URL *and on every redirect hop*:
  * https only (http only for hosts explicitly listed in `insecure_hosts`, used by tests)
  * host must equal or be a subdomain of an allowlisted domain
  * every resolved address must be globally routable (no loopback / private / link-local / metadata)
  * redirects are followed manually, max 5 hops
TLS verification is always on. SEBA's servers omit their intermediate certificate, so the
public Sectigo intermediate shipped in certs/ is appended to the trust store (never `verify=False`).
"""
from __future__ import annotations

import hashlib
import ipaddress
import logging
import socket
import tempfile
import time
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urljoin, urlsplit

import requests

from ..config import Settings

log = logging.getLogger(__name__)


class UnsafeUrlError(ValueError):
    pass


class DownloadError(RuntimeError):
    pass


@dataclass
class UrlPolicy:
    allowed_domains: tuple[str, ...]
    insecure_hosts: tuple[str, ...] = ()     # tests only: plain-http hosts allowed (still IP-checked unless below)
    allow_private_for: tuple[str, ...] = ()  # tests only: hosts exempt from the private-address check
    max_redirects: int = 5

    def check(self, url: str) -> None:
        parts = urlsplit(url)
        host = (parts.hostname or "").lower()
        if parts.scheme != "https" and not (parts.scheme == "http" and host in self.insecure_hosts):
            raise UnsafeUrlError(f"scheme not allowed: {parts.scheme!r}")
        if parts.username or parts.password:
            raise UnsafeUrlError("credentials in URL are not allowed")
        if not host or not any(host == d or host.endswith("." + d) for d in self.allowed_domains) \
                and host not in self.insecure_hosts:
            raise UnsafeUrlError(f"host not in allowlist: {host!r}")
        if host in self.allow_private_for:
            return
        try:
            infos = socket.getaddrinfo(host, parts.port or (443 if parts.scheme == "https" else 80),
                                       proto=socket.IPPROTO_TCP)
        except socket.gaierror as exc:
            raise UnsafeUrlError(f"cannot resolve {host!r}: {exc}") from exc
        for info in infos:
            ip = ipaddress.ip_address(info[4][0])
            if not ip.is_global:
                raise UnsafeUrlError(f"{host!r} resolves to non-public address {ip}")


def build_ca_bundle(settings: Settings) -> str | bool:
    """System trust store + extra public CA certs -> a bundle file path (or True if none extra)."""
    extras = [p for p in settings.extra_ca_files if p.is_file()]
    if not extras:
        return True
    import certifi  # shipped with requests
    digest = hashlib.sha1("|".join(map(str, extras)).encode()).hexdigest()[:10]
    bundle = Path(tempfile.gettempdir()) / f"seba-ca-bundle-{digest}.pem"
    system = Path("/etc/ssl/certs/ca-certificates.crt")
    base = system.read_text() if system.is_file() else Path(certifi.where()).read_text()
    bundle.write_text(base + "\n" + "\n".join(p.read_text() for p in extras))
    return str(bundle)


@dataclass
class SafeSession:
    policy: UrlPolicy
    verify: str | bool = True
    user_agent: str = "seba-ingest"
    timeout: float = 60.0
    delay: float = 0.0
    retries: int = 3
    _session: requests.Session = field(default_factory=requests.Session, init=False, repr=False)
    _last: float = field(default=0.0, init=False, repr=False)

    @classmethod
    def from_settings(cls, s: Settings) -> "SafeSession":
        return cls(policy=UrlPolicy(allowed_domains=s.allowed_hosts), verify=build_ca_bundle(s),
                   user_agent=s.user_agent, timeout=s.http_timeout, delay=s.request_delay)

    def request(self, method: str, url: str, headers: dict[str, str] | None = None, stream: bool = False) -> requests.Response:
        hdrs = {"User-Agent": self.user_agent, "Accept-Encoding": "identity", **(headers or {})}
        last_exc: Exception | None = None
        for attempt in range(1, self.retries + 1):
            try:
                return self._follow(method, url, hdrs, stream)
            except (requests.ConnectionError, requests.Timeout) as exc:
                last_exc = exc
                log.warning("%s %s failed (attempt %d/%d): %s", method, url, attempt, self.retries, exc)
                time.sleep(min(2 ** attempt, 15))
            except _Retryable as exc:
                last_exc = exc
                time.sleep(min(2 ** attempt, 15))
        raise DownloadError(f"{method} {url} failed after {self.retries} attempts: {last_exc}")

    def _follow(self, method: str, url: str, headers: dict[str, str], stream: bool) -> requests.Response:
        for _ in range(self.policy.max_redirects + 1):
            self.policy.check(url)
            wait = self.delay - (time.monotonic() - self._last)
            if wait > 0:
                time.sleep(wait)
            resp = self._session.request(method, url, headers=headers, stream=stream, allow_redirects=False,
                                         timeout=self.timeout, verify=self.verify)
            self._last = time.monotonic()
            if resp.is_redirect or resp.status_code in (301, 302, 303, 307, 308):
                loc = resp.headers.get("Location")
                resp.close()
                if not loc:
                    raise DownloadError(f"redirect without Location from {url}")
                url = urljoin(url, loc)
                continue
            if resp.status_code in (429, 500, 502, 503, 504):
                resp.close()
                raise _Retryable(f"HTTP {resp.status_code}")
            return resp
        raise DownloadError("too many redirects")

    def get_text(self, url: str) -> str:
        resp = self.request("GET", url)
        try:
            if resp.status_code != 200:
                raise DownloadError(f"GET {url} -> HTTP {resp.status_code}")
            if resp.encoding is None or resp.encoding.lower() == "iso-8859-1":
                resp.encoding = resp.apparent_encoding or "utf-8"
            return resp.text
        finally:
            resp.close()


class _Retryable(Exception):
    pass
