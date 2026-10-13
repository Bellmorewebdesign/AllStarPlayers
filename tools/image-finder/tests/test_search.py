"""Searching: the providers, the cache, the budget, the pacing, the retries,
and telling the three failures apart.

These run the real provider classes over real HTTP against a stand-in server,
so the request building, the parsing and the error handling are all exercised.
What is not exercised is the live services' own payloads.
"""
from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from imagefinder.config import Settings, default_providers
from imagefinder.db import Database
from imagefinder.search import SearchService

from .fakes import FakeServer, FakeState


def settings_for(server: FakeServer, home: Path) -> Settings:
    settings = Settings(home=home, api_base=server.base + "/default")
    settings.providers = default_providers()
    # Point each provider at the stand-in, and take the pacing out of the way
    # except where a test puts it back.
    for name, provider in settings.providers.items():
        provider.extra["base_url"] = server.base
        provider.min_interval_seconds = 0
    settings.providers["google_cse"].enabled = True
    settings.providers["google_cse"].api_key = "test-key"
    settings.providers["google_cse"].extra["cx"] = "test-cx"
    settings.providers["google_cse"].daily_budget = 5
    settings.providers["brave"].enabled = False
    settings.candidates_per_product = 8
    settings.per_provider_limit = 6
    settings.max_retries = 3
    settings.ensure_dirs()
    return settings


class SearchTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.db = Database(self.home / "t.sqlite3")
        self.db.upsert_product({
            "square_id": "P1", "name": "AIR JORDAN 4 RETRO", "description": "",
            "category_ids": "C1", "category_names": "SNEAKERS", "skus": "308497-060",
            "colors": "BRED", "sizes": "9 | 10", "variation_count": 2,
            "square_image_count": 0, "price_min": 20000, "price_max": 20000,
            "currency": "USD", "build_id": "b", "imported_at": "now", "updated_at": "now",
        })
        self.state = FakeState()

    def tearDown(self):
        self.db.close()
        self.tmp.cleanup()

    # ---------------------------------------------------------- happy path
    def test_collects_candidates_from_several_providers(self):
        with FakeServer(self.state) as server:
            settings = settings_for(server, self.home)
            service = SearchService(self.db, settings, sleep=lambda _s: None)
            report = service.search_product("P1", ["air jordan 4 retro bred"])

        self.assertEqual(report.status, "reviewing")
        self.assertGreaterEqual(report.total_candidates, 5)
        rows = self.db.candidates_for("P1")
        providers = {row["provider"] for row in rows}
        self.assertIn("openverse", providers)
        self.assertIn("wikimedia", providers)
        # Licences that the provider published arrive as facts…
        openverse = [r for r in rows if r["provider"] == "openverse"][0]
        self.assertEqual(openverse["license_status"], "known")
        self.assertIn("BY-SA", openverse["license"])
        self.assertTrue(openverse["source_page"])
        self.assertEqual(openverse["width"], 1200)

    def test_a_web_search_never_claims_to_know_the_rights(self):
        """Google can be asked for a rights filter; what comes back is not a
        licence, so it is recorded as unknown no matter what."""
        with FakeServer(self.state) as server:
            settings = settings_for(server, self.home)
            service = SearchService(self.db, settings, sleep=lambda _s: None)
            service.search_one("P1", "google_cse", "air jordan 4 bred")

        rows = [r for r in self.db.candidates_for("P1") if r["provider"] == "google_cse"]
        self.assertTrue(rows)
        for row in rows:
            self.assertEqual(row["license_status"], "unknown")
            self.assertIsNone(row["license"])

    # --------------------------------------------------------------- cache
    def test_the_same_search_is_only_paid_for_once(self):
        with FakeServer(self.state) as server:
            settings = settings_for(server, self.home)
            service = SearchService(self.db, settings, sleep=lambda _s: None)
            first = service.search_one("P1", "openverse", "jordan 4")
            calls_after_first = self.state.calls.count("/v1/images/")
            second = service.search_one("P1", "openverse", "jordan 4")
            calls_after_second = self.state.calls.count("/v1/images/")

        self.assertFalse(first.cached)
        self.assertTrue(second.cached)
        self.assertEqual(calls_after_first, calls_after_second, "the second search hit the cache")
        self.assertEqual(second.outcome, "ok")

    def test_refresh_pays_again_on_purpose(self):
        with FakeServer(self.state) as server:
            settings = settings_for(server, self.home)
            service = SearchService(self.db, settings, sleep=lambda _s: None)
            service.search_one("P1", "openverse", "jordan 4")
            before = self.state.calls.count("/v1/images/")
            again = service.search_one("P1", "openverse", "jordan 4", refresh=True)
            after = self.state.calls.count("/v1/images/")

        self.assertFalse(again.cached)
        self.assertEqual(after, before + 1)

    def test_a_search_another_product_paid_for_is_reused_free(self):
        self.db.upsert_product({
            "square_id": "P2", "name": "AIR JORDAN 4 RETRO", "description": "",
            "category_ids": "", "category_names": "", "skus": "", "colors": "",
            "sizes": "", "variation_count": 1, "square_image_count": 0,
            "price_min": 1, "price_max": 1, "currency": "USD", "build_id": "b",
            "imported_at": "now", "updated_at": "now",
        })
        with FakeServer(self.state) as server:
            settings = settings_for(server, self.home)
            service = SearchService(self.db, settings, sleep=lambda _s: None)
            service.search_one("P1", "openverse", "jordan 4 retro")
            before = self.state.calls.count("/v1/images/")
            outcome = service.search_one("P2", "openverse", "jordan 4 retro")
            after = self.state.calls.count("/v1/images/")

        self.assertEqual(after, before, "nothing was searched again")
        self.assertTrue(outcome.cached)
        self.assertTrue(self.db.candidates_for("P2"), "the results were attached to P2 as well")

    # -------------------------------------------------------------- budget
    def test_a_billable_provider_stops_at_its_budget(self):
        with FakeServer(self.state) as server:
            settings = settings_for(server, self.home)
            settings.providers["google_cse"].daily_budget = 2
            service = SearchService(self.db, settings, sleep=lambda _s: None)
            outcomes = [service.search_one("P1", "google_cse", f"query {i}") for i in range(4)]

        kinds = [o.outcome for o in outcomes]
        self.assertEqual(kinds[:2], ["ok", "ok"])
        self.assertEqual(kinds[2:], ["budget_exhausted", "budget_exhausted"])
        self.assertEqual(self.db.budget_used("google_cse"), 2)

    def test_a_billable_provider_with_no_budget_is_never_called(self):
        with FakeServer(self.state) as server:
            settings = settings_for(server, self.home)
            settings.providers["google_cse"].daily_budget = 0
            service = SearchService(self.db, settings, sleep=lambda _s: None)
            outcome = service.search_one("P1", "google_cse", "spend nothing")

        self.assertEqual(outcome.outcome, "budget_exhausted")
        self.assertEqual(self.state.calls.count("/customsearch/v1"), 0)

    def test_free_providers_have_no_budget_ceiling(self):
        with FakeServer(self.state) as server:
            settings = settings_for(server, self.home)
            service = SearchService(self.db, settings, sleep=lambda _s: None)
            self.assertIsNone(service.budget_left("openverse"))
            for i in range(5):
                self.assertEqual(service.search_one("P1", "openverse", f"q{i}").outcome, "ok")

    # ------------------------------------------------------ the three ends
    def test_no_matches_is_not_a_failure(self):
        self.state.openverse_results = 0
        with FakeServer(self.state) as server:
            settings = settings_for(server, self.home)
            settings.providers["wikimedia"].enabled = False
            settings.providers["google_cse"].enabled = False
            service = SearchService(self.db, settings, sleep=lambda _s: None)
            report = service.search_product("P1", ["something nobody photographed"])

        self.assertEqual(report.status, "no_matches")
        self.assertIn("nothing for this product", report.note)
        self.assertEqual(self.db.one("SELECT status FROM products WHERE square_id='P1'")["status"],
                         "no_matches")

    def test_a_provider_falling_over_is_a_search_failure(self):
        self.state.google_fail_with = 500
        with FakeServer(self.state) as server:
            settings = settings_for(server, self.home)
            settings.providers["openverse"].enabled = False
            settings.providers["wikimedia"].enabled = False
            settings.max_retries = 1
            service = SearchService(self.db, settings, sleep=lambda _s: None)
            report = service.search_product("P1", ["jordan"])

        self.assertEqual(report.status, "search_failed")
        self.assertIn("search itself failed", report.note)

    def test_a_rate_limit_is_waited_out_and_then_works(self):
        self.state.rate_limit_openverse_times = 1
        with FakeServer(self.state) as server:
            settings = settings_for(server, self.home)
            service = SearchService(self.db, settings, sleep=lambda _s: None)
            outcome = service.search_one("P1", "openverse", "jordan 4")

        self.assertEqual(outcome.outcome, "ok")
        self.assertGreater(len(outcome.candidates), 0)

    def test_a_provider_that_keeps_rate_limiting_is_recorded_as_such(self):
        self.state.rate_limit_openverse_times = 10
        with FakeServer(self.state) as server:
            settings = settings_for(server, self.home)
            settings.max_retries = 2
            service = SearchService(self.db, settings, sleep=lambda _s: None)
            outcome = service.search_one("P1", "openverse", "jordan 4")

        self.assertEqual(outcome.outcome, "rate_limited")
        row = self.db.one("SELECT * FROM searches WHERE provider='openverse'")
        self.assertEqual(row["outcome"], "rate_limited")

    def test_a_free_providers_outage_is_retried_later(self):
        """It cost nothing, so "the service was down" must not become this
        product's permanent answer."""
        self.state.rate_limit_openverse_times = 5
        with FakeServer(self.state) as server:
            settings = settings_for(server, self.home)
            settings.max_retries = 1
            service = SearchService(self.db, settings, sleep=lambda _s: None)
            first = service.search_one("P1", "openverse", "jordan 4")
            self.assertEqual(first.outcome, "rate_limited")

            self.state.rate_limit_openverse_times = 0     # the service recovers
            second = service.search_one("P1", "openverse", "jordan 4")

        self.assertFalse(second.cached, "a free failure is not a cached answer")
        self.assertEqual(second.outcome, "ok")

    def test_a_billable_failure_stays_cached(self):
        """It may have been charged for, so it is not repeated by accident."""
        self.state.google_fail_with = 500
        with FakeServer(self.state) as server:
            settings = settings_for(server, self.home)
            settings.max_retries = 1
            service = SearchService(self.db, settings, sleep=lambda _s: None)
            first = service.search_one("P1", "google_cse", "jordan 4")
            self.assertEqual(first.outcome, "search_failed")
            calls = self.state.calls.count("/customsearch/v1")
            second = service.search_one("P1", "google_cse", "jordan 4")

        self.assertTrue(second.cached)
        self.assertEqual(self.state.calls.count("/customsearch/v1"), calls)

    def test_a_provider_with_no_key_says_so_rather_than_failing(self):
        with FakeServer(self.state) as server:
            settings = settings_for(server, self.home)
            settings.providers["brave"].enabled = True
            settings.providers["brave"].api_key = ""
            service = SearchService(self.db, settings, sleep=lambda _s: None)
            outcome = service.search_one("P1", "brave", "jordan")

        self.assertEqual(outcome.outcome, "not_configured")
        self.assertIn("no API key", outcome.error_detail)

    # ----------------------------------------------------------- stopping
    def test_it_stops_once_it_has_enough(self):
        self.state.openverse_results = 12
        with FakeServer(self.state) as server:
            settings = settings_for(server, self.home)
            settings.candidates_per_product = 5
            service = SearchService(self.db, settings, sleep=lambda _s: None)
            report = service.search_product("P1", ["one", "two", "three"])

        self.assertGreaterEqual(report.total_candidates, 5)
        # The second and third queries were never needed.
        self.assertEqual(self.db.scalar("SELECT COUNT(*) FROM searches"), 1)

    def test_progress_survives_a_restart(self):
        """Stop the program, start it again: the cache and the candidates are
        still there, and nothing is searched twice."""
        with FakeServer(self.state) as server:
            settings = settings_for(server, self.home)
            service = SearchService(self.db, settings, sleep=lambda _s: None)
            service.search_product("P1", ["air jordan 4 retro bred"])
            calls_before = len(self.state.calls)
            self.db.close()

            # a brand new process would do exactly this
            db2 = Database(self.home / "t.sqlite3")
            service2 = SearchService(db2, settings, sleep=lambda _s: None)
            report = service2.search_product("P1", ["air jordan 4 retro bred"])
            calls_after = len(self.state.calls)

            self.assertEqual(calls_before, calls_after, "a resumed run paid for nothing again")
            self.assertGreater(report.total_candidates, 0)
            self.assertTrue(db2.candidates_for("P1"))
            db2.close()


if __name__ == "__main__":
    unittest.main()
