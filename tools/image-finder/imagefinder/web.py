"""The local web interface.

A small Flask app, bound to 127.0.0.1 by default: it is a desk tool, not a
service. Every page is a thin view over the SQLite store, and nothing it does
reaches the live website.
"""
from __future__ import annotations

import json
import mimetypes
from pathlib import Path

import requests
from flask import (Flask, abort, jsonify, redirect, render_template, request,
                   send_file, url_for)

from . import catalog, queries as query_builder
from .config import Settings, load as load_settings
from .db import Database, now
from .export import export as run_export
from .images import download_candidate
from .providers import describe_providers
from .search import SearchService


def create_app(settings: Settings | None = None, db: Database | None = None) -> Flask:
    settings = settings or load_settings()
    settings.ensure_dirs()
    db = db or Database(settings.db_path)
    http = requests.Session()
    search_service = SearchService(db, settings, http=http)

    app = Flask(__name__)
    app.config["SETTINGS"] = settings
    app.config["DB"] = db
    app.config["SEARCH"] = search_service
    app.config["HTTP"] = http
    app.config["JSON_SORT_KEYS"] = False

    # ------------------------------------------------------------ pages
    @app.get("/")
    def dashboard():
        return render_template(
            "dashboard.html",
            counts=db.counts(),
            providers=describe_providers(settings),
            budgets={row["name"]: {
                "used": db.budget_used(row["name"]),
                "budget": row["daily_budget"],
            } for row in describe_providers(settings)},
            last_import=db.get_meta("last_import_at"),
            last_build=db.get_meta("last_import_build"),
            api_base=settings.api_base,
            settings=settings,
        )

    @app.get("/products")
    def product_list():
        scope = request.args.get("scope", "missing")
        status = request.args.get("status", "")
        search = (request.args.get("q") or "").strip()
        page = max(1, int(request.args.get("page", 1)))
        per_page = 60

        where, params = [], []
        if scope == "missing":
            where.append("square_image_count = 0")
        elif scope == "has_photo":
            where.append("square_image_count > 0")
        if status:
            where.append("status = ?")
            params.append(status)
        if search:
            where.append("(name LIKE ? OR skus LIKE ? OR square_id = ?)")
            params += [f"%{search}%", f"%{search}%", search]
        clause = ("WHERE " + " AND ".join(where)) if where else ""

        total = db.scalar(f"SELECT COUNT(*) FROM products {clause}", tuple(params)) or 0
        rows = db.query(
            f"""
            SELECT p.*,
                   (SELECT COUNT(*) FROM candidates c WHERE c.square_id = p.square_id) AS candidates,
                   (SELECT COUNT(*) FROM decisions d
                     WHERE d.square_id = p.square_id AND d.decision='approved') AS approved,
                   (SELECT COUNT(*) FROM decisions d
                     WHERE d.square_id = p.square_id AND d.decision='approved' AND d.is_main=1) AS has_main
            FROM products p {clause}
            ORDER BY p.name
            LIMIT ? OFFSET ?
            """,
            tuple(params) + (per_page, (page - 1) * per_page),
        )
        return render_template("products.html", products=rows, total=total, page=page,
                               per_page=per_page, scope=scope, status=status, q=search,
                               counts=db.counts())

    @app.get("/product/<square_id>")
    def product_detail(square_id: str):
        product = db.one("SELECT * FROM products WHERE square_id=?", (square_id,))
        if product is None:
            abort(404)
        rows = db.queries_for(square_id)
        if not rows:
            for text in query_builder.build(dict(product)):
                db.add_query(square_id, text, "auto")
            rows = db.queries_for(square_id)

        candidates = [dict(row) for row in db.candidates_for(square_id)]
        for cand in candidates:
            cand["raw_pretty"] = _pretty(cand.get("raw"))

        next_row = db.one(
            """
            SELECT square_id FROM products
            WHERE square_image_count = 0 AND status IN ('pending','reviewing') AND name > ?
            ORDER BY name LIMIT 1
            """,
            (product["name"],),
        )
        return render_template(
            "product.html", product=product, queries=rows, candidates=candidates,
            hints=query_builder.describe(dict(product)),
            providers=describe_providers(settings),
            next_id=next_row["square_id"] if next_row else None,
            settings=settings,
        )

    @app.get("/settings")
    def settings_page():
        return render_template("settings.html", providers=describe_providers(settings),
                               settings=settings, counts=db.counts(),
                               budgets={p["name"]: db.budget_used(p["name"])
                                        for p in describe_providers(settings)})

    @app.get("/export")
    def export_page():
        ready = db.query(
            """
            SELECT p.square_id, p.name, d.rights_status, d.match_confirmed,
                   dl.status AS download_status
            FROM decisions d
            JOIN products p ON p.square_id = d.square_id
            LEFT JOIN downloads dl ON dl.candidate_id = d.candidate_id
            WHERE d.decision='approved' AND d.is_main=1
            ORDER BY p.name
            """
        )
        return render_template("export.html", ready=ready, settings=settings, counts=db.counts())

    # ------------------------------------------------------------- actions
    @app.post("/api/import")
    def api_import():
        try:
            result = catalog.import_products(db, settings.api_base, session=http)
        except catalog.CatalogError as exc:
            return jsonify({"ok": False, "kind": exc.kind, "message": str(exc)}), 502
        return jsonify({
            "ok": True, "products": result.products, "pages": result.pages,
            "restarts": result.restarts, "build_id": result.build_id,
            "missing_photo": result.missing_photo,
        })

    @app.post("/api/product/<square_id>/queries")
    def api_set_queries(square_id: str):
        payload = request.get_json(silent=True) or {}
        texts = [t.strip() for t in (payload.get("queries") or []) if t and t.strip()]
        db.execute("DELETE FROM queries WHERE square_id=?", (square_id,))
        for text in texts:
            db.add_query(square_id, text, "edited")
        return jsonify({"ok": True, "queries": [dict(r) for r in db.queries_for(square_id)]})

    @app.post("/api/product/<square_id>/search")
    def api_search(square_id: str):
        payload = request.get_json(silent=True) or {}
        refresh = bool(payload.get("refresh"))
        chosen = payload.get("providers") or None
        texts = [t.strip() for t in (payload.get("queries") or []) if t and t.strip()]
        if texts:
            db.execute("DELETE FROM queries WHERE square_id=?", (square_id,))
            for text in texts:
                db.add_query(square_id, text, "edited")
        else:
            texts = [row["text"] for row in db.queries_for(square_id)]

        report = search_service.search_product(square_id, texts, providers=chosen, refresh=refresh)
        candidates = [dict(row) for row in db.candidates_for(square_id)]
        return jsonify({
            "ok": True,
            "status": report.status,
            "note": report.note,
            "new": report.new_candidates,
            "total": report.total_candidates,
            "outcomes": [{
                "provider": o.provider, "query": o.query, "outcome": o.outcome,
                "cached": o.cached, "new": o.new_candidates,
                "error_kind": o.error_kind, "error_detail": o.error_detail,
            } for o in report.outcomes],
            "candidates": candidates,
        })

    @app.post("/api/candidate/<int:candidate_id>/decide")
    def api_decide(candidate_id: int):
        payload = request.get_json(silent=True) or {}
        row = db.one("SELECT * FROM candidates WHERE id=?", (candidate_id,))
        if row is None:
            abort(404)
        decision = payload.get("decision")
        if decision not in ("approved", "rejected"):
            return jsonify({"ok": False, "message": "decision must be approved or rejected"}), 400

        rights = payload.get("rights_status") or "unknown"
        if rights not in ("permitted", "unknown", "not_permitted"):
            rights = "unknown"
        confirmed = bool(payload.get("match_confirmed"))
        note = (payload.get("match_note") or "").strip()

        # Approving is the moment a person takes responsibility for the claim
        # that this photograph shows this product, so it needs both a tick and
        # a note. Rejecting needs neither.
        if decision == "approved" and (not confirmed or not note):
            return jsonify({
                "ok": False,
                "message": "to approve, confirm it is the same item and say how you checked",
            }), 400

        db.decide(candidate_id, row["square_id"], decision, match_note=note,
                  match_confirmed=confirmed, rights_status=rights,
                  rights_note=(payload.get("rights_note") or "").strip(),
                  is_main=bool(payload.get("is_main")))
        if decision == "approved" and payload.get("is_main"):
            db.set_main(row["square_id"], candidate_id)

        downloaded = None
        if decision == "approved" and payload.get("download", True):
            downloaded = _download(db, settings, http, candidate_id)

        db.set_product_status(row["square_id"], "reviewing")
        return jsonify({"ok": True, "download": downloaded,
                        "candidates": [dict(r) for r in db.candidates_for(row["square_id"])]})

    @app.post("/api/candidate/<int:candidate_id>/main")
    def api_main(candidate_id: int):
        row = db.one("SELECT * FROM candidates WHERE id=?", (candidate_id,))
        if row is None:
            abort(404)
        decision = db.one("SELECT * FROM decisions WHERE candidate_id=?", (candidate_id,))
        if decision is None or decision["decision"] != "approved":
            return jsonify({"ok": False, "message": "approve it first"}), 400
        db.set_main(row["square_id"], candidate_id)
        return jsonify({"ok": True, "candidates": [dict(r) for r in db.candidates_for(row["square_id"])]})

    @app.post("/api/candidate/<int:candidate_id>/download")
    def api_download(candidate_id: int):
        result = _download(db, settings, http, candidate_id)
        return jsonify({"ok": result.get("status") == "ok", "download": result})

    @app.post("/api/product/<square_id>/skip")
    def api_skip(square_id: str):
        payload = request.get_json(silent=True) or {}
        db.set_product_status(square_id, "skipped", (payload.get("reason") or "").strip())
        return jsonify({"ok": True})

    @app.post("/api/product/<square_id>/reopen")
    def api_reopen(square_id: str):
        db.set_product_status(square_id, "pending", "")
        return jsonify({"ok": True})

    @app.post("/api/product/<square_id>/upload")
    def api_upload(square_id: str):
        """Your own photograph. It becomes a candidate like any other, with
        rights recorded as the shop's own unless you say otherwise."""
        product = db.one("SELECT * FROM products WHERE square_id=?", (square_id,))
        if product is None:
            abort(404)
        file = request.files.get("file")
        if file is None or not file.filename:
            return jsonify({"ok": False, "message": "no file"}), 400

        settings.ensure_dirs()
        safe = "".join(ch for ch in Path(file.filename).name if ch.isalnum() or ch in "._-")
        target = settings.originals_dir / f"{square_id}-upload-{safe}"
        file.save(target)

        candidate_id = db.add_candidate(square_id, None, {
            "provider": "upload",
            "provider_id": safe,
            "title": request.form.get("title") or f"Own photograph: {safe}",
            "source_page": "",
            "image_url": f"file://{target}",
            "thumb_url": f"file://{target}",
            "license": request.form.get("license") or "Own photograph",
            "license_url": "",
            "license_status": "known",
            "creator": request.form.get("credit") or "All Star Players",
            "source_name": "Uploaded by the shop",
            "query": "",
            "raw": {"uploaded_at": now(), "filename": safe},
        })
        if candidate_id is None:
            row = db.one("SELECT id FROM candidates WHERE square_id=? AND image_url=?",
                         (square_id, f"file://{target}"))
            candidate_id = row["id"] if row else None
        if candidate_id:
            _download(db, settings, http, candidate_id)
        return jsonify({"ok": True, "candidate_id": candidate_id,
                        "candidates": [dict(r) for r in db.candidates_for(square_id)]})

    @app.post("/api/settings")
    def api_settings():
        payload = request.get_json(silent=True) or {}
        for name, values in (payload.get("providers") or {}).items():
            provider_settings = settings.providers.get(name)
            if provider_settings is None:
                continue
            if "enabled" in values:
                provider_settings.enabled = bool(values["enabled"])
            if "api_key" in values and values["api_key"] != "__unchanged__":
                provider_settings.api_key = (values["api_key"] or "").strip()
            if "daily_budget" in values:
                provider_settings.daily_budget = max(0, int(values["daily_budget"] or 0))
            if "min_interval_seconds" in values:
                provider_settings.min_interval_seconds = max(0.0, float(values["min_interval_seconds"] or 0))
            if "cx" in values:
                provider_settings.extra["cx"] = (values["cx"] or "").strip()
        if "candidates_per_product" in payload:
            settings.candidates_per_product = max(1, min(30, int(payload["candidates_per_product"])))
        if "api_base" in payload and payload["api_base"]:
            settings.api_base = payload["api_base"].strip()
        settings.save()
        search_service.providers = SearchService(db, settings, http=http).providers
        return jsonify({"ok": True, "providers": describe_providers(settings)})

    @app.post("/api/export")
    def api_export():
        payload = request.get_json(silent=True) or {}
        report = run_export(db, settings,
                            include_unknown_rights=bool(payload.get("include_unknown_rights")))
        return jsonify({
            "ok": True,
            "manifest_entries": report.manifest_entries,
            "gallery_entries": report.gallery_entries,
            "pending_rights": report.pending_rights,
            "files_copied": report.files_copied,
            "skipped": report.skipped,
            "export_dir": report.export_dir,
            "manifest_path": report.manifest_path,
        })

    # ------------------------------------------------- serving local files
    @app.get("/file/<int:candidate_id>")
    def candidate_file(candidate_id: int):
        """Serves a downloaded image to the browser, so the review page can
        show what is actually on disk rather than refetching from the host."""
        row = db.one(
            "SELECT optimized_path, local_path FROM downloads WHERE candidate_id=?",
            (candidate_id,),
        )
        if row is None:
            abort(404)
        path = Path(row["optimized_path"] or row["local_path"] or "")
        if not path.exists():
            abort(404)
        mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        return send_file(path, mimetype=mime)

    @app.get("/healthz")
    def healthz():
        return jsonify({"ok": True, "products": db.counts()["products"]})

    return app


def _download(db: Database, settings, http, candidate_id: int) -> dict:
    row = db.one("SELECT * FROM candidates WHERE id=?", (candidate_id,))
    if row is None:
        return {"status": "download_failed", "error_kind": "unknown_candidate"}
    result = download_candidate(dict(row), settings, session=http)
    db.record_download(candidate_id, **result)
    return dict(result)


def _pretty(raw) -> str:
    try:
        return json.dumps(json.loads(raw or "{}"), indent=2)[:4000]
    except (TypeError, ValueError):
        return str(raw or "")
