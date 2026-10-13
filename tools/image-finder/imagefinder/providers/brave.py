"""Brave Search API, image endpoint.

A general web image index — good coverage of current products, and, like any
web search, no licence information worth trusting. Everything from here is
recorded as **unknown** rights.

Money, as of October 2026 — check the dashboard before enabling, this one
changed recently:
  * Brave retired the old free tiers in early 2026. New accounts need a card,
    get roughly US$5 of monthly credit, and are billed about US$5 per 1,000
    requests on the Search plan (which covers the images endpoint).
Needs: a subscription token, sent as the X-Subscription-Token header.
"""
from __future__ import annotations

from .base import Candidate, Provider, ProviderError

DEFAULT_BASE = "https://api.search.brave.com"


class BraveProvider(Provider):
    name = "brave"
    label = "Brave Search (images)"
    billable = True
    needs_key = True
    cost_note = ("Paid. No free tier for new accounts since early 2026: a card is required, "
                 "about US$5/month of credit, then roughly US$5 per 1,000 requests. "
                 "Needs a subscription token. Rights are NOT verified.")
    homepage = "https://api-dashboard.search.brave.com/"

    def search(self, query: str, limit: int) -> list[Candidate]:
        base = self._base_url(DEFAULT_BASE).rstrip("/")
        data = self._get(
            f"{base}/res/v1/images/search",
            params={"q": query, "count": max(1, min(int(limit), 20)), "safesearch": "strict"},
            headers={
                "Accept": "application/json",
                "X-Subscription-Token": self.settings.api_key,
                "User-Agent": "all-star-players-image-finder/1.0",
            },
        )
        if not isinstance(data, dict):
            raise ProviderError("bad_response", "unexpected payload shape")

        out: list[Candidate] = []
        for row in data.get("results") or []:
            props = row.get("properties") or {}
            url = props.get("url") or row.get("url")
            if not url:
                continue
            thumb = (row.get("thumbnail") or {}).get("src") or url
            out.append(Candidate(
                provider=self.name,
                provider_id=str(row.get("id") or url),
                title=row.get("title") or "",
                source_page=row.get("url") or "",
                image_url=url,
                thumb_url=thumb,
                width=_int(props.get("width")),
                height=_int(props.get("height")),
                license=None,
                license_url=None,
                license_status="unknown",
                creator=None,
                source_name=(row.get("meta_url") or {}).get("netloc") or row.get("source"),
                query=query,
                raw={"page_age": row.get("page_age"), "source": row.get("source")},
            ))
        return out


def _int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None
