"""Importing the catalog from the public store API.

The API is read-only and needs no credential: the Square token lives in AWS and
never leaves it. Two details of the contract matter here.

Pinned cursors. `GET /catalog` answers with `cursor: "<buildId>~<offset>"`, and
that cursor continues *that build* of the catalog. Page one of one build plus
page two of another would be a list with products missing and products
repeated, so the cursor must be passed back exactly as given and never taken
apart.

Expiry. When the build a cursor names has been cleaned up, the API answers
409 CATALOG_CURSOR_EXPIRED rather than quietly moving the page to the current
build. The only correct response is to throw away what has been collected and
start again from page one, which is what `import_products` does.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field

import requests

from .db import Database, now


class CatalogError(RuntimeError):
    def __init__(self, message: str, *, kind: str = "catalog_failed", status: int | None = None):
        super().__init__(message)
        self.kind = kind
        self.status = status


@dataclass
class ImportResult:
    products: int = 0
    pages: int = 0
    restarts: int = 0
    build_id: str | None = None
    missing_photo: int = 0
    categories: dict = field(default_factory=dict)


def _color_values(product: dict) -> list[str]:
    """Colour names as the shop typed them, from the option axes and the
    variation names. Used to build searches; never shown as fact."""
    colors: list[str] = []
    for axis in product.get("optionAxes") or []:
        name = (axis.get("name") or "").upper()
        if "COLOR" not in name and "COLOUR" not in name:
            continue
        for value in axis.get("values") or []:
            label = (value.get("name") or "").strip()
            if label and label not in colors:
                colors.append(label)
    if not colors:
        for variation in product.get("variations") or []:
            for option in variation.get("options") or []:
                if "COLOR" in (option.get("optionName") or "").upper():
                    label = (option.get("valueName") or "").strip()
                    if label and label not in colors:
                        colors.append(label)
    return colors


def _size_values(product: dict) -> list[str]:
    sizes: list[str] = []
    for axis in product.get("optionAxes") or []:
        name = (axis.get("name") or "").upper()
        if "COLOR" in name or "COLOUR" in name:
            continue
        for value in axis.get("values") or []:
            label = (value.get("name") or "").strip()
            if label and label not in sizes:
                sizes.append(label)
    return sizes


def _square_image_count(product: dict) -> int:
    count = len(product.get("imageUrls") or [])
    for variation in product.get("variations") or []:
        count += len(variation.get("imageUrls") or [])
    return count


def fetch_page(api_base: str, cursor: str | None, *, limit: int = 300,
               timeout: float = 30.0, session: requests.Session | None = None) -> dict:
    """One page. Raises CatalogError, with `kind='cursor_expired'` for the 409."""
    http = session or requests
    params = {"limit": str(limit)}
    if cursor:
        params["cursor"] = cursor
    try:
        response = http.get(f"{api_base.rstrip('/')}/catalog", params=params, timeout=timeout)
    except requests.RequestException as exc:  # network, DNS, TLS, timeout
        raise CatalogError(f"could not reach the store API: {exc}", kind="network") from exc

    if response.status_code == 409:
        body = _json_or_empty(response)
        if body.get("error") == "CATALOG_CURSOR_EXPIRED":
            raise CatalogError("the catalog was rebuilt while we were reading it",
                               kind="cursor_expired", status=409)
    if response.status_code == 503:
        body = _json_or_empty(response)
        raise CatalogError(body.get("message") or "the catalog is not ready yet",
                           kind="catalog_warming", status=503)
    if response.status_code != 200:
        raise CatalogError(f"the store API answered {response.status_code}",
                           kind="http_error", status=response.status_code)

    body = _json_or_empty(response)
    if body.get("success") is not True:
        raise CatalogError("the store API reported a problem", kind="bad_response",
                           status=response.status_code)
    return body


def _json_or_empty(response) -> dict:
    try:
        return response.json() or {}
    except ValueError:
        return {}


def import_products(db: Database, api_base: str, *, limit: int = 300, max_restarts: int = 3,
                    session: requests.Session | None = None,
                    progress=None) -> ImportResult:
    """Walk every page and write the products into SQLite.

    Re-running it is safe and cheap: products are upserted by Square id, so
    prices and stock move with the catalog while your queries, candidates and
    decisions stay where they are.
    """
    attempt = 0
    while True:
        result = ImportResult(restarts=attempt)
        cursor: str | None = None
        categories: dict[str, str] = {}
        seen: set[str] = set()
        try:
            while True:
                page = fetch_page(api_base, cursor, limit=limit, session=session)
                result.pages += 1
                if page.get("buildId"):
                    result.build_id = page["buildId"]
                for category in page.get("categories") or []:
                    categories[category["id"]] = category.get("name") or category["id"]

                for product in page.get("products") or []:
                    _store(db, product, categories, result.build_id)
                    seen.add(product["id"])
                    result.products += 1
                    if _square_image_count(product) == 0:
                        result.missing_photo += 1

                if progress:
                    progress(result.products, page.get("total") or 0)

                cursor = page.get("cursor")
                if not cursor:
                    break
            result.categories = categories
            db.set_meta("last_import_at", now())
            db.set_meta("last_import_build", result.build_id or "")
            db.set_meta("last_import_count", str(result.products))
            db.log("catalog_imported",
                   f"{result.products} products, build {result.build_id}, {result.pages} pages")
            return result

        except CatalogError as exc:
            if exc.kind == "cursor_expired" and attempt < max_restarts:
                # The catalog was rebuilt underneath us. Everything collected so
                # far belongs to a build that is going away: start again.
                attempt += 1
                db.log("catalog_cursor_expired", f"restart {attempt}")
                time.sleep(1.0)
                continue
            raise


def _store(db: Database, product: dict, categories: dict, build_id: str | None) -> None:
    prices = product.get("priceRange") or {}
    skus = [v.get("sku") for v in product.get("variations") or [] if v.get("sku")]
    db.upsert_product({
        "square_id": product["id"],
        "name": (product.get("name") or "").strip(),
        "description": (product.get("description") or "").strip(),
        "category_ids": " ".join(product.get("categoryIds") or []),
        "category_names": " ".join(
            categories.get(cid, "") for cid in (product.get("categoryIds") or [])
        ).strip(),
        "skus": " ".join(skus),
        "colors": " | ".join(_color_values(product)),
        "sizes": " | ".join(_size_values(product)),
        "variation_count": len(product.get("variations") or []),
        "square_image_count": _square_image_count(product),
        "price_min": prices.get("min"),
        "price_max": prices.get("max"),
        "currency": prices.get("currency"),
        "build_id": build_id,
        "imported_at": now(),
        "updated_at": now(),
    })
