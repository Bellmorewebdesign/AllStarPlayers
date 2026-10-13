"""Query building: ordinary string work, no model, and honest about vagueness."""
from __future__ import annotations

import unittest

from imagefinder import queries


def row(name, **over):
    base = {"name": name, "skus": "", "colors": "", "category_names": ""}
    base.update(over)
    return base


class QueryTests(unittest.TestCase):
    def test_a_branded_name_searches_as_itself(self):
        out = queries.build(row("AIR JORDAN 4 RETRO", colors="BRED"))
        self.assertIn("AIR JORDAN 4 RETRO", out)
        self.assertTrue(any("BRED" in q for q in out), "the colourway gets its own search")

    def test_a_barcode_is_not_searched_for(self):
        """The real catalog's SKUs are mostly UPCs. No photograph is captioned
        with one, so leading with it would waste the first — and sometimes the
        only — search."""
        out = queries.build(row("AIR JORDAN 4 RETRO", skus="194499969914 194499969921"))
        self.assertFalse(any("194499969914" in q for q in out))
        self.assertEqual(out[0], "AIR JORDAN 4 RETRO")
        self.assertFalse(queries.looks_like_style_code("194499969914"))
        self.assertTrue(queries.looks_like_style_code("308497-060"))
        self.assertTrue(queries.looks_like_style_code("E552201"))

    def test_a_colourway_in_the_name_is_not_crossed_with_another_variation(self):
        """ASICS GEL-NYC BLACK/GREIGE with a DARK BROWN variation must not
        search for a shoe that does not exist."""
        out = queries.build(row("ASICS GEL-NYC BLACK/GREIGE", colors="DARK BROWN | CREAM"))
        self.assertFalse(any("DARK BROWN" in q for q in out), out)

    def test_the_category_is_not_repeated_back(self):
        out = queries.build(row("BLOWFISH TEE", category_names="TEE"))
        self.assertFalse(any(q.lower().endswith("tee tee") for q in out), out)

    def test_a_style_code_leads(self):
        out = queries.build(row("AIR JORDAN 4 RETRO", skus="308497-060"))
        self.assertIn("308497-060", out[0], "the one unambiguous thing goes first")
        self.assertIn("JORDAN", out[0])

    def test_a_generic_name_is_given_its_category(self):
        out = queries.build(row("BLOWFISH TEE", category_names="T-SHIRTS"))
        self.assertTrue(any("t-shirts" in q.lower() for q in out))

    def test_brands_are_recognised_inside_a_name(self):
        self.assertEqual(queries.detect_brand("WMNS NIKE DUNK LOW DISRUPT"), "NIKE")
        self.assertEqual(queries.detect_brand("COOKIES ROLLING TRAY"), "COOKIES")
        self.assertIsNone(queries.detect_brand("PUNK NOMAD"))

    def test_vagueness_is_flagged_rather_than_guessed_at(self):
        self.assertTrue(queries.is_vague("BLACK TEE"))
        self.assertTrue(queries.is_vague("HOODY"))
        self.assertTrue(queries.is_vague("2X"))
        self.assertFalse(queries.is_vague("HORSESHOE TEE"))
        self.assertFalse(queries.is_vague("AIR JORDAN 4 RETRO"))

    def test_no_queries_for_an_empty_name(self):
        self.assertEqual(queries.build(row("")), [])

    def test_queries_are_distinct_and_capped(self):
        out = queries.build(row("CULT ROCKER SLIM", colors="INDIGO | BLACK",
                                category_names="DENIM", skus="CR-602"), max_queries=4)
        self.assertLessEqual(len(out), 4)
        self.assertEqual(len(out), len(set(q.lower() for q in out)))

    def test_describe_gives_the_review_page_its_facts(self):
        hints = queries.describe(row("AIR JORDAN 4 RETRO", colors="BRED | WHITE",
                                     skus="308497-060", category_names="SNEAKERS"))
        self.assertEqual(hints["brand"], "AIR JORDAN")
        self.assertEqual(hints["colors"], ["BRED", "WHITE"])
        self.assertEqual(hints["skus"], ["308497-060"])
        self.assertFalse(hints["vague"])

    def test_punctuation_does_not_leak_into_a_search(self):
        out = queries.build(row("19 DIAMONDS Yankee's"))
        self.assertTrue(out)
        for query in out:
            self.assertNotIn("&", query)
            self.assertNotIn("  ", query)


if __name__ == "__main__":
    unittest.main()
