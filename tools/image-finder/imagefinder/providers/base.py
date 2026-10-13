"""What every image-search back end has to look like.

A provider turns a query string into candidates. It never decides anything:
ranking is not evidence that a picture shows the product, and a provider that
publishes no licence must say so rather than guess.
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict


# How a search can fail, kept apart because they mean different things to the
# person running this: a search that found nothing is not a search that broke.
NO_MATCHES = "no_matches"
SEARCH_FAILED = "search_failed"
RATE_LIMITED = "rate_limited"
NOT_CONFIGURED = "not_configured"
BUDGET_EXHAUSTED = "budget_exhausted"


class ProviderError(Exception):
    """Something went wrong talking to the provider.

    `kind` is one of: network, timeout, auth_failed, rate_limited,
    quota_exceeded, server_error, bad_response, not_configured.
    """

    def __init__(self, kind: str, detail: str = "", status: int | None = None,
                 retry_after: float | None = None):
        super().__init__(f"{kind}: {detail}" if detail else kind)
        self.kind = kind
        self.detail = detail
        self.status = status
        self.retry_after = retry_after

    @property
    def retryable(self) -> bool:
        return self.kind in {"network", "timeout", "server_error", "rate_limited"}


@dataclass
class Candidate:
    """One image a provider offered. Nothing here is a claim that it depicts
    the product — that judgement is a person's, recorded separately."""
    provider: str
    image_url: str
    provider_id: str = ""
    title: str = ""
    source_page: str = ""
    thumb_url: str = ""
    width: int | None = None
    height: int | None = None
    license: str | None = None
    license_url: str | None = None
    # "known" only when the provider published a licence for this image.
    license_status: str = "unknown"
    creator: str | None = None
    source_name: str | None = None
    query: str = ""
    raw: dict = field(default_factory=dict)

    def as_dict(self) -> dict:
        return asdict(self)


class Provider:
    name = "provider"
    label = "Provider"
    # Does calling it cost money or quota the user is paying for?
    billable = False
    needs_key = False
    # One line for the settings page: what it costs and what it needs.
    cost_note = ""
    homepage = ""

    def __init__(self, settings, http=None):
        self.settings = settings            # ProviderSettings
        self.http = http                    # requests.Session

    # ---- configuration ----
    def configured(self) -> bool:
        """Can this provider be called at all right now?"""
        if not self.settings.enabled:
            return False
        if self.needs_key and not self.settings.api_key:
            return False
        return True

    def why_not_configured(self) -> str:
        if not self.settings.enabled:
            return "switched off in settings"
        if self.needs_key and not self.settings.api_key:
            return "no API key set"
        return ""

    # ---- searching ----
    def search(self, query: str, limit: int) -> list[Candidate]:
        raise NotImplementedError

    # ---- helpers for subclasses ----
    def _base_url(self, default: str) -> str:
        """Lets a test point the provider at a local stand-in without touching
        the provider code."""
        return (self.settings.extra or {}).get("base_url") or default

    def _get(self, url: str, *, params=None, headers=None, timeout: float = 20.0):
        import requests
        session = self.http or requests
        try:
            response = session.get(url, params=params, headers=headers, timeout=timeout)
        except Exception as exc:  # requests raises a family of these
            kind = "timeout" if "timeout" in type(exc).__name__.lower() else "network"
            raise ProviderError(kind, str(exc)) from exc

        if response.status_code == 429:
            retry_after = response.headers.get("Retry-After")
            raise ProviderError("rate_limited", "the provider asked us to slow down",
                                status=429,
                                retry_after=float(retry_after) if _is_number(retry_after) else None)
        if response.status_code in (401, 403):
            raise ProviderError("auth_failed", "the provider rejected the key",
                                status=response.status_code)
        if response.status_code == 402:
            raise ProviderError("quota_exceeded", "the plan's quota is used up", status=402)
        if response.status_code >= 500:
            raise ProviderError("server_error", f"the provider answered {response.status_code}",
                                status=response.status_code)
        if response.status_code != 200:
            raise ProviderError("bad_response", f"the provider answered {response.status_code}",
                                status=response.status_code)
        try:
            return response.json()
        except ValueError as exc:
            raise ProviderError("bad_response", "the provider did not send JSON") from exc


def _is_number(value) -> bool:
    try:
        float(value)
        return True
    except (TypeError, ValueError):
        return False
