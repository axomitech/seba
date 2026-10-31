"""Configurable embedding providers. All must return EMBEDDING_DIMENSIONS-sized vectors.

  none        no embeddings; keyword/full-text search only (default)
  cloudflare  Workers AI REST API (default model @cf/baai/bge-m3, multilingual) - same model the
              Worker uses for query embeddings, so vectors are comparable
  openai      any OpenAI-compatible /embeddings endpoint (EMBEDDING_BASE_URL, EMBEDDING_API_KEY)
  ollama      local Ollama /api/embed (e.g. model 'bge-m3')
Groq is a chat provider and is intentionally not an option here.
"""
from __future__ import annotations

import logging
import time
from typing import Protocol

import requests

from ..config import EMBEDDING_DIMENSIONS, Settings

log = logging.getLogger(__name__)


class EmbeddingError(RuntimeError):
    pass


class EmbeddingProvider(Protocol):
    model: str

    def embed(self, texts: list[str]) -> list[list[float]]: ...


def _check(vectors: list[list[float]], n: int) -> list[list[float]]:
    if len(vectors) != n:
        raise EmbeddingError(f"provider returned {len(vectors)} vectors for {n} inputs")
    for v in vectors:
        if len(v) != EMBEDDING_DIMENSIONS:
            raise EmbeddingError(
                f"embedding has {len(v)} dimensions, database expects {EMBEDDING_DIMENSIONS}; "
                "choose a 1024-dim model or add a migration for a different dimension")
    return vectors


def _post(url: str, headers: dict, payload: dict, retries: int = 3) -> dict:
    last = ""
    for attempt in range(1, retries + 1):
        try:
            r = requests.post(url, headers=headers, json=payload, timeout=120)
        except requests.RequestException as exc:
            last = str(exc)
        else:
            if r.status_code == 200:
                return r.json()
            last = f"HTTP {r.status_code}: {r.text[:200]}"
            if r.status_code not in (429, 500, 502, 503, 504):
                break
        time.sleep(min(2 ** attempt, 20))
    raise EmbeddingError(f"embedding request failed: {last}")


class CloudflareEmbeddings:
    def __init__(self, account_id: str, api_token: str, model: str):
        if not account_id or not api_token:
            raise EmbeddingError("CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required")
        self.model = model
        self._url = f"https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/run/{model}"
        self._headers = {"Authorization": f"Bearer {api_token}"}

    def embed(self, texts: list[str]) -> list[list[float]]:
        body = _post(self._url, self._headers, {"text": texts})
        result = body.get("result", body)
        data = result.get("data") if isinstance(result, dict) else None
        if not isinstance(data, list):
            raise EmbeddingError("unexpected Workers AI response shape (no result.data)")
        return _check(data, len(texts))


class OpenAICompatibleEmbeddings:
    def __init__(self, base_url: str, api_key: str, model: str):
        if not base_url:
            raise EmbeddingError("EMBEDDING_BASE_URL is required")
        self.model = model
        self._url = base_url.rstrip("/") + "/embeddings"
        self._headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}

    def embed(self, texts: list[str]) -> list[list[float]]:
        body = _post(self._url, self._headers, {"model": self.model, "input": texts, "dimensions": EMBEDDING_DIMENSIONS})
        rows = sorted(body.get("data", []), key=lambda r: r.get("index", 0))
        return _check([r["embedding"] for r in rows], len(texts))


class OllamaEmbeddings:
    def __init__(self, base_url: str, model: str):
        self.model = model
        self._url = (base_url or "http://127.0.0.1:11434").rstrip("/") + "/api/embed"

    def embed(self, texts: list[str]) -> list[list[float]]:
        body = _post(self._url, {}, {"model": self.model, "input": texts})
        return _check(body.get("embeddings", []), len(texts))


def get_provider(s: Settings) -> EmbeddingProvider | None:
    p = s.embedding_provider
    if p in ("", "none"):
        return None
    if p == "cloudflare":
        return CloudflareEmbeddings(s.cloudflare_account_id, s.cloudflare_api_token, s.embedding_model)
    if p == "openai":
        return OpenAICompatibleEmbeddings(s.embedding_base_url, s.embedding_api_key, s.embedding_model)
    if p == "ollama":
        return OllamaEmbeddings(s.embedding_base_url, s.embedding_model)
    raise EmbeddingError(f"unknown EMBEDDING_PROVIDER {p!r}")
