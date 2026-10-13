"""Downloading, optimising and exporting.

Covers the three download endings (ok / blocked / failed), and the export
rules: only what a person approved, only with a confirmed match, and never a
photograph whose rights nobody established.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from PIL import Image

from imagefinder.config import Settings, default_providers
from imagefinder.db import Database
from imagefinder.export import export, merge_into_repo_manifest
from imagefinder.images import download_candidate

from .fakes import FakeServer, FakeState


class DownloadTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.settings = Settings(home=self.home)
        self.settings.providers = default_providers()
        self.settings.optimized_max_edge = 400
        self.settings.ensure_dirs()

    def tearDown(self):
        self.tmp.cleanup()

    def test_a_good_image_is_saved_and_shrunk(self):
        with FakeServer(FakeState()) as server:
            result = download_candidate(
                {"square_id": "P1", "image_url": server.base + "/img/a.png", "provider": "openverse"},
                self.settings)

        self.assertEqual(result["status"], "ok")
        original = Path(result["local_path"])
        optimised = Path(result["optimized_path"])
        self.assertTrue(original.exists() and optimised.exists())
        self.assertEqual(result["width"], 800, "the original's size is recorded")
        with Image.open(optimised) as img:
            self.assertLessEqual(max(img.size), 400, "the web copy is resized")
            self.assertEqual(img.format, "JPEG")
        self.assertLess(optimised.stat().st_size, original.stat().st_size)

    def test_a_host_that_refuses_is_blocked_not_failed(self):
        with FakeServer(FakeState()) as server:
            result = download_candidate(
                {"square_id": "P1", "image_url": server.base + "/blocked.png", "provider": "x"},
                self.settings)
        self.assertEqual(result["status"], "download_blocked")
        self.assertEqual(result["error_kind"], "http_403")

    def test_a_login_page_instead_of_a_photo_is_blocked(self):
        with FakeServer(FakeState()) as server:
            result = download_candidate(
                {"square_id": "P1", "image_url": server.base + "/html.png", "provider": "x"},
                self.settings)
        self.assertEqual(result["status"], "download_blocked")
        self.assertEqual(result["error_kind"], "html_instead_of_image")

    def test_something_that_is_not_an_image_is_a_failure(self):
        with FakeServer(FakeState()) as server:
            result = download_candidate(
                {"square_id": "P1", "image_url": server.base + "/broken.png", "provider": "x"},
                self.settings)
        self.assertEqual(result["status"], "download_failed")
        self.assertEqual(result["error_kind"], "not_an_image")

    def test_an_unreachable_host_is_a_failure(self):
        result = download_candidate(
            {"square_id": "P1", "image_url": "http://127.0.0.1:9/x.png", "provider": "x"},
            self.settings)
        self.assertEqual(result["status"], "download_failed")
        self.assertIn(result["error_kind"], {"network", "timeout"})

    def test_an_uploaded_photograph_is_read_from_disk(self):
        own = self.home / "own.png"
        Image.new("RGB", (900, 700), (20, 90, 160)).save(own)
        result = download_candidate(
            {"square_id": "P1", "image_url": f"file://{own}", "provider": "upload"},
            self.settings)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["width"], 900)


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.settings = Settings(home=self.home)
        self.settings.providers = default_providers()
        self.settings.ensure_dirs()
        self.db = Database(self.home / "t.sqlite3")
        for square_id, name in (("P1", "HORSESHOE TEE"), ("P2", "FITTED CAP"),
                                ("P3", "CULT ROCKER SLIM")):
            self.db.upsert_product({
                "square_id": square_id, "name": name, "description": "",
                "category_ids": "", "category_names": "", "skus": "", "colors": "",
                "sizes": "", "variation_count": 1, "square_image_count": 0,
                "price_min": 1000, "price_max": 1000, "currency": "USD",
                "build_id": "b", "imported_at": "now", "updated_at": "now",
            })

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def _candidate(self, square_id: str, **over) -> int:
        payload = {
            "provider": "openverse", "provider_id": "ov-1", "title": "A photograph",
            "source_page": "https://example.invalid/page", "image_url": f"https://x.invalid/{square_id}.png",
            "thumb_url": "", "width": 1200, "height": 900,
            "license": "CC BY-SA 4.0", "license_url": "https://creativecommons.org/licenses/by-sa/4.0/",
            "license_status": "known", "creator": "A. Photographer",
            "source_name": "Openverse", "query": "horseshoe tee", "raw": {},
        }
        payload.update(over)
        return self.db.add_candidate(square_id, None, payload)

    def _downloaded(self, candidate_id: int, square_id: str) -> None:
        path = self.settings.optimized_dir / f"{square_id}.jpg"
        Image.new("RGB", (600, 600), (30, 30, 30)).save(path, "JPEG")
        self.db.record_download(candidate_id, status="ok", local_path=str(path),
                                optimized_path=str(path), bytes=path.stat().st_size,
                                width=600, height=600, sha256="abc")

    def test_an_approved_confirmed_licensed_image_reaches_the_manifest(self):
        cid = self._candidate("P1")
        self._downloaded(cid, "P1")
        self.db.decide(cid, "P1", "approved", match_note="same shirt, same print, black",
                       match_confirmed=True, rights_status="permitted",
                       rights_note="CC BY-SA 4.0 on the source page", is_main=True)

        report = export(self.db, self.settings)
        self.assertEqual(report.manifest_entries, 1)

        doc = json.loads((self.settings.export_dir / "manifest.json").read_text())
        entry = doc["images"]["P1"]
        self.assertEqual(entry["file"], "assets/products/P1.jpg")
        self.assertEqual(entry["license"], "CC BY-SA 4.0")
        self.assertEqual(entry["credit"], "A. Photographer")
        self.assertEqual(entry["sourceUrl"], "https://example.invalid/page")
        self.assertEqual(entry["matchedOn"], "same shirt, same print, black")
        self.assertTrue((self.settings.export_dir / "images" / "P1.jpg").exists())

    def test_unknown_rights_never_reach_the_manifest(self):
        cid = self._candidate("P2", license=None, license_status="unknown", provider="google_cse")
        self._downloaded(cid, "P2")
        self.db.decide(cid, "P2", "approved", match_note="same cap, same logo",
                       match_confirmed=True, rights_status="unknown", is_main=True)

        report = export(self.db, self.settings)
        self.assertEqual(report.manifest_entries, 0)
        self.assertEqual(report.pending_rights, 1)

        pending = json.loads((self.settings.export_dir / "pending-rights.json").read_text())
        self.assertEqual(pending["images"][0]["squareId"], "P2")
        doc = json.loads((self.settings.export_dir / "manifest.json").read_text())
        self.assertNotIn("P2", doc["images"])
        self.assertFalse((self.settings.export_dir / "images" / "P2.jpg").exists())

    def test_an_unconfirmed_match_is_refused_even_when_approved(self):
        cid = self._candidate("P3")
        self._downloaded(cid, "P3")
        self.db.decide(cid, "P3", "approved", match_note="", match_confirmed=False,
                       rights_status="permitted", is_main=True)

        report = export(self.db, self.settings)
        self.assertEqual(report.manifest_entries, 0)
        self.assertTrue(any("same item" in why for _, why in report.skipped))

    def test_extra_approved_photographs_go_to_the_gallery(self):
        main = self._candidate("P1")
        extra = self._candidate("P1", image_url="https://x.invalid/P1-b.png", provider_id="ov-2")
        self._downloaded(main, "P1")
        self._downloaded(extra, "P1-b")
        for cid, is_main in ((main, True), (extra, False)):
            self.db.decide(cid, "P1", "approved", match_note="checked the source page",
                           match_confirmed=True, rights_status="permitted", is_main=is_main)

        report = export(self.db, self.settings)
        self.assertEqual(report.manifest_entries, 1)
        self.assertEqual(report.gallery_entries, 1)
        gallery = json.loads((self.settings.export_dir / "gallery.json").read_text())
        self.assertEqual(len(gallery["images"]["P1"]), 1)

    def test_rejected_and_undownloaded_images_are_left_out(self):
        rejected = self._candidate("P1")
        self.db.decide(rejected, "P1", "rejected")
        not_downloaded = self._candidate("P2")
        self.db.decide(not_downloaded, "P2", "approved", match_note="same hat",
                       match_confirmed=True, rights_status="permitted", is_main=True)

        report = export(self.db, self.settings)
        self.assertEqual(report.manifest_entries, 0)
        self.assertTrue(any("not downloaded" in why for _, why in report.skipped))

    def test_merging_into_the_website_manifest_keeps_what_is_there(self):
        cid = self._candidate("P1")
        self._downloaded(cid, "P1")
        self.db.decide(cid, "P1", "approved", match_note="same tee", match_confirmed=True,
                       rights_status="permitted", is_main=True)
        export(self.db, self.settings)

        repo_manifest = self.home / "repo-manifest.json"
        repo_manifest.write_text(json.dumps({
            "version": 1, "about": "the site's own file",
            "images": {"EXISTING": {"file": "assets/products/EXISTING.jpg"}},
        }))
        summary = merge_into_repo_manifest(self.settings.export_dir / "manifest.json", repo_manifest)

        self.assertEqual(summary, {"added": 1, "replaced": 0, "total": 2})
        merged = json.loads(repo_manifest.read_text())
        self.assertIn("EXISTING", merged["images"])
        self.assertIn("P1", merged["images"])
        self.assertEqual(merged["about"], "the site's own file", "the site's own notes survive")


if __name__ == "__main__":
    unittest.main()
