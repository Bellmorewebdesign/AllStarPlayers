#!/usr/bin/env python3
"""Start the image finder.

    python run.py                 # http://127.0.0.1:8765
    python run.py --port 9000
    python run.py --import-only   # import the catalog and exit
    python run.py --export        # write the export files and exit

Everything it stores lives under ~/.all-star-image-finder (override with
IMAGEFINDER_HOME).
"""
from __future__ import annotations

import argparse
import sys
import webbrowser

from imagefinder import catalog
from imagefinder.config import load as load_settings
from imagefinder.db import Database
from imagefinder.export import export as run_export
from imagefinder.web import create_app


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="All Star Players product-image finder")
    parser.add_argument("--host", default=None)
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--home", default=None, help="where to keep the database and files")
    parser.add_argument("--import-only", action="store_true", help="import the catalog, then exit")
    parser.add_argument("--export", action="store_true", help="write the export files, then exit")
    parser.add_argument("--no-browser", action="store_true", help="do not open a browser window")
    args = parser.parse_args(argv)

    settings = load_settings(args.home)
    if args.host:
        settings.host = args.host
    if args.port:
        settings.port = args.port
    db = Database(settings.db_path)

    if args.import_only:
        print(f"Importing from {settings.api_base} …")
        try:
            result = catalog.import_products(db, settings.api_base)
        except catalog.CatalogError as exc:
            print(f"import failed ({exc.kind}): {exc}", file=sys.stderr)
            return 1
        print(f"  {result.products} products, build {result.build_id}, {result.pages} pages"
              + (f", restarted {result.restarts}×" if result.restarts else ""))
        print(f"  {result.missing_photo} have no photograph in Square")
        return 0

    if args.export:
        report = run_export(db, settings)
        print(f"manifest entries: {report.manifest_entries}")
        print(f"gallery entries:  {report.gallery_entries}")
        print(f"waiting on rights: {report.pending_rights}")
        print(f"written to: {report.export_dir}")
        return 0

    app = create_app(settings, db)
    url = f"http://{settings.host}:{settings.port}/"
    print(f"Image finder on {url}")
    print(f"  data: {settings.home}")
    print("  Ctrl-C to stop. Progress is saved as you go.")
    if not args.no_browser:
        try:
            webbrowser.open(url)
        except Exception:
            pass
    app.run(host=settings.host, port=settings.port, debug=False, threaded=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
