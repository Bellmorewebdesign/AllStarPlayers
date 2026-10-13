"""The provider registry.

Adding another image search means writing one module with a `search(query,
limit)` that returns `Candidate`s, and listing it here. Nothing else in the
program needs to change.
"""
from __future__ import annotations

from .base import (  # noqa: F401  (re-exported for convenience)
    BUDGET_EXHAUSTED, NO_MATCHES, NOT_CONFIGURED, RATE_LIMITED, SEARCH_FAILED,
    Candidate, Provider, ProviderError,
)
from .brave import BraveProvider
from .google_cse import GoogleCseProvider
from .openverse import OpenverseProvider
from .wikimedia import WikimediaProvider

PROVIDER_CLASSES = {
    cls.name: cls for cls in (
        OpenverseProvider,
        WikimediaProvider,
        GoogleCseProvider,
        BraveProvider,
    )
}

# The order they are asked in: free and licence-bearing first, so a product
# that can be answered without spending anything is.
ORDER = ["openverse", "wikimedia", "google_cse", "brave"]


def build_providers(settings, http=None) -> dict:
    """Instantiate every known provider with this run's settings."""
    out = {}
    for name in ORDER:
        cls = PROVIDER_CLASSES[name]
        provider_settings = settings.providers.get(name)
        if provider_settings is None:
            continue
        out[name] = cls(provider_settings, http=http)
    return out


def describe_providers(settings) -> list[dict]:
    """What the settings page shows: what each one costs and whether it is
    ready to be called."""
    rows = []
    for name in ORDER:
        cls = PROVIDER_CLASSES[name]
        provider_settings = settings.providers.get(name)
        if provider_settings is None:
            continue
        provider = cls(provider_settings)
        rows.append({
            "name": name,
            "label": cls.label,
            "billable": cls.billable,
            "needs_key": cls.needs_key,
            "cost_note": cls.cost_note,
            "homepage": cls.homepage,
            "enabled": provider_settings.enabled,
            "has_key": bool(provider_settings.api_key),
            "configured": provider.configured(),
            "why_not": provider.why_not_configured(),
            "daily_budget": provider_settings.daily_budget,
            "min_interval_seconds": provider_settings.min_interval_seconds,
        })
    return rows
