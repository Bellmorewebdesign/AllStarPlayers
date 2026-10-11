"""Run with: python -m unittest discover -s tools -p 'test_*.py'."""
import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("importer", Path(__file__).with_name("import-square-catalog.py"))
importer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(importer)
STOCK = "Current Quantity ALLSTAR PLAYERS"


def row(**updates):
    data = {"Item Name": "Example", "Token": "VAR1", "Price": 100,
            "Variation Name": "BLACK, M", STOCK: 1,
            "Categories": "T-SHIRTS", "Sellable": "", "Archived": "N"}
    data.update(updates)
    return data


class ImportTests(unittest.TestCase):
    def test_only_positive_known_sellable_stock(self):
        for quantity in [0, -1, "", None, "1", float("nan"), float("inf"), True]:
            self.assertEqual(importer.build_catalog([row(**{STOCK: quantity})], STOCK), [])
        for flag, value in [("Archived", "Y"), ("Sellable", "N")]:
            self.assertEqual(importer.build_catalog([row(**{flag: value})], STOCK), [])
        self.assertEqual(len(importer.build_catalog([row(**{STOCK: 0.5})], STOCK)), 1)

    def test_available_variations_and_category_inheritance(self):
        products = importer.build_catalog([
            row(**{STOCK: 0}),
            row(**{"Token": "VAR2", "Categories": "", "Variation Name": "WHITE, L", "Price": 80}),
            row(**{"Token": "VAR3", "Categories": "", "Variation Name": "WHITE, XL", "Price": 120}),
        ], STOCK)
        self.assertEqual(products[0]["categories"], ["t-shirts"])
        self.assertEqual([v["id"] for v in products[0]["variants"]], ["VAR2", "VAR3"])
        self.assertEqual((products[0]["price"], products[0]["priceMax"]), (80, 120))

    def test_variable_price_and_no_internal_data(self):
        product = importer.build_catalog([row(**{
            "Price": "variable", "Default Unit Cost": 42, "Default Vendor Name": "Supplier",
            "SKU": "INTERNAL", "Description": "<p>Retail <b>description</b></p>"
        })], STOCK)[0]
        self.assertIsNone(product["price"])
        self.assertTrue(product["hasVariablePrice"])
        self.assertIsNone(product["variants"][0]["price"])
        self.assertEqual(product["description"], "Retail description")
        self.assertNotIn("Default Unit Cost", product)
        self.assertNotIn("SKU", product)
        self.assertNotIn(STOCK, product)
        self.assertNotIn("Default Vendor Name", product)

    def test_ids_stable_and_missing_or_duplicate_ids_rejected(self):
        one = importer.build_catalog([row()], STOCK)[0]["id"]
        two = importer.build_catalog([row(**{"Price": 50})], STOCK)[0]["id"]
        self.assertEqual(one, two)
        for rows in [[row(), row()], [row(**{"Token": ""})]]:
            with self.assertRaises(ValueError):
                importer.build_catalog(rows, STOCK)


if __name__ == "__main__":
    unittest.main()
