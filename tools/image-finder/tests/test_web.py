"""The browser interface, driven through its own HTTP endpoints.

This is the review workflow end to end: import, generate and edit queries,
search, approve with a confirmed match, upload your own photograph, pick a
main image, and export — plus the refusals that keep a wrong photograph off
the website.
"""
from __future__ import annotations

import io
import json
import tempfile
import unittest
from pathlib import Path

from PIL import Image

from imagefinder.config import Settings, default_providers
from imagefinder.db import Database
from imagefinder.web import create_app

from .fakes import FakeServer, FakeState, product


class WebTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.state = FakeState()
        self.state.categories = [{"id": "CAT1", "name": "T-SHIRTS"}]
        self.state.products = [
            product("P1", "HORSESHOE TEE", images=0, colors=("BLACK",)),
            product("P2", "FITTED CAP", images=1, colors=("NAVY",)),
            product("P3", "CULT ROCKER SLIM", images=0, colors=("INDIGO",)),
        ]
        self.server = FakeServer(self.state)
        self.server.__enter__()

        self.settings = Settings(home=self.home, api_base=self.server.base + "/default")
        self.settings.providers = default_providers()
        for provider in self.settings.providers.values():
            provider.extra["base_url"] = self.server.base
            provider.min_interval_seconds = 0
        self.settings.candidates_per_product = 6
        self.settings.ensure_dirs()

        self.db = Database(self.settings.db_path)
        self.app = create_app(self.settings, self.db)
        self.client = self.app.test_client()

    def tearDown(self):
        self.db.close()
        self.server.__exit__(None, None, None)
        self.tmp.cleanup()

    # ---- helpers ----
    def _import(self):
        return self.client.post("/api/import").get_json()

    def _search(self, square_id="P1", **body):
        return self.client.post(f"/api/product/{square_id}/search", json=body).get_json()

    # ---- pages ----
    def test_every_page_renders(self):
        self._import()
        for path in ("/", "/products", "/products?scope=all", "/product/P1", "/settings", "/export"):
            response = self.client.get(path)
            self.assertEqual(response.status_code, 200, path)

    def test_import_through_the_ui(self):
        data = self._import()
        self.assertTrue(data["ok"])
        self.assertEqual(data["products"], 3)
        self.assertEqual(data["missing_photo"], 2)

    def test_the_list_defaults_to_products_with_no_photograph(self):
        self._import()
        body = self.client.get("/products").get_data(as_text=True)
        self.assertIn("HORSESHOE TEE", body)
        self.assertNotIn("FITTED CAP", body, "it already has a Square photograph")
        every = self.client.get("/products?scope=all").get_data(as_text=True)
        self.assertIn("FITTED CAP", every)

    def test_queries_are_generated_and_can_be_edited(self):
        self._import()
        self.client.get("/product/P1")               # generates them
        rows = self.db.queries_for("P1")
        self.assertTrue(rows)
        self.assertTrue(any("HORSESHOE TEE" in row["text"] for row in rows))

        saved = self.client.post("/api/product/P1/queries",
                                 json={"queries": ["horseshoe tee black queens"]}).get_json()
        self.assertTrue(saved["ok"])
        self.assertEqual([r["text"] for r in self.db.queries_for("P1")],
                         ["horseshoe tee black queens"])
        self.assertEqual(self.db.queries_for("P1")[0]["origin"], "edited")

    # ---- the review loop ----
    def test_search_review_approve_and_export(self):
        self._import()
        found = self._search("P1", queries=["horseshoe tee"])
        self.assertTrue(found["ok"])
        self.assertGreaterEqual(len(found["candidates"]), 2)
        self.assertTrue(any(o["outcome"] == "ok" for o in found["outcomes"]))

        candidate = found["candidates"][0]
        approved = self.client.post(f"/api/candidate/{candidate['id']}/decide", json={
            "decision": "approved",
            "match_confirmed": True,
            "match_note": "opened the source page: same shirt, same print, black",
            "rights_status": "permitted",
            "rights_note": "CC BY-SA 4.0 stated on the source page",
            "is_main": True,
        }).get_json()
        self.assertTrue(approved["ok"])
        self.assertEqual(approved["download"]["status"], "ok")

        exported = self.client.post("/api/export", json={}).get_json()
        self.assertEqual(exported["manifest_entries"], 1)
        manifest = json.loads(Path(exported["manifest_path"]).read_text())
        entry = manifest["images"]["P1"]
        self.assertEqual(entry["matchedOn"], "opened the source page: same shirt, same print, black")
        self.assertIn("BY-SA", entry["license"])
        self.assertTrue(entry["sourceUrl"])

    def test_approving_without_confirming_the_match_is_refused(self):
        """The guard that stops a photograph of a different product going out."""
        self._import()
        found = self._search("P1", queries=["horseshoe tee"])
        candidate = found["candidates"][0]

        response = self.client.post(f"/api/candidate/{candidate['id']}/decide", json={
            "decision": "approved", "match_confirmed": False, "match_note": "",
            "rights_status": "permitted",
        })
        self.assertEqual(response.status_code, 400)
        self.assertIn("same item", response.get_json()["message"])
        self.assertIsNone(self.db.one("SELECT * FROM decisions WHERE candidate_id=?",
                                      (candidate["id"],)))

    def test_approving_with_a_tick_but_no_note_is_refused(self):
        self._import()
        found = self._search("P1", queries=["horseshoe tee"])
        response = self.client.post(f"/api/candidate/{found['candidates'][0]['id']}/decide", json={
            "decision": "approved", "match_confirmed": True, "match_note": "   ",
        })
        self.assertEqual(response.status_code, 400)

    def test_rejecting_needs_nothing_and_keeps_the_candidate(self):
        self._import()
        found = self._search("P1", queries=["horseshoe tee"])
        cid = found["candidates"][0]["id"]
        data = self.client.post(f"/api/candidate/{cid}/decide",
                                json={"decision": "rejected"}).get_json()
        self.assertTrue(data["ok"])
        row = self.db.one("SELECT decision FROM decisions WHERE candidate_id=?", (cid,))
        self.assertEqual(row["decision"], "rejected")

    def test_several_approved_photographs_and_choosing_the_main_one(self):
        self._import()
        found = self._search("P1", queries=["horseshoe tee"])
        first, second = found["candidates"][0], found["candidates"][1]
        for candidate in (first, second):
            self.client.post(f"/api/candidate/{candidate['id']}/decide", json={
                "decision": "approved", "match_confirmed": True,
                "match_note": "checked the source", "rights_status": "permitted",
            })
        self.client.post(f"/api/candidate/{second['id']}/main", json={})

        mains = self.db.query("SELECT candidate_id FROM decisions WHERE square_id='P1' AND is_main=1")
        self.assertEqual([row["candidate_id"] for row in mains], [second["id"]],
                         "exactly one main image, and it is the one chosen")

        exported = self.client.post("/api/export", json={}).get_json()
        self.assertEqual(exported["manifest_entries"], 1)
        self.assertEqual(exported["gallery_entries"], 1)

    def test_uploading_your_own_photograph(self):
        self._import()
        buf = io.BytesIO()
        Image.new("RGB", (1000, 800), (12, 120, 60)).save(buf, "PNG")
        buf.seek(0)

        data = self.client.post("/api/product/P3/upload", data={
            "file": (buf, "rack.png"), "credit": "All Star Players",
        }, content_type="multipart/form-data").get_json()
        self.assertTrue(data["ok"])
        candidate = [c for c in data["candidates"] if c["provider"] == "upload"][0]
        self.assertEqual(candidate["download_status"], "ok", "an upload is ready immediately")
        self.assertEqual(candidate["license_status"], "known")

        self.client.post(f"/api/candidate/{candidate['id']}/decide", json={
            "decision": "approved", "match_confirmed": True,
            "match_note": "photographed in the shop", "rights_status": "permitted",
            "rights_note": "the shop's own photograph", "is_main": True,
        })
        exported = self.client.post("/api/export", json={}).get_json()
        self.assertEqual(exported["manifest_entries"], 1)

    def test_skipping_a_product_and_reopening_it(self):
        self._import()
        self.client.post("/api/product/P1/skip", json={"reason": "no photograph will ever exist"})
        self.assertEqual(self.db.one("SELECT status FROM products WHERE square_id='P1'")["status"],
                         "skipped")
        self.client.post("/api/product/P1/reopen", json={})
        self.assertEqual(self.db.one("SELECT status FROM products WHERE square_id='P1'")["status"],
                         "pending")

    def test_a_stopped_batch_resumes_where_it_was(self):
        """Half the products reviewed, the program stopped, started again."""
        self._import()
        self._search("P1", queries=["horseshoe tee"])
        first = self.db.candidates_for("P1")[0]
        self.client.post(f"/api/candidate/{first['id']}/decide", json={
            "decision": "approved", "match_confirmed": True, "match_note": "checked",
            "rights_status": "permitted", "is_main": True,
        })
        calls_before = len(self.state.calls)
        self.db.close()

        # a fresh process, same home directory
        db2 = Database(self.settings.db_path)
        app2 = create_app(self.settings, db2)
        client2 = app2.test_client()

        page = client2.get("/product/P1").get_data(as_text=True)
        self.assertIn("approved", page)
        again = client2.post("/api/product/P1/search", json={}).get_json()
        self.assertEqual(len(self.state.calls), calls_before, "nothing was searched again")
        self.assertTrue(again["candidates"])
        self.assertTrue(any(c["decision"] == "approved" for c in again["candidates"]))

        remaining = client2.get("/products?status=pending").get_data(as_text=True)
        self.assertIn("CULT ROCKER SLIM", remaining, "the unreviewed product is still queued")
        db2.close()

    def test_settings_can_be_changed_and_are_kept(self):
        data = self.client.post("/api/settings", json={
            "providers": {"google_cse": {"enabled": True, "api_key": "abc", "daily_budget": 50,
                                         "cx": "my-cx"}},
            "candidates_per_product": 10,
        }).get_json()
        self.assertTrue(data["ok"])
        self.assertTrue(self.settings.config_path.exists())
        saved = json.loads(self.settings.config_path.read_text())
        self.assertEqual(saved["providers"]["google_cse"]["daily_budget"], 50)
        self.assertEqual(saved["candidates_per_product"], 10)

    def test_the_settings_page_states_the_costs(self):
        body = self.client.get("/settings").get_data(as_text=True)
        self.assertIn("US$5 per 1,000", body)
        self.assertIn("Free", body)
        self.assertIn("billable", body)

    def test_nothing_is_published_by_the_tool(self):
        """There is no endpoint that writes to the website or to AWS."""
        routes = {rule.rule for rule in self.app.url_map.iter_rules()}
        for route in routes:
            self.assertNotIn("publish", route)
            self.assertNotIn("deploy", route)
        # and the export writes only inside its own folder
        self._import()
        exported = self.client.post("/api/export", json={}).get_json()
        self.assertTrue(exported["export_dir"].startswith(str(self.home)))


if __name__ == "__main__":
    unittest.main()
