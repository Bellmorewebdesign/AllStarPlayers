"""Turning a catalog row into something worth typing into an image search.

This is ordinary string handling — a brand list, some tidying, a few rules
about what makes a search specific — and no model of any kind. The queries it
writes are a starting point: the review page lets you rewrite them, and a
vague one is flagged so you know to.
"""
from __future__ import annotations

import re

# Brands the shop actually carries, so a product named "AIR JORDAN 4 RETRO"
# searches as a Jordan 4 rather than as four unrelated words. Add to this as
# the catalog changes; it is only ever used to make a search more specific.
BRANDS = [
    "AIR JORDAN", "JORDAN", "NIKE", "AIR FORCE 1", "AIR MAX", "DUNK", "KOBE",
    "ADIDAS", "YEEZY", "NEW BALANCE", "ASICS", "PUMA", "REEBOK", "CONVERSE",
    "VANS", "TIMBERLAND", "CROCS", "UGG", "FILA", "SKECHERS",
    "SUPREME", "LACOSTE", "POLO RALPH LAUREN", "POLO", "CHAMPION", "CARHARTT",
    "THE NORTH FACE", "NORTH FACE", "LEVIS", "LEVI'S", "COOKIES", "NEW ERA",
    "CITYLAB", "ORIGINAL MINT", "STACK IT UP", "AKOMPLICE", "HUDSON", "CULT",
]

# Words that describe a garment rather than identify one. A query made only of
# these is too vague to trust, and the UI says so.
GENERIC = {
    "TEE", "T-SHIRT", "TSHIRT", "SHIRT", "HOODY", "HOODIE", "SWEATER", "CREW",
    "PANTS", "SHORTS", "DENIM", "JEANS", "JACKET", "COAT", "VEST", "HAT", "CAP",
    "BEANIE", "SOCKS", "BAG", "JERSEY", "POLO", "THERMAL", "THERMALS", "LOGO",
    "SET", "PRINT", "CLASSIC", "ORIGINAL", "NEW", "MENS", "WOMENS", "KIDS",
}

COLOR_WORDS = {
    "BLACK", "WHITE", "RED", "BLUE", "GREEN", "YELLOW", "ORANGE", "PURPLE",
    "PINK", "BROWN", "GREY", "GRAY", "NAVY", "CREAM", "BEIGE", "TAN", "GOLD",
    "SILVER", "OLIVE", "KHAKI", "BURGUNDY", "MAROON", "TEAL", "MINT", "WINE",
    "SAND", "STONE", "CHARCOAL", "IVORY", "BONE", "TAXI",
}

_WS = re.compile(r"\s+")
_PUNCT = re.compile(r"[^\w\s'/-]")


def _clean(text: str) -> str:
    text = _PUNCT.sub(" ", (text or "").replace("&", " and "))
    return _WS.sub(" ", text).strip()


def detect_brand(name: str) -> str | None:
    """The longest brand the name starts with or contains, or nothing."""
    upper = " " + _clean(name).upper() + " "
    best = None
    for brand in BRANDS:
        if f" {brand} " in upper or upper.strip().startswith(brand):
            if best is None or len(brand) > len(best):
                best = brand
    return best


def split_colors(colors: str) -> list[str]:
    parts = [c.strip() for c in (colors or "").split("|")]
    return [c for c in parts if c]


def looks_like_style_code(sku: str) -> bool:
    """Is this SKU worth searching for a picture?

    The shop's SKUs are mostly UPC/EAN barcodes — `194499969914` — which
    identify the item perfectly and are useless in an image search: nobody
    captions a photograph with a barcode. A manufacturer style code
    (`308497-060`, `CT8012-104`) is the opposite, and worth leading with.
    """
    sku = (sku or "").strip()
    if len(sku) < 5:
        return False
    digits = sum(ch.isdigit() for ch in sku)
    if sku.isdigit() and 11 <= len(sku) <= 14:
        return False                      # a barcode
    if sku.isdigit():
        return False                      # a bare number identifies nothing visually
    return digits > 0 and any(ch.isalpha() or ch == "-" for ch in sku)


def _mentions_color(name: str) -> bool:
    """Does the name already carry its colourway? `ASICS GEL-NYC BLACK/GREIGE`
    does, and bolting another variation's colour onto it describes a shoe that
    does not exist."""
    words = set(_clean(name).upper().split())
    return bool(words & COLOR_WORDS) or "/" in name


def _mentions(name: str, word: str) -> bool:
    if not word:
        return True
    name_words = set(_clean(name).upper().split())
    target = _clean(word).upper().rstrip("S")
    return any(w.rstrip("S") == target for w in name_words)


def is_vague(query: str) -> bool:
    """True when a query is made only of generic garment words, colours and
    numbers — the kind that returns a thousand unrelated products."""
    words = [w for w in _clean(query).upper().split() if w]
    if not words:
        return True
    meaningful = [
        w for w in words
        if w not in GENERIC and w not in COLOR_WORDS and not w.isdigit() and len(w) > 2
    ]
    return len(meaningful) == 0


def build(product: dict, *, max_queries: int = 4) -> list[str]:
    """Up to a handful of searches for one product, most specific first.

    `product` is a row from the products table (or anything with the same
    keys): name, skus, colors, category_names.
    """
    name = _clean(product.get("name") or "")
    if not name:
        return []

    brand = detect_brand(name)
    colors = split_colors(product.get("colors") or "")
    skus = [s for s in (product.get("skus") or "").split() if s]
    category = _clean((product.get("category_names") or "").split(" ")[0]).lower()

    queries: list[str] = []

    def add(text: str) -> None:
        text = _WS.sub(" ", text).strip()
        if text and text.lower() not in [q.lower() for q in queries]:
            queries.append(text)

    # 1. A manufacturer style code is the one unambiguous thing a product can
    #    carry, so when the shop recorded one it goes first. Barcodes do not
    #    count: no photograph is ever captioned with a UPC.
    for sku in skus[:2]:
        if looks_like_style_code(sku):
            add(f"{brand} {sku}" if brand else f"{name} {sku}")
            break

    # 2. The name as it stands. If a brand is in it, the name alone is usually
    #    the best search there is.
    add(name)

    # 3. Name plus the first colour, which is what separates one colourway
    #    from another — the thing most likely to be got wrong. Skipped when the
    #    name already states a colourway, because the colours on the other
    #    variations belong to other versions of this product.
    if colors and not _mentions_color(name):
        add(f"{name} {colors[0]}")

    # 4. A generic name needs a category to mean anything: "BLOWFISH" alone is
    #    a fish, "BLOWFISH tee" is a garment. Pointless when the name already
    #    says it, which is why "BLOWFISH TEE tee" is not generated.
    if category and not _mentions(name, category):
        if is_vague(name) or not brand:
            add(f"{name} {category}")

    return queries[:max_queries]


def describe(product: dict) -> dict:
    """What the review page shows above the query box, so the person can see
    what the generator had to work with."""
    name = product.get("name") or ""
    return {
        "brand": detect_brand(name),
        "colors": split_colors(product.get("colors") or ""),
        "skus": [s for s in (product.get("skus") or "").split() if s],
        "category": product.get("category_names") or "",
        "vague": is_vague(name),
    }
