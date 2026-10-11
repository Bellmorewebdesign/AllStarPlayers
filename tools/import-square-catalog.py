#!/usr/bin/env python3
"""Build a public, browsing-only snapshot from an unmodified Square XLSX export."""
import argparse
import hashlib
import json
import math
from collections import defaultdict
from datetime import date
from html.parser import HTMLParser
from pathlib import Path

from openpyxl import load_workbook


CATEGORIES = [
    ("t-shirts", "T-Shirts"),
    ("hoodies-sweatshirts", "Hoodies & Sweatshirts"),
    ("pants", "Pants & Denim"),
    ("shorts", "Shorts"),
    ("sneakers", "Sneakers & Slides"),
    ("hats", "Hats"),
    ("accessories", "Accessories"),
    ("shirts-jerseys", "Shirts & Jerseys"),
    ("jackets", "Jackets & Coats"),
    ("underwear", "Underwear & Socks"),
    ("sets", "Sets"),
    ("other", "Other"),
]
CATEGORY_GROUPS = {
    "t-shirts": {"T-SHIRTS", "TEE", "LS TSHIRT", "TANK TOP", "THERMALS"},
    "hoodies-sweatshirts": {"HOODY", "SWEATER", "CREW"},
    "pants": {"DENIM", "PANTS", "SWEAT PANTS", "CARGO"},
    "shorts": {"SHORTS", "DENIM SHORTS", "SWIMMING TRUNKS"},
    "sneakers": {"SNEAKERS", "SLIDES"},
    "hats": {"HAT", "HATS", "BEANIE", "BUCKET"},
    "accessories": {"ACCESSORIES", "BAG", "BELT", "SKI MASK", "CLEANING SUPPLY"},
    "shirts-jerseys": {"SHIRTS", "JERSEY", "FLANNEL", "POLO"},
    "jackets": {"JACKETS", "LEATHER JACKET", "COAT", "VEST"},
    "underwear": {"UNDERWEAR", "BOXER", "SOCKS"},
    "sets": {"SWEATSUIT"},
}


def text(value):
    return str(value).strip() if value is not None else ""


class PlainText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []

    def handle_data(self, data):
        self.parts.append(data)


def description(value):
    parser = PlainText()
    parser.feed(text(value))
    return " ".join(" ".join(parser.parts).split())


def retail_price(value):
    try:
        number = float(value)
        return round(number, 2) if math.isfinite(number) and number >= 0 else None
    except (ValueError, TypeError):
        # Square's "variable" price must never become a made-up dollar amount.
        return None


def in_stock(row, stock_column):
    quantity = row.get(stock_column)
    return (
        isinstance(quantity, (int, float))
        and not isinstance(quantity, bool)
        and math.isfinite(quantity)
        and quantity > 0
        and text(row.get("Archived")).upper() != "Y"
        and text(row.get("Sellable")).upper() != "N"
    )


def build_catalog(rows, stock_column):
    groups = defaultdict(list)
    for row in rows:
        name = text(row.get("Item Name"))
        if name:
            groups[name].append(row)
    products = []
    for name, group in sorted(groups.items(), key=lambda pair: pair[0].casefold()):
        available = [row for row in group if in_stock(row, stock_column)]
        if not available:
            continue
        variants = []
        seen = set()
        for row in available:
            variant_id = text(row.get("Token"))
            if not variant_id or variant_id in seen:
                raise ValueError(f"Missing or duplicate variation identifier for {name}")
            seen.add(variant_id)
            options = [
                {"name": text(row.get(f"Option Name {i}")), "value": text(row.get(f"Option Value {i}"))}
                for i in range(1, 4) if text(row.get(f"Option Value {i}"))
            ]
            variants.append({
                "id": variant_id,
                "name": text(row.get("Variation Name")) or "Default",
                "options": options,
                "price": retail_price(row.get("Price")),
            })
        # Categories can be blank on a size row: inherit from the entire item group.
        raw_categories = set()
        for row in group:
            for category in text(row.get("Categories")).split(","):
                raw_categories.add(category.strip().split(" (")[0].upper())
        categories = [slug for slug, _ in CATEGORIES if raw_categories & CATEGORY_GROUPS.get(slug, set())]
        if not categories:
            categories = ["other"]
        prices = [variant["price"] for variant in variants if variant["price"] is not None]
        products.append({
            # An export has no parent item ID. This is a stable website grouping ID,
            # not an invented Square ID. Real variation IDs are kept on variants.
            "id": "stock-" + hashlib.sha256(name.encode()).hexdigest()[:16],
            "name": text(available[0].get("Customer-facing Name")) or name,
            "categories": categories,
            "description": next((description(row.get("Description")) for row in group if text(row.get("Description"))), ""),
            "stockSnapshot": True,
            "price": min(prices) if prices else None,
            "priceMax": max(prices) if prices else None,
            "hasVariablePrice": len(prices) != len(variants),
            "variants": variants,
        })
    return products


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("export", type=Path)
    parser.add_argument("--date", required=True, type=date.fromisoformat)
    parser.add_argument("--location", default="ALLSTAR PLAYERS")
    parser.add_argument("--output", type=Path, default=Path("js/stock-products.js"))
    parser.add_argument("--images", type=Path, default=Path("data/catalog-images.json"))
    args = parser.parse_args()
    stock_column = f"Current Quantity {args.location}"
    workbook = load_workbook(args.export, read_only=True, data_only=True)
    try:
        data = iter(workbook["Items"].values)
        headers = None
        for row in data:
            if "Item Name" in row and "Token" in row:
                headers = row
                break
        required = {"Item Name", "Token", "Price", "Archived", "Sellable", stock_column}
        if headers is None or not required.issubset(set(headers)):
            raise ValueError("Export is missing required item, price, or location stock columns.")
        products = build_catalog([dict(zip(headers, row)) for row in data], stock_column)
    finally:
        workbook.close()
    image_map = json.loads(args.images.read_text()) if args.images.exists() else {}
    for product in products:
        if product["id"] in image_map:
            photo = image_map[product["id"]]
            path = photo["image"]
            if not path.startswith("assets/img/products/") or ".." in path or not Path(path).is_file():
                raise ValueError(f"Photo must be an existing product asset: {path}")
            product.update(image=path, alt=text(photo.get("alt")) or product["name"])
    meta = {
        "date": args.date.isoformat(), "mode": "browse", "location": args.location,
        "productCount": len(products),
        "variantCount": sum(len(product["variants"]) for product in products),
    }
    encode = lambda value: json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    script = (
        "// Generated by tools/import-square-catalog.py. Public retail data only.\n"
        "(function () {\n  'use strict';\n  var ASP = window.ASP || (window.ASP = {});\n"
        f"  ASP.stockSnapshot = {encode(meta)};\n"
        f"  ASP.categories = {encode([{'slug': slug, 'name': label} for slug, label in CATEGORIES])};\n"
        "  ASP.items = [\n" + ",\n".join("    " + encode(product) for product in products) +
        "\n  ];\n  ASP.products = ASP.items;\n})();\n"
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(script, encoding="utf-8")
    print(json.dumps(meta))


if __name__ == "__main__":
    main()
