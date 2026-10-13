"""Google Programmable Search (Custom Search JSON API), image mode.

Finds far more current retail photography than the open-licence indexes do,
and tells you nothing reliable about rights: a `rights=` filter can be asked
for, but what comes back is a filter Google applied to its own index, not a
licence grant. So every result from here is recorded as **unknown** rights,
whatever the filter said, and cannot reach the manifest without somebody
checking the source page and saying so.

Money and availability, as of October 2026 — check the pricing page before
you enable it, because this one is moving:
  * 100 queries a day free, then US$5 per 1,000, capped at 10,000 a day.
  * Google's own documentation says the API is closed to new customers and is
    discontinued on 1 January 2027. If you do not already have a key it is
    probably not worth setting up.
Needs: an API key and a Programmable Search Engine id (cx) with "image search"
and "search the entire web" switched on.
"""
from __future__ import annotations

from .base import Candidate, Provider, ProviderError

DEFAULT_BASE = "https://www.googleapis.com"


class GoogleCseProvider(Provider):
    name = "google_cse"
    label = "Google Programmable Search (images)"
    billable = True
    needs_key = True
    cost_note = ("100 queries/day free, then about US$5 per 1,000 (max 10,000/day). "
                 "Closed to new customers; Google lists discontinuation on 2027-01-01. "
                 "Needs an API key and a search-engine id (cx). Rights are NOT verified.")
    homepage = "https://developers.google.com/custom-search/v1/overview"

    def configured(self) -> bool:
        return super().configured() and bool((self.settings.extra or {}).get("cx"))

    def why_not_configured(self) -> str:
        base = super().why_not_configured()
        if base:
            return base
        if not (self.settings.extra or {}).get("cx"):
            return "no search-engine id (cx) set"
        return ""

    def search(self, query: str, limit: int) -> list[Candidate]:
        base = self._base_url(DEFAULT_BASE).rstrip("/")
        params = {
            "key": self.settings.api_key,
            "cx": (self.settings.extra or {}).get("cx", ""),
            "q": query,
            "searchType": "image",
            "num": max(1, min(int(limit), 10)),   # the API's own ceiling
            "safe": "active",
        }
        rights = (self.settings.extra or {}).get("rights")
        if rights:
            params["rights"] = rights

        data = self._get(f"{base}/customsearch/v1", params=params)
        if not isinstance(data, dict):
            raise ProviderError("bad_response", "unexpected payload shape")
        if "error" in data:
            message = (data["error"] or {}).get("message", "")
            if "quota" in message.lower() or "limit" in message.lower():
                raise ProviderError("quota_exceeded", message[:200])
            raise ProviderError("bad_response", message[:200])

        out: list[Candidate] = []
        for row in data.get("items") or []:
            url = row.get("link")
            if not url:
                continue
            meta = row.get("image") or {}
            out.append(Candidate(
                provider=self.name,
                provider_id=row.get("cacheId") or url,
                title=row.get("title") or "",
                source_page=meta.get("contextLink") or "",
                image_url=url,
                thumb_url=meta.get("thumbnailLink") or url,
                width=_int(meta.get("width")),
                height=_int(meta.get("height")),
                # Deliberately not filled in. A search filter is not a licence.
                license=None,
                license_url=None,
                license_status="unknown",
                creator=None,
                source_name=row.get("displayLink"),
                query=query,
                raw={"displayLink": row.get("displayLink"), "mime": row.get("mime"),
                     "rights_filter": rights or ""},
            ))
        return out


def _int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None
