"""Writing what you approved into files the website understands.

Three things come out, into the export folder:

  manifest.json      the same shape as assets/products/manifest.json in the
                     website repository, keyed by Square product id, carrying
                     file, alt, source, sourceUrl, license, licenseUrl, credit,
                     matchedOn and addedAt. Main images only.
  gallery.json       the other approved photographs for each product, for a
                     gallery that does not exist yet. Same fields.
  pending-rights.json  approved photographs whose usage rights are unknown or
                     refused. They are NOT in the manifest, because an image
                     with no licence is not one the shop may publish.
  images/            the optimised files the manifest points at.

Nothing here touches the live site. Copying the folder into the repository and
committing it is a separate, deliberate act.
"""
from __future__ import annotations

import json
import shutil
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from .db import Database

MANIFEST_VERSION = 1


@dataclass
class ExportReport:
    manifest_entries: int = 0
    gallery_entries: int = 0
    pending_rights: int = 0
    files_copied: int = 0
    skipped: list = field(default_factory=list)   # (square_id, why)
    export_dir: str = ""
    manifest_path: str = ""


def _row_to_entry(row, file_name: str) -> dict:
    """One manifest row. Only fields the website's loader reads, plus the
    provenance that makes the claim checkable later."""
    entry = {
        "file": f"assets/products/{file_name}",
        "alt": (row["alt_text"] or row["title"] or "").strip() or None,
        "source": row["source_name"] or row["provider"],
        "sourceUrl": row["source_page"] or row["image_url"],
        "license": row["license"],
        "licenseUrl": row["license_url"],
        "credit": row["creator"],
        "matchedOn": row["match_note"],
        "addedAt": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "provider": row["provider"],
        "rights": row["rights_status"],
    }
    return {k: v for k, v in entry.items() if v not in (None, "")}


def export(db: Database, settings, *, include_unknown_rights: bool = False) -> ExportReport:
    """Build the export folder from the current decisions.

    `include_unknown_rights` is off on purpose. An approved photograph whose
    licence nobody has established is listed in pending-rights.json so it can
    be chased, not written into the manifest where the site would publish it.
    """
    report = ExportReport(export_dir=str(settings.export_dir))
    settings.ensure_dirs()
    images_dir = settings.export_dir / "images"
    images_dir.mkdir(parents=True, exist_ok=True)

    rows = db.query(
        """
        SELECT c.*, d.decision, d.match_note, d.match_confirmed, d.rights_status,
               d.rights_note, d.is_main, dl.status AS download_status,
               dl.optimized_path, dl.width AS out_width, dl.height AS out_height,
               p.name AS product_name, p.name AS alt_text
        FROM candidates c
        JOIN decisions d ON d.candidate_id = c.id
        JOIN products  p ON p.square_id = c.square_id
        LEFT JOIN downloads dl ON dl.candidate_id = c.id
        WHERE d.decision = 'approved'
        ORDER BY c.square_id, d.is_main DESC, c.id
        """
    )

    manifest: dict[str, dict] = {}
    gallery: dict[str, list] = {}
    pending: list[dict] = []

    for row in rows:
        square_id = row["square_id"]
        rights_ok = row["rights_status"] == "permitted"
        confirmed = bool(row["match_confirmed"]) and (row["match_note"] or "").strip()

        if not confirmed:
            report.skipped.append((square_id, "nobody confirmed this is the same item"))
            continue
        if row["download_status"] != "ok" or not row["optimized_path"]:
            report.skipped.append((square_id, "approved but not downloaded yet"))
            continue

        suffix = Path(row["optimized_path"]).suffix or ".jpg"
        file_name = f"{square_id}{suffix}" if row["is_main"] else f"{square_id}-{row['id']}{suffix}"
        entry = _row_to_entry(row, file_name)
        entry["rightsNote"] = row["rights_note"] or None
        entry = {k: v for k, v in entry.items() if v not in (None, "")}

        if not rights_ok and not include_unknown_rights:
            pending.append({"squareId": square_id, "product": row["product_name"],
                            "rights": row["rights_status"], **entry})
            report.pending_rights += 1
            continue

        source = Path(row["optimized_path"])
        if source.exists():
            shutil.copyfile(source, images_dir / file_name)
            report.files_copied += 1

        if row["is_main"] and square_id not in manifest:
            manifest[square_id] = entry
            report.manifest_entries += 1
        else:
            gallery.setdefault(square_id, []).append(entry)
            report.gallery_entries += 1

    manifest_doc = {
        "version": MANIFEST_VERSION,
        "about": ("Photographs sourced with tools/image-finder. Keyed by Square product id. "
                  "Every entry was approved by a person who confirmed the item matches and "
                  "recorded where the photograph came from and under what licence."),
        "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "images": manifest,
    }
    manifest_path = settings.export_dir / "manifest.json"
    manifest_path.write_text(json.dumps(manifest_doc, indent=2) + "\n", encoding="utf-8")
    report.manifest_path = str(manifest_path)

    (settings.export_dir / "gallery.json").write_text(
        json.dumps({"version": MANIFEST_VERSION, "images": gallery}, indent=2) + "\n",
        encoding="utf-8")
    (settings.export_dir / "pending-rights.json").write_text(
        json.dumps({"version": MANIFEST_VERSION,
                    "about": ("Approved photographs whose usage rights are unknown or refused. "
                              "Not for publication: establish the licence first, or drop them."),
                    "images": pending}, indent=2) + "\n",
        encoding="utf-8")

    readme = settings.export_dir / "README.txt"
    readme.write_text(
        "What is in here\n"
        "---------------\n"
        "manifest.json       main images, in the shape of assets/products/manifest.json\n"
        "gallery.json        the other approved photographs, for a future gallery\n"
        "pending-rights.json approved, but the licence is unknown: do not publish\n"
        "images/             the optimised files the manifest points at\n\n"
        "To put these on the website:\n"
        "  1. copy images/* into the repository's assets/products/\n"
        "  2. merge manifest.json's \"images\" object into assets/products/manifest.json\n"
        "  3. run: node tools/product-images.mjs --check\n"
        "  4. look at the shop page, then commit.\n\n"
        "Nothing in this folder has been published. That is a person's decision.\n",
        encoding="utf-8")

    db.log("exported", f"{report.manifest_entries} main, {report.gallery_entries} extra, "
                       f"{report.pending_rights} waiting on rights")
    return report


def merge_into_repo_manifest(export_manifest: Path, repo_manifest: Path) -> dict:
    """Fold an export into the website's manifest without losing what is there.

    Returns a summary; writes nothing unless both files parse.
    """
    exported = json.loads(Path(export_manifest).read_text(encoding="utf-8"))
    target_path = Path(repo_manifest)
    target = json.loads(target_path.read_text(encoding="utf-8")) if target_path.exists() else {}
    images = dict(target.get("images") or {})
    added, replaced = 0, 0
    for square_id, entry in (exported.get("images") or {}).items():
        if square_id in images:
            replaced += 1
        else:
            added += 1
        images[square_id] = entry
    target.setdefault("version", MANIFEST_VERSION)
    target["images"] = images
    target_path.write_text(json.dumps(target, indent=2) + "\n", encoding="utf-8")
    return {"added": added, "replaced": replaced, "total": len(images)}
