"""Environment-driven configuration. No secrets have defaults."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parents[2]  # ingestion-engine/
REPO_ROOT = PACKAGE_ROOT.parent
EMBEDDING_DIMENSIONS = 1024  # must match textbook_embeddings.embedding vector(1024)


def load_dotenv(path: Path) -> None:
    """Minimal .env loader; real environment variables win."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key.strip(), value)


def _bool(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    return default if raw is None else raw.strip().lower() in {"1", "true", "yes", "on"}


@dataclass
class Settings:
    database_url: str = ""
    catalogue_url: str = "https://site.sebaonline.org/textbook"
    # Hosts we are willing to fetch from. Matched as exact host or subdomain.
    allowed_hosts: tuple[str, ...] = ("sebaonline.org",)
    # Public CA certificates appended to the system trust store. SEBA's servers omit
    # their intermediate certificate, so the Sectigo intermediate is shipped in certs/.
    extra_ca_files: tuple[Path, ...] = (PACKAGE_ROOT / "certs" / "sectigo-dv-r36-intermediate.pem",)
    download_dir: Path = PACKAGE_ROOT / "downloads"
    migrations_dir: Path = REPO_ROOT / "database" / "migrations"
    seeders_dir: Path = REPO_ROOT / "database" / "seeders"
    max_pdf_bytes: int = 300 * 1024 * 1024
    request_delay: float = 1.0
    http_timeout: float = 60.0
    user_agent: str = "seba-textbook-ingest/0.1 (+educational indexing; contact: repo owner)"
    ocr_enabled: bool = True
    ocr_dpi: int = 200
    ocr_min_chars: int = 40
    ocr_workers: int = 2
    chunk_target_chars: int = 1200
    chunk_overlap_chars: int = 150
    embedding_provider: str = "none"
    embedding_model: str = "@cf/baai/bge-m3"
    embedding_batch: int = 16
    embedding_base_url: str = ""
    embedding_api_key: str = field(default="", repr=False)
    cloudflare_account_id: str = ""
    cloudflare_api_token: str = field(default="", repr=False)

    @classmethod
    def from_env(cls) -> "Settings":
        load_dotenv(PACKAGE_ROOT / ".env")
        e = os.environ.get
        extra = e("SEBA_EXTRA_CA_FILES")
        s = cls(
            database_url=e("DATABASE_URL", ""),
            catalogue_url=e("SEBA_CATALOGUE_URL", cls.catalogue_url),
            download_dir=Path(e("DOWNLOAD_DIR", str(PACKAGE_ROOT / "downloads"))).expanduser().resolve(),
            max_pdf_bytes=int(float(e("MAX_PDF_MB", "300")) * 1024 * 1024),
            request_delay=float(e("REQUEST_DELAY_SECONDS", "1.0")),
            ocr_enabled=_bool("OCR_ENABLED", True),
            ocr_dpi=int(e("OCR_DPI", "200")),
            ocr_min_chars=int(e("OCR_MIN_CHARS", "40")),
            embedding_provider=e("EMBEDDING_PROVIDER", "none").lower(),
            embedding_model=e("EMBEDDING_MODEL", "@cf/baai/bge-m3"),
            embedding_base_url=e("EMBEDDING_BASE_URL", ""),
            embedding_api_key=e("EMBEDDING_API_KEY", ""),
            cloudflare_account_id=e("CLOUDFLARE_ACCOUNT_ID", ""),
            cloudflare_api_token=e("CLOUDFLARE_API_TOKEN", ""),
        )
        if extra is not None:
            s.extra_ca_files = tuple(Path(p) for p in extra.split(os.pathsep) if p)
        return s
