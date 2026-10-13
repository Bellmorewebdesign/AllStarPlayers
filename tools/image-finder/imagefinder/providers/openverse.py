"""Openverse — openly licensed images, free, no key needed.

Openverse (run by the WordPress Foundation) indexes images that carry an open
licence and publishes that licence with every result, which is exactly what
this program needs: the licence arrives as data instead of as a guess.

Anonymous use is allowed and rate limited; registering gets a token and a
higher limit. Nothing here is billed, so it is on by default.

API: https://api.openverse.org/v1/images/
"""
from __future__ import annotations

from .base import Candidate, Provider, ProviderError

DEFAULT_BASE = "https://api.openverse.org"


class OpenverseProvider(Provider):
    name = "openverse"
    label = "Openverse (CC-licensed)"
    billable = False
    needs_key = False
    cost_note = "Free. No key required; an optional token raises the rate limit."
    homepage = "https://api.openverse.org/v1/"

    def search(self, query: str, limit: int) -> list[Candidate]:
        base = self._base_url(DEFAULT_BASE).rstrip("/")
        headers = {"User-Agent": "all-star-players-image-finder/1.0"}
        if self.settings.api_key:
            headers["Authorization"] = f"Bearer {self.settings.api_key}"

        data = self._get(
            f"{base}/v1/images/",
            params={
                "q": query,
                "page_size": max(1, min(int(limit), 20)),
                # Still images only, and nothing marked mature.
                "mature": "false",
            },
            headers=headers,
        )
        if not isinstance(data, dict):
            raise ProviderError("bad_response", "unexpected payload shape")

        out: list[Candidate] = []
        for row in data.get("results") or []:
            url = row.get("url")
            if not url:
                continue
            licence = row.get("license")
            version = row.get("license_version")
            pretty = None
            if licence:
                pretty = licence.upper().replace("_", "-")
                if version:
                    pretty = f"{pretty} {version}"
            out.append(Candidate(
                provider=self.name,
                provider_id=str(row.get("id") or ""),
                title=row.get("title") or "",
                source_page=row.get("foreign_landing_url") or row.get("detail_url") or "",
                image_url=url,
                thumb_url=row.get("thumbnail") or url,
                width=_int(row.get("width")),
                height=_int(row.get("height")),
                license=pretty,
                license_url=row.get("license_url"),
                # Openverse only indexes images that carry a licence, so this
                # is one of the few places "known" is honest.
                license_status="known" if licence else "unknown",
                creator=row.get("creator"),
                source_name=row.get("source") or row.get("provider"),
                query=query,
                raw=row,
            ))
        return out


def _int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None
