"""A stand-in for everything this program talks to.

One small HTTP server that answers like the store API, like each image-search
provider, and like an image host — including the awkward cases: an expired
catalog cursor, a rate limit, a 403 on an image, an HTML page where a JPEG
should be.

The point is that the real provider classes, the real catalog walker and the
real downloader run against real HTTP here. What is NOT tested is the live
providers' actual payloads; see the README's "what was tested" section.
"""
from __future__ import annotations

import io
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

from PIL import Image


def _png(width=800, height=600, color=(180, 40, 40)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (width, height), color).save(buf, "PNG")
    return buf.getvalue()


class FakeState:
    """Knobs the tests turn."""

    def __init__(self):
        self.products: list[dict] = []
        self.categories: list[dict] = []
        self.build_id = "20261013T000000Z-aaaaaa"
        self.page_size = 2
        # Make the next cursor-continuing request answer 409, once.
        self.expire_cursor_once = False
        # Provider behaviour
        self.openverse_results = 3
        self.wikimedia_results = 2
        self.rate_limit_openverse_times = 0
        self.google_fail_with = None       # e.g. 500
        self.calls: list[str] = []


class _Handler(BaseHTTPRequestHandler):
    state: FakeState = None  # type: ignore[assignment]

    def log_message(self, *args):  # keep the test output quiet
        pass

    # ---- helpers ----
    def _json(self, code: int, payload: dict):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _bytes(self, code: int, body: bytes, content_type: str):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ---- routes ----
    def do_GET(self):  # noqa: N802  (the stdlib spells it this way)
        url = urlparse(self.path)
        query = {k: v[0] for k, v in parse_qs(url.query).items()}
        state = self.state
        state.calls.append(url.path)

        # ---------- the store API ----------
        if url.path == "/default/catalog":
            return self._catalog(query)

        # ---------- Openverse ----------
        if url.path == "/v1/images/":
            if state.rate_limit_openverse_times > 0:
                state.rate_limit_openverse_times -= 1
                self.send_response(429)
                self.send_header("Retry-After", "0")
                self.end_headers()
                return
            results = [{
                "id": f"ov-{i}",
                "title": f"{query.get('q', '')} photo {i}",
                "url": f"http://{self.headers['Host']}/img/ov-{i}.png",
                "thumbnail": f"http://{self.headers['Host']}/img/ov-{i}.png",
                "foreign_landing_url": f"http://example.invalid/openverse/{i}",
                "license": "by-sa", "license_version": "4.0",
                "license_url": "https://creativecommons.org/licenses/by-sa/4.0/",
                "creator": f"Photographer {i}", "source": "flickr",
                "width": 1200, "height": 900,
            } for i in range(state.openverse_results)]
            return self._json(200, {"result_count": len(results), "results": results})

        # ---------- Wikimedia ----------
        if url.path == "/w/api.php":
            pages = [{
                "pageid": 1000 + i,
                "title": f"File:{query.get('gsrsearch', 'x')} {i}.jpg",
                "imageinfo": [{
                    "url": f"http://{self.headers['Host']}/img/wm-{i}.png",
                    "thumburl": f"http://{self.headers['Host']}/img/wm-{i}.png",
                    "descriptionurl": f"http://example.invalid/commons/{i}",
                    "width": 2000, "height": 1500, "user": "CommonsUser",
                    "extmetadata": {
                        "LicenseShortName": {"value": "CC BY-SA 4.0"},
                        "LicenseUrl": {"value": "https://creativecommons.org/licenses/by-sa/4.0/"},
                        "Artist": {"value": "<a href='#'>A. Photographer</a>"},
                        "UsageTerms": {"value": "Creative Commons Attribution-Share Alike 4.0"},
                    },
                }],
            } for i in range(state.wikimedia_results)]
            return self._json(200, {"query": {"pages": pages}})

        # ---------- Google Programmable Search ----------
        if url.path == "/customsearch/v1":
            if state.google_fail_with:
                code, state.google_fail_with = state.google_fail_with, None
                return self._json(code, {"error": {"message": "boom"}})
            items = [{
                "title": f"result {i}", "link": f"http://{self.headers['Host']}/img/g-{i}.png",
                "displayLink": "shop.invalid",
                "image": {"contextLink": f"http://shop.invalid/p/{i}",
                          "thumbnailLink": f"http://{self.headers['Host']}/img/g-{i}.png",
                          "width": 900, "height": 900},
            } for i in range(2)]
            return self._json(200, {"items": items})

        # ---------- image hosts ----------
        if url.path.startswith("/img/"):
            return self._bytes(200, _png(), "image/png")
        if url.path == "/blocked.png":
            return self._bytes(403, b"nope", "text/plain")
        if url.path == "/html.png":
            return self._bytes(200, b"<html><body>sign in</body></html>", "text/html")
        if url.path == "/broken.png":
            return self._bytes(200, b"this is not an image", "image/png")

        self._json(404, {"error": "not found"})

    # ---- the store API, with pinned cursors ----
    def _catalog(self, query: dict):
        state = self.state
        raw = query.get("cursor")
        limit = int(query.get("limit", state.page_size))

        if raw and state.expire_cursor_once:
            state.expire_cursor_once = False
            return self._json(409, {
                "success": False, "error": "CATALOG_CURSOR_EXPIRED",
                "message": "the product list was updated while you were browsing",
                "buildId": state.build_id,
            })

        offset = 0
        if raw:
            build, _, pos = raw.partition("~")
            if build != state.build_id:
                return self._json(409, {"success": False, "error": "CATALOG_CURSOR_EXPIRED",
                                        "buildId": state.build_id})
            offset = int(pos)

        page = state.products[offset:offset + limit]
        next_offset = offset + limit
        payload = {
            "success": True, "environment": "production", "buildId": state.build_id,
            "fetchedAt": "2026-10-13T00:00:00Z", "ageSeconds": 10, "stale": False,
            "total": len(state.products), "products": page,
            "cursor": f"{state.build_id}~{next_offset}" if next_offset < len(state.products) else None,
        }
        if offset == 0:
            payload["categories"] = state.categories
            payload["counts"] = {"products": len(state.products)}
        return self._json(200, payload)


