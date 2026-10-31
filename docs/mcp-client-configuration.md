# Connecting MCP clients

Endpoint: `https://<worker>.<account-subdomain>.workers.dev/mcp` (Streamable HTTP, stateless). Local: `http://localhost:8788/mcp`.
With `AUTH_MODE=required` (default) every request needs `Authorization: Bearer <MCP_AUTH_TOKEN>`.

> Client configuration formats change between releases; the snippets below follow each client's documented remote-server options at the time of writing but were **not tested here** against those clients (only against the official TypeScript MCP client and MCP Inspector's protocol). Check your client's current MCP documentation if a field name differs.

## MCP Inspector

```bash
npx @modelcontextprotocol/inspector@latest
```

Transport **Streamable HTTP** → URL → *Authentication/Headers*: `Authorization: Bearer <token>` → Connect.

## Claude Code

```bash
claude mcp add --transport http seba-textbooks https://<worker>.workers.dev/mcp --header "Authorization: Bearer <token>"
claude mcp list
```

Then ask, e.g., *"Using seba-textbooks, find the laws of reflection in the Class IX science book and cite pages."*

## Clients that read a JSON config (Cursor, VS Code, Claude Desktop via `mcp-remote`)

```jsonc
{
  "mcpServers": {
    "seba-textbooks": {
      "url": "https://<worker>.workers.dev/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

Clients that only speak stdio can bridge with `npx mcp-remote https://<worker>.workers.dev/mcp --header "Authorization: Bearer <token>"`.
Keep tokens out of committed config files (use your client's secret/env-substitution feature).

## claude.ai / Claude Desktop "custom connectors"

These remote-connector UIs, to our knowledge, authenticate with OAuth or no authentication rather than a static bearer header; **check the current Claude documentation**. Options:

- Use one of the header-capable clients above (recommended for a private deployment); or
- Deploy with `AUTH_MODE=none` only if you are comfortable with a public, read-only, **excerpt-only** service (`CONTENT_EXPOSURE=excerpt`), accepting that anyone can query it (rate limits still apply); or
- Add OAuth in front of the Worker (Cloudflare's `workers-oauth-provider`). Not implemented here.

## Groq remote MCP (optional)

Groq can call this server itself via the Responses API (beta, HTTPS only, requires a publicly reachable `/mcp`):

```json
{ "model": "llama-3.3-70b-versatile", "input": "…",
  "tools": [{ "type": "mcp", "server_label": "seba", "server_url": "https://<worker>.workers.dev/mcp",
              "headers": { "Authorization": "Bearer <token>" }, "require_approval": "never",
              "allowed_tools": ["search_textbook_content", "get_page_content", "get_chapter_content"] }] }
```

`GroqService.respondWithRemoteMcp` builds this request. Note Groq's warning that the MCP server can see the whole request context. The built-in `/api/chat` does not use it (it uses local tool calling or the deterministic pipeline).

## What a good session looks like

1. `list_textbooks {"class":"IX","medium":"Assamese","indexed_only":true}` → pick a `textbook_id`.
2. `get_chapters` → `get_chapter_content` (paginate with `next_from_page`) or `search_textbook_content` (Assamese or English).
3. Answer and **cite the `citation` string** of each passage. If a passage has `extraction.method: "ocr"` with low `ocr_confidence`, say so or open `source_pdf_url`.
