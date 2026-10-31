"""Command line interface: seba-ingest <command>."""
from __future__ import annotations

import argparse
import json
import sys
import uuid

from .config import Settings
from .database import db
from .downloader.safe_http import SafeSession
from .embeddings.providers import get_provider
from .logging_setup import setup_logging
from .pipeline import IngestOptions, Pipeline


def _build(settings: Settings, need_db: bool = True):
    session = SafeSession.from_settings(settings)
    conn = db.connect(settings.database_url) if need_db else None
    log_conn = db.connect(settings.database_url) if need_db else None
    if log_conn is not None:
        log_conn.autocommit = False
    repo = db.Repository(conn, log_conn) if conn else None
    return session, repo


def _selection_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--id", dest="ident", help="textbook UUID, catalogue serial number (Sl. No.) or title fragment")
    p.add_argument("--all", action="store_true", help="every discovered PDF textbook")
    p.add_argument("--class", dest="class_label", choices=["IX", "X", "IX-X"])
    p.add_argument("--medium")
    p.add_argument("--subject")
    p.add_argument("--limit", type=int, help="process at most N textbooks")
    p.add_argument("--retry-failed", action="store_true", help="only sources whose last attempt failed")


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="seba-ingest", description=__doc__)
    ap.add_argument("-v", "--verbose", action="store_true")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("migrate", help="apply database/migrations/*.sql")
    sub.add_parser("seed", help="apply database/seeders/*.sql")
    d = sub.add_parser("discover", help="read the official catalogue and upsert textbooks/sources")
    d.add_argument("--dry-run", action="store_true", help="print what was found, do not touch the database")
    l = sub.add_parser("list", help="list discovered textbooks")
    _selection_args(l)
    for name, helptext in (("ingest", "download, extract, chunk and embed textbooks"),
                           ("rechunk", "keep stored pages; redo chapter detection, chunking and missing embeddings"),
                           ("reprocess", "force re-extraction/chunking/embedding of selected textbooks")):
        i = sub.add_parser(name, help=helptext)
        _selection_args(i)
        i.add_argument("--redownload", action="store_true", help="fetch the PDF again even if a local copy exists")
        i.add_argument("--no-ocr", action="store_true")
        i.add_argument("--no-embed", action="store_true")
        i.add_argument("--max-pages", type=int, help="trial run: extract only the first N pages")
    sub.add_parser("status", help="row counts and source status summary")
    g = sub.add_parser("logs", help="recent ingestion log lines for a textbook")
    g.add_argument("ident")
    g.add_argument("-n", type=int, default=30)
    return ap


def _select(repo, args) -> list[dict]:
    rows = repo.find_textbooks(args.ident, class_label=args.class_label, medium=args.medium, subject=args.subject)
    if not (args.ident or args.all or args.class_label or args.medium or args.subject):
        raise SystemExit("choose what to process: --id <ident> or --all (optionally with filters)")
    seen, out = set(), []
    for r in rows:
        if r["source_id"] in seen:  # shared PDFs are processed once
            continue
        seen.add(r["source_id"])
        if args.retry_failed and r["source_status"] != "failed":
            continue
        out.append(r)
    return out[: args.limit] if args.limit else out


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    setup_logging(args.verbose)
    settings = Settings.from_env()

    if args.cmd == "discover" and args.dry_run:
        from .discovery.seba_table import discover_catalogue
        session, _ = _build(settings, need_db=False)
        entries = discover_catalogue(settings.catalogue_url, session.get_text)
        print(json.dumps([e.__dict__ for e in entries], indent=2, ensure_ascii=False))
        print(f"{len(entries)} rows", file=sys.stderr)
        return 0

    session, repo = _build(settings)
    conn = repo.conn
    try:
        if args.cmd == "migrate":
            print("applied:", db.migrate(conn, settings.migrations_dir) or "nothing to do")
        elif args.cmd == "seed":
            print("seeded:", db.seed(conn, settings.seeders_dir))
        elif args.cmd == "discover":
            pipe = Pipeline(settings, repo, session, None)
            print(json.dumps(pipe.discover(), indent=2))
        elif args.cmd == "list":
            rows = repo.find_textbooks(args.ident, class_label=args.class_label, medium=args.medium,
                                       subject=args.subject, limit=args.limit)
            for r in rows:
                print(f"{r['catalogue_serial'] or '-':>4}  {r['id']}  {r['class_label']:<4} {r['language_code']:<9} "
                      f"{(r['source_status'] or 'no-link'):<11} {r['subject'][:28]:<28} {r['title'][:50]}")
            print(f"{len(rows)} textbooks", file=sys.stderr)
        elif args.cmd in ("ingest", "reprocess", "rechunk"):
            pipe = Pipeline(settings, repo, session, get_provider(settings))
            opts = IngestOptions(force=args.cmd == "reprocess", rechunk=args.cmd == "rechunk", redownload=args.redownload, ocr=not args.no_ocr,
                                 embed=not args.no_embed, max_pages=args.max_pages)
            targets = _select(repo, args)
            print(f"run {pipe.run_id}: {len(targets)} source(s)", file=sys.stderr)
            failures = 0
            for n, tb in enumerate(targets, 1):
                print(f"[{n}/{len(targets)}] {tb['title']} ({tb['class_label']}, {tb['language_code']})", file=sys.stderr)
                res = pipe.ingest_textbook(tb, opts)
                failures += res.outcome == "failed"
                print(f"    -> {res.outcome} {res.detail} {json.dumps(res.counts, default=str)}", file=sys.stderr)
            return 1 if failures else 0
        elif args.cmd == "status":
            print(json.dumps(repo.stats(), indent=2, default=str))
        elif args.cmd == "logs":
            rows = repo.find_textbooks(args.ident)
            if not rows:
                raise SystemExit("no such textbook")
            with db.transaction(conn) as cur:
                cur.execute("""SELECT created_at, level, stage, message FROM ingestion_logs WHERE source_id = %s
                               ORDER BY created_at DESC LIMIT %s""", (rows[0]["source_id"], args.n))
                for r in reversed(cur.fetchall()):
                    print(f"{r['created_at']:%Y-%m-%d %H:%M:%S} {r['level']:<7} {r['stage']:<9} {r['message']}")
    finally:
        conn.close()
        repo.log_conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
