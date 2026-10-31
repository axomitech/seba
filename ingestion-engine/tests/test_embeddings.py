"""HTTP-contract tests: a local stub server emulates each provider's documented response shape.
They prove request/response handling and dimension checks, NOT real model quality or live API access."""
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from seba_ingest.config import EMBEDDING_DIMENSIONS, Settings
from seba_ingest.embeddings.providers import (CloudflareEmbeddings, EmbeddingError, OllamaEmbeddings,
                                              OpenAICompatibleEmbeddings, get_provider)


def vec(seed: float, dim=EMBEDDING_DIMENSIONS):
    return [seed] * dim


@pytest.fixture()
def stub():
    state = {"dim": EMBEDDING_DIMENSIONS, "requests": []}

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a): pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            state["requests"].append((self.path, dict(self.headers), body))
            texts = body.get("text") or body.get("input")
            vs = [vec(i + 1.0, state["dim"]) for i in range(len(texts))]
            if self.path.endswith("/embeddings"):
                out = {"data": [{"index": i, "embedding": v} for i, v in reversed(list(enumerate(vs)))]}
            elif self.path.endswith("/api/embed"):
                out = {"embeddings": vs}
            else:
                out = {"result": {"shape": [len(vs), state["dim"]], "data": vs}, "success": True}
            raw = json.dumps(out).encode()
            self.send_response(200); self.send_header("Content-Length", str(len(raw))); self.end_headers(); self.wfile.write(raw)

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    state["base"] = f"http://127.0.0.1:{httpd.server_address[1]}"
    yield state
    httpd.shutdown()


def test_openai_compatible_orders_by_index_and_sends_auth(stub):
    p = OpenAICompatibleEmbeddings(stub["base"], "k", "bge-m3")
    out = p.embed(["a", "b"])
    assert out[0][0] == 1.0 and out[1][0] == 2.0
    path, headers, body = stub["requests"][0]
    assert headers["Authorization"] == "Bearer k" and body["model"] == "bge-m3"


def test_ollama(stub):
    assert len(OllamaEmbeddings(stub["base"], "bge-m3").embed(["a", "b", "c"])) == 3


def test_cloudflare_shape_and_secret_in_header_only(stub, monkeypatch):
    p = CloudflareEmbeddings("acct", "tok", "@cf/baai/bge-m3")
    monkeypatch.setattr(p, "_url", stub["base"] + "/accounts/acct/ai/run/@cf/baai/bge-m3")
    assert len(p.embed(["x"])[0]) == EMBEDDING_DIMENSIONS
    path, headers, body = stub["requests"][0]
    assert headers["Authorization"] == "Bearer tok" and "tok" not in path and body == {"text": ["x"]}


def test_wrong_dimension_is_rejected(stub):
    stub["dim"] = 768
    with pytest.raises(EmbeddingError, match="1024"):
        OllamaEmbeddings(stub["base"], "m").embed(["a"])


def test_provider_selection_and_required_credentials():
    assert get_provider(Settings(embedding_provider="none")) is None
    with pytest.raises(EmbeddingError):
        get_provider(Settings(embedding_provider="cloudflare"))
    with pytest.raises(EmbeddingError):
        get_provider(Settings(embedding_provider="nonsense"))


def test_secrets_not_in_settings_repr():
    r = repr(Settings(embedding_api_key="SECRET1", cloudflare_api_token="SECRET2"))
    assert "SECRET1" not in r and "SECRET2" not in r
