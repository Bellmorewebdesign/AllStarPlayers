"""Importing the catalog: paging, pinned cursors, and the rebuild mid-read."""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from imagefinder import catalog
from imagefinder.db import Database

from .fakes import FakeServer, FakeState, product


class CatalogImportTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = Database(Path(self.tmp.name) / "t.sqlite3")
        self.state = FakeState()
        self.state.categories = [{"id": "CAT1", "name": "T-SHIRTS"},
                                 {"id": "CAT2", "name": "SNEAKERS"}]
        self.state.products = [
            product("P1", " HORSESHOE TEE ", images=0, colors=("BLACK", "GOLD")),
            product("P2", "AIR JORDAN 4 RETRO", images=1, colors=("BRED",),
                    sku="308497-060", category="CAT2"),
            product("P3", "CULT ROCKER SLIM", images=0, colors=("INDIGO",)),
            product("P4", "FITTED CAP", images=2, colors=("NAVY",)),
            product("P5", "BLOWFISH TEE", images=0, colors=("WHITE",)),
        ]

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    def test_walks_every_page_of_one_build(self):
        self.state.page_size = 2
        with FakeServer(self.state) as server:
            result = catalog.import_products(self.db, server.base + "/default", limit=2)

        self.assertEqual(result.products, 5)
        self.assertEqual(result.pages, 3)          # 2 + 2 + 1
        self.assertEqual(result.build_id, self.state.build_id)
        self.assertEqual(result.missing_photo, 3)
        self.assertEqual(self.db.scalar("SELECT COUNT(*) FROM products"), 5)

    def test_cursors_are_passed_back_untouched(self):
        """The program must not build its own offsets: a cursor belongs to a
        build, and taking it apart is how pages get stitched across builds."""
        self.state.page_size = 2
        with FakeServer(self.state) as server:
            page = catalog.fetch_page(server.base + "/default", None, limit=2)
            self.assertTrue(page["cursor"].startswith(self.state.build_id + "~"))
            second = catalog.fetch_page(server.base + "/default", page["cursor"], limit=2)
            self.assertEqual(len(second["products"]), 2)
            self.assertNotEqual(second["products"][0]["id"], page["products"][0]["id"])

    def test_a_rebuild_mid_read_restarts_cleanly(self):
        """409 CATALOG_CURSOR_EXPIRED means start again, not carry on."""
        self.state.page_size = 2
        self.state.expire_cursor_once = True
        with FakeServer(self.state) as server:
            result = catalog.import_products(self.db, server.base + "/default", limit=2)

        self.assertEqual(result.restarts, 1)
        self.assertEqual(result.products, 5, "every product landed exactly once")
        self.assertEqual(self.db.scalar("SELECT COUNT(*) FROM products"), 5)

    def test_colours_sizes_and_skus_are_kept_for_searching(self):
        with FakeServer(self.state) as server:
            catalog.import_products(self.db, server.base + "/default", limit=50)
        row = self.db.one("SELECT * FROM products WHERE square_id='P2'")
        self.assertEqual(row["name"], "AIR JORDAN 4 RETRO")
        self.assertIn("BRED", row["colors"])
        self.assertIn("308497-060", row["skus"])
        self.assertEqual(row["category_names"], "SNEAKERS")
        self.assertEqual(row["square_image_count"], 1)

    def test_names_keep_their_square_whitespace_trimmed(self):
        with FakeServer(self.state) as server:
            catalog.import_products(self.db, server.base + "/default", limit=50)
        self.assertEqual(self.db.one("SELECT name FROM products WHERE square_id='P1'")["name"],
                         "HORSESHOE TEE")

    def test_reimport_keeps_work_and_updates_the_product(self):
        with FakeServer(self.state) as server:
            catalog.import_products(self.db, server.base + "/default", limit=50)
            self.db.add_query("P1", "horseshoe tee black", "edited")
            self.db.add_candidate("P1", None, {"provider": "openverse",
                                               "image_url": "http://x.invalid/a.png"})
            self.state.products[0]["name"] = "HORSESHOE TEE (2026)"
            catalog.import_products(self.db, server.base + "/default", limit=50)

        self.assertEqual(self.db.one("SELECT name FROM products WHERE square_id='P1'")["name"],
                         "HORSESHOE TEE (2026)")
        self.assertEqual(self.db.scalar("SELECT COUNT(*) FROM queries WHERE square_id='P1'"), 1)
        self.assertEqual(self.db.scalar("SELECT COUNT(*) FROM candidates WHERE square_id='P1'"), 1)

    def test_a_dead_api_is_reported_not_swallowed(self):
        with self.assertRaises(catalog.CatalogError) as caught:
            catalog.import_products(self.db, "http://127.0.0.1:9/default", limit=2)
        self.assertEqual(caught.exception.kind, "network")


if __name__ == "__main__":
    unittest.main()
