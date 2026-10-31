-- SEBA textbook schema. Applied by `seba-ingest migrate` (see ingestion-engine).
-- Content (pages/chapters/chunks) belongs to a physical source file; several
-- catalogue rows may point at the same PDF (e.g. IX and X share one book), so
-- textbooks reference a source instead of duplicating its content.

CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE languages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE,            -- lower-case slug, e.g. 'assamese'
  name        text NOT NULL UNIQUE,            -- display name
  ocr_lang    text,                            -- tesseract language pack(s), e.g. 'asm+eng'
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE subjects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name_key    text NOT NULL UNIQUE,            -- normalised, lower-case key
  name        text NOT NULL,                   -- cleaned display name
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- One row per distinct downloadable file (URL). Shared by textbooks listing the same URL.
CREATE TABLE textbook_sources (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url                text NOT NULL UNIQUE,     -- original official URL, never rewritten
  url_kind           text NOT NULL DEFAULT 'pdf'
                       CHECK (url_kind IN ('pdf','archive','html','other')),
  discovered_from    text,                     -- catalogue page the link was found on
  status             text NOT NULL DEFAULT 'discovered'
                       CHECK (status IN ('discovered','downloaded','processing','indexed',
                                         'failed','unsupported','unavailable','removed')),
  ingest_stage       text NOT NULL DEFAULT 'pending'
                       CHECK (ingest_stage IN ('pending','downloaded','extracted','chunked','embedded','done')),
  http_etag          text,
  http_last_modified text,
  content_length     bigint,
  sha256             text,
  local_path         text,                     -- path on the ingestion machine only
  page_count         integer,
  extraction_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error         text,
  downloaded_at      timestamptz,
  last_checked_at    timestamptz,
  indexed_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX textbook_sources_status_idx ON textbook_sources (status);
CREATE INDEX textbook_sources_sha256_idx ON textbook_sources (sha256) WHERE sha256 IS NOT NULL;

CREATE TABLE textbooks (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  catalogue_key     text NOT NULL UNIQUE,      -- sha1 of normalised (title|class|medium|subject|type|url)
  catalogue_serial  integer,                   -- "Sl. No." on the official page (not stable across updates)
  title             text NOT NULL,
  class_label       text NOT NULL CHECK (class_label IN ('IX','X','IX-X')),
  grade_min         smallint NOT NULL,
  grade_max         smallint NOT NULL,
  subject_id        uuid NOT NULL REFERENCES subjects(id),
  language_id       uuid NOT NULL REFERENCES languages(id),
  medium_label      text NOT NULL,             -- medium exactly as shown in the catalogue
  subject_type      text,                      -- Core / Elective / MIL / NSQF / Co-Curricular
  academic_session  text,                      -- not published in the catalogue; NULL unless known
  source_id         uuid REFERENCES textbook_sources(id),
  catalogue_status  text NOT NULL DEFAULT 'listed'
                      CHECK (catalogue_status IN ('listed','removed')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX textbooks_filter_idx ON textbooks (class_label, language_id, subject_id);
CREATE INDEX textbooks_source_idx ON textbooks (source_id);
CREATE INDEX textbooks_title_trgm_idx ON textbooks USING gin (title gin_trgm_ops);

CREATE TABLE chapters (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id         uuid NOT NULL REFERENCES textbook_sources(id) ON DELETE CASCADE,
  ordinal           integer NOT NULL,          -- 1.. position within the book
  chapter_number    text,                      -- as printed ('3', 'II', ...), NULL if unknown
  title             text NOT NULL,
  start_page        integer NOT NULL,          -- PDF page index (1-based)
  end_page          integer NOT NULL,
  detection_method  text NOT NULL CHECK (detection_method IN ('toc','heading','manual')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, ordinal),
  CHECK (end_page >= start_page)
);

CREATE TABLE textbook_pages (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id         uuid NOT NULL REFERENCES textbook_sources(id) ON DELETE CASCADE,
  chapter_id        uuid REFERENCES chapters(id) ON DELETE SET NULL,
  pdf_page_index    integer NOT NULL CHECK (pdf_page_index >= 1),
  printed_page      text,                      -- printed page label when detected
  content           text NOT NULL DEFAULT '',
  char_count        integer NOT NULL DEFAULT 0,
  extraction_method text NOT NULL CHECK (extraction_method IN ('text','ocr','empty')),
  ocr_confidence    real,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, pdf_page_index)
);
CREATE INDEX textbook_pages_chapter_idx ON textbook_pages (chapter_id);

CREATE TABLE textbook_chunks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id      uuid NOT NULL REFERENCES textbook_sources(id) ON DELETE CASCADE,
  chapter_id     uuid REFERENCES chapters(id) ON DELETE SET NULL,
  chunk_index    integer NOT NULL,
  page_start     integer NOT NULL,
  page_end       integer NOT NULL,
  chunk_kind     text NOT NULL DEFAULT 'body' CHECK (chunk_kind IN ('body','exercise')),
  content        text NOT NULL,
  token_estimate integer NOT NULL,
  content_tsv    tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, chunk_index)
);
CREATE INDEX textbook_chunks_tsv_idx ON textbook_chunks USING gin (content_tsv);
CREATE INDEX textbook_chunks_trgm_idx ON textbook_chunks USING gin (content gin_trgm_ops);
CREATE INDEX textbook_chunks_chapter_idx ON textbook_chunks (chapter_id, chunk_kind);
CREATE INDEX textbook_chunks_pages_idx ON textbook_chunks (source_id, page_start);

-- Embeddings are separate so a model change can be rebuilt without touching chunks.
-- vector(1024) matches bge-m3 (multilingual); change the dimension in a new migration if the model changes.
CREATE TABLE textbook_embeddings (
  chunk_id    uuid NOT NULL REFERENCES textbook_chunks(id) ON DELETE CASCADE,
  model       text NOT NULL,
  embedding   vector(1024) NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chunk_id, model)
);
CREATE INDEX textbook_embeddings_hnsw_idx
  ON textbook_embeddings USING hnsw (embedding vector_cosine_ops);

CREATE TABLE ingestion_logs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id       uuid NOT NULL,
  source_id    uuid REFERENCES textbook_sources(id) ON DELETE SET NULL,
  textbook_id  uuid REFERENCES textbooks(id) ON DELETE SET NULL,
  stage        text NOT NULL,
  level        text NOT NULL DEFAULT 'info' CHECK (level IN ('debug','info','warning','error')),
  message      text NOT NULL,
  details      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ingestion_logs_source_idx ON ingestion_logs (source_id, created_at DESC);
CREATE INDEX ingestion_logs_run_idx ON ingestion_logs (run_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['languages','subjects','textbook_sources','textbooks','chapters',
                           'textbook_pages','textbook_chunks','textbook_embeddings','ingestion_logs']
  LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
                   t || '_set_updated_at', t);
  END LOOP;
END $$;