class FakeServer:
    """Runs the handler on a free port for the life of a test."""

    def __init__(self, state: FakeState | None = None):
        self.state = state or FakeState()
        handler = type("BoundHandler", (_Handler,), {"state": self.state})
        self.httpd = HTTPServer(("127.0.0.1", 0), handler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.thread.join(timeout=5)

    @property
    def base(self) -> str:
        host, port = self.httpd.server_address[:2]
        return f"http://{host}:{port}"


def product(square_id: str, name: str, *, images=0, variations=1, colors=("BLACK",),
            sku=None, category="CAT1") -> dict:
    """A catalog product shaped like the real API's."""
    return {
        "id": square_id,
        "name": name,
        "description": "",
        "categoryIds": [category] if category else [],
        "imageUrls": [f"http://example.invalid/square/{square_id}.jpg"] * images,
        "optionAxes": [{"optionId": "O1", "name": "COLOR",
                        "values": [{"valueId": f"V{i}", "name": c} for i, c in enumerate(colors)]}],
        "variations": [{
            "id": f"{square_id}-v{i}", "name": f"{colors[0]} / M", "sku": sku,
            "options": [{"optionId": "O1", "optionName": "COLOR",
                         "valueId": "V0", "valueName": colors[0]}],
            "price": {"amount": 4500, "currency": "USD"},
            "inventory": {"state": "IN_STOCK", "quantity": 3},
            "sellable": True, "imageUrls": [],
        } for i in range(variations)],
        "priceRange": {"min": 4500, "max": 4500, "currency": "USD"},
        "hasUnpriceableVariations": False, "hasUnknownStock": False,
    }
