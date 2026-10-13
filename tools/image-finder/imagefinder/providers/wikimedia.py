"""Wikimedia Commons — free, no key, licence published per file.

Commons is thin on current retail products but good for well-known models and
for anything with a museum or press-release photograph. Like Openverse it
publishes the licence as data, which is why it is on by default.

API: the MediaWiki action API, one call that both searches and returns image
info, so a search costs a single request.
"""
from __future__ import annotations

from .base import Candidate, Provider, ProviderError

DEFAULT_BASE = "https://commons.wikimedia.org"


class WikimediaProvider(Provider):
    name = "wikimedia"
    label = "Wikimedia Commons"
    billable = False
    needs_key = False
    cost_note = "Free. No key. Please keep the polite one-call-per-second pace."
    homepage = "https://commons.wikimedia.org/w/api.php"

    def search(self, query: str, limit: int) -> list[Candidate]:
        base = self._base_url(DEFAULT_BASE).rstrip("/")
        data = self._get(
            f"{base}/w/api.php",
            params={
                "action": "query",
                "format": "json",
                "formatversion": "2",
                "generator": "search",
                "gsrsearch": f"filetype:bitmap {query}",
                "gsrnamespace": "6",          # File:
                "gsrlimit": max(1, min(int(limit), 20)),
                "prop": "imageinfo",
                "iiprop": "url|size|extmetadata|user",
                "iiurlwidth": "400",          # gives us a thumbnail
            },
            headers={"User-Agent": "all-star-players-image-finder/1.0 (storefront photo sourcing)"},
        )
        if not isinstance(data, dict):
            raise ProviderError("bad_response", "unexpected payload shape")
        if "error" in data:
            raise ProviderError("bad_response", str(data["error"])[:200])

        pages = (data.get("query") or {}).get("pages") or []
        out: list[Candidate] = []
        for page in pages:
            info = (page.get("imageinfo") or [{}])[0]
            url = info.get("url")
            if not url:
                continue
            meta = info.get("extmetadata") or {}
            licence = _meta(meta, "LicenseShortName")
            usage = _meta(meta, "UsageTerms")
            artist = _strip_html(_meta(meta, "Artist"))
            out.append(Candidate(
                provider=self.name,
                provider_id=str(page.get("pageid") or ""),
                title=page.get("title") or "",
                source_page=info.get("descriptionurl") or "",
                image_url=url,
                thumb_url=info.get("thumburl") or url,
                width=_int(info.get("width")),
                height=_int(info.get("height")),
                license=licence or usage,
                license_url=_meta(meta, "LicenseUrl"),
                license_status="known" if (licence or usage) else "unknown",
                creator=artist or info.get("user"),
                source_name="Wikimedia Commons",
                query=query,
                raw={"pageid": page.get("pageid"), "title": page.get("title"),
                     "license": licence, "usage_terms": usage},
            ))
        return out


def _meta(meta: dict, key: str) -> str | None:
    entry = meta.get(key) or {}
    value = entry.get("value")
    return value.strip() if isinstance(value, str) and value.strip() else None


def _strip_html(value: str | None) -> str | None:
    if not value:
        return None
    import re
    return re.sub(r"<[^>]+>", "", value).strip() or None


def _int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None
