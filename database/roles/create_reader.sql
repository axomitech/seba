-- Read-only role for the Cloudflare Worker. Run as the database owner/admin, never from the Worker:
--   psql "$ADMIN_DATABASE_URL" -v reader_password="$READER_PASSWORD" -f database/roles/create_reader.sql
-- Optional: -v reader_role=<name> (default seba_mcp_reader). Roles are cluster-wide, so tests use their own name.
-- Keep this password separate from the migration/ingestion credentials.
\if :{?reader_role}
\else
  \set reader_role seba_mcp_reader
\endif

SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'reader_role', :'reader_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'reader_role') \gexec
SELECT format('ALTER ROLE %I PASSWORD %L', :'reader_role', :'reader_password') \gexec
SELECT format('ALTER ROLE %I SET statement_timeout = %L', :'reader_role', '5s') \gexec
SELECT format('ALTER ROLE %I SET default_transaction_read_only = on', :'reader_role') \gexec
SELECT format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), :'reader_role') \gexec
SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'reader_role') \gexec
-- ingestion_logs and operational columns of textbook_sources (local_path, ...) are intentionally not readable.
SELECT format('GRANT SELECT ON languages, subjects, textbooks, chapters, textbook_pages, textbook_chunks, textbook_embeddings TO %I', :'reader_role') \gexec
SELECT format($f$GRANT SELECT (id, url, url_kind, status, page_count, content_length, http_last_modified, extraction_summary,
                  discovered_from, indexed_at, downloaded_at, last_checked_at, sha256, created_at, updated_at)
                ON textbook_sources TO %I$f$, :'reader_role') \gexec
