"""Running searches: the cache, the budget, the pacing and the retries.

The rules this enforces, which are the difference between a tool you can stop
and restart and one that burns money every time you open it:

  * A (provider, query) pair is searched once. The answer — including "found
    nothing" and "the provider was down" — is written to SQLite, and a repeat
    reads from there until it is explicitly refreshed.
  * Billable providers are only called while their daily budget has room.
  * Each provider is paced to its own minimum interval, and a 429 or a 5xx is
    retried with a growing wait rather than hammered.
  * Failures are told apart: "no matches" is not "search failed", and neither
    is "the budget is spent".
"""
from __future__ import annotations

import json
import random
import threading
import time
from dataclasses import dataclass, field

from .db import Database, now
from .providers import (
    BUDGET_EXHAUSTED, NO_MATCHES, NOT_CONFIGURED, RATE_LIMITED, SEARCH_FAILED,
    ProviderError, build_providers,
)


@dataclass
class SearchOutcome:
    provider: str
    query: str
    outcome: str                 # ok | no_matches | search_failed | rate_limited
                                 # | budget_exhausted | not_configured
    candidates: list = field(default_factory=list)
    new_candidates: int = 0
    cached: bool = False
    billed: bool = False
    error_kind: str | None = None
    error_detail: str | None = None
    http_status: int | None = None


@dataclass
class ProductSearchReport:
    square_id: str
    total_candidates: int = 0
    new_candidates: int = 0
    outcomes: list = field(default_factory=list)
    status: str = "reviewing"    # reviewing | no_matches | search_failed
    note: str = ""


class Pacer:
    """One clock per provider, so a slow limit on one does not hold up another."""

    def __init__(self):
        self._last: dict[str, float] = {}
        self._lock = threading.Lock()

    def wait(self, provider: str, min_interval: float) -> None:
        if min_interval <= 0:
            return
        with self._lock:
            last = self._last.get(provider, 0.0)
            gap = time.monotonic() - last
            sleep_for = min_interval - gap
            if sleep_for > 0:
                time.sleep(sleep_for)
            self._last[provider] = time.monotonic()


class SearchService:
    def __init__(self, db: Database, settings, http=None, sleep=time.sleep):
        self.db = db
        self.settings = settings
        self.providers = build_providers(settings, http=http)
        self.pacer = Pacer()
        self._sleep = sleep

    # ---------------------------------------------------------------- cache
    def cached_search(self, provider: str, query: str, params: str = ""):
        return self.db.one(
            "SELECT * FROM searches WHERE provider=? AND query=? AND params=?",
            (provider, query, params),
        )

    def forget_search(self, provider: str, query: str, params: str = "") -> None:
        self.db.execute(
            "DELETE FROM searches WHERE provider=? AND query=? AND params=?",
            (provider, query, params),
        )

    # --------------------------------------------------------------- budget
    def budget_left(self, provider: str) -> int | None:
        """None when no budget applies (a free provider with no cap set)."""
        provider_settings = self.settings.providers.get(provider)
        if provider_settings is None:
            return 0
        impl = self.providers.get(provider)
        if impl is not None and not impl.billable and provider_settings.daily_budget <= 0:
            return None
        if provider_settings.daily_budget <= 0:
            # A billable provider with no budget set gets no calls. Spending
            # money has to be a decision somebody made.
            return 0
        return max(0, provider_settings.daily_budget - self.db.budget_used(provider))

    # --------------------------------------------------------------- search
    def search_one(self, square_id: str, provider_name: str, query: str, *,
                   limit: int | None = None, refresh: bool = False) -> SearchOutcome:
        provider = self.providers.get(provider_name)
        limit = limit or self.settings.per_provider_limit

        if provider is None:
            return SearchOutcome(provider_name, query, NOT_CONFIGURED,
                                 error_kind="unknown_provider",
                                 error_detail=f"no provider called {provider_name}")
        if not provider.configured():
            return SearchOutcome(provider_name, query, NOT_CONFIGURED,
                                 error_kind="not_configured",
                                 error_detail=provider.why_not_configured())

        params = json.dumps({"limit": limit}, sort_keys=True)

        if refresh:
            self.forget_search(provider_name, query, params)
        else:
            cached = self.cached_search(provider_name, query, params)
            # A failure on a free provider is worth trying again: it cost
            # nothing, and "the service was down an hour ago" is not an answer
            # about this product. A failure on a billable one stays cached,
            # because the provider may well have charged for it.
            if (cached is not None and not provider.billable
                    and cached["outcome"] in (SEARCH_FAILED, RATE_LIMITED)):
                cached = None
            if cached is not None:
                rows = self.db.query(
                    "SELECT * FROM candidates WHERE square_id=? AND search_id=?",
                    (square_id, cached["id"]),
                )
                # A cached search from another product still counts as paid
                # for; re-attach its results to this product for free.
                if not rows and cached["outcome"] == "ok":
                    rows = self._reattach(square_id, cached["id"])
                return SearchOutcome(provider_name, query, cached["outcome"],
                                     candidates=[dict(r) for r in rows], cached=True,
                                     error_kind=cached["error_kind"],
                                     error_detail=cached["error_detail"],
                                     http_status=cached["http_status"])

        left = self.budget_left(provider_name)
        if left is not None and left <= 0:
            self._record_search(provider_name, query, params, BUDGET_EXHAUSTED,
                                error_kind="budget_exhausted",
                                error_detail="the day's budget for this provider is used up",
                                billable=False)
            return SearchOutcome(provider_name, query, BUDGET_EXHAUSTED,
                                 error_kind="budget_exhausted",
                                 error_detail="the day's budget for this provider is used up")

        provider_settings = self.settings.providers[provider_name]
        attempts = max(1, int(self.settings.max_retries))
        last_error: ProviderError | None = None

        for attempt in range(attempts):
            self.pacer.wait(provider_name, provider_settings.min_interval_seconds)
            try:
                results = provider.search(query, limit)
            except ProviderError as exc:
                last_error = exc
                if provider.billable:
                    # A call that reached the provider may well be charged even
                    # when it fails, so it is counted either way.
                    self.db.budget_spend(provider_name)
                if exc.retryable and attempt < attempts - 1:
                    delay = exc.retry_after if exc.retry_after else (2 ** attempt) + random.random()
                    self._sleep(min(delay, 30))
                    continue
                outcome = RATE_LIMITED if exc.kind == "rate_limited" else SEARCH_FAILED
                self._record_search(provider_name, query, params, outcome,
                                    error_kind=exc.kind, error_detail=exc.detail,
                                    http_status=exc.status, billable=provider.billable)
                return SearchOutcome(provider_name, query, outcome, error_kind=exc.kind,
                                     error_detail=exc.detail, http_status=exc.status,
                                     billed=provider.billable)

            if provider.billable:
                self.db.budget_spend(provider_name)

            outcome = "ok" if results else NO_MATCHES
            search_id = self._record_search(provider_name, query, params, outcome,
                                            result_count=len(results),
                                            billable=provider.billable)
            stored, fresh = [], 0
            for candidate in results:
                payload = candidate.as_dict()
                row_id = self.db.add_candidate(square_id, search_id, payload)
                if row_id is not None:
                    fresh += 1
                    payload["id"] = row_id
                    stored.append(payload)
            return SearchOutcome(provider_name, query, outcome, candidates=stored,
                                 new_candidates=fresh, billed=provider.billable)

        # Only reachable if attempts ran out while still retryable.
        kind = last_error.kind if last_error else "unknown"
        detail = last_error.detail if last_error else ""
        outcome = RATE_LIMITED if kind == "rate_limited" else SEARCH_FAILED
        self._record_search(provider_name, query, params, outcome, error_kind=kind,
                            error_detail=detail, billable=provider.billable)
        return SearchOutcome(provider_name, query, outcome, error_kind=kind, error_detail=detail)

    def search_product(self, square_id: str, queries: list[str], *,
                       providers: list[str] | None = None,
                       refresh: bool = False) -> ProductSearchReport:
        """Work through this product's queries until there are enough
        candidates, then stop — the next query costs money or goodwill."""
        report = ProductSearchReport(square_id=square_id)
        wanted = self.settings.candidates_per_product
        names = providers or [n for n in self.providers if self.providers[n].configured()]

        have = self.db.scalar("SELECT COUNT(*) FROM candidates WHERE square_id=?", (square_id,)) or 0
        for query in queries:
            for name in names:
                if have >= wanted:
                    break
                # Always the same page size, so the cache key for a query
                # never changes with how many candidates happen to be in hand.
                # A search asked for twice with two different limits would be
                # two searches, and the second one would cost money.
                outcome = self.search_one(square_id, name, query, refresh=refresh)
                report.outcomes.append(outcome)
                have += outcome.new_candidates
                report.new_candidates += outcome.new_candidates
            if have >= wanted:
                break

        report.total_candidates = have
        report.status, report.note = self._classify(report, have)
        self.db.set_product_status(square_id, report.status, report.note)
        return report

    # -------------------------------------------------------------- helpers
    @staticmethod
    def _classify(report: ProductSearchReport, have: int) -> tuple[str, str]:
        """Telling the three failures apart, because they need different
        things from the person reading the list."""
        if have > 0:
            return "reviewing", ""
        kinds = {o.outcome for o in report.outcomes}
        if not report.outcomes:
            return "pending", "nothing was searched"
        if kinds & {SEARCH_FAILED, RATE_LIMITED}:
            detail = next((f"{o.provider}: {o.error_kind}" for o in report.outcomes
                           if o.outcome in (SEARCH_FAILED, RATE_LIMITED)), "")
            return "search_failed", f"the search itself failed ({detail})"
        if kinds == {NOT_CONFIGURED}:
            return "pending", "no provider is switched on"
        if kinds & {BUDGET_EXHAUSTED}:
            return "pending", "the search budget is used up for today"
        return "no_matches", "the providers answered, and had nothing for this product"

    def _record_search(self, provider: str, query: str, params: str, outcome: str, *,
                       result_count: int = 0, error_kind: str | None = None,
                       error_detail: str | None = None, http_status: int | None = None,
                       billable: bool = False) -> int:
        cur = self.db.execute(
            """
            INSERT INTO searches (provider, query, params, outcome, http_status, error_kind,
                                  error_detail, result_count, billable, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(provider, query, params) DO UPDATE SET
              outcome=excluded.outcome, http_status=excluded.http_status,
              error_kind=excluded.error_kind, error_detail=excluded.error_detail,
              result_count=excluded.result_count, billable=excluded.billable,
              created_at=excluded.created_at
            """,
            (provider, query, params, outcome, http_status, error_kind, error_detail,
             result_count, int(billable), now()),
        )
        if cur.lastrowid:
            return cur.lastrowid
        row = self.cached_search(provider, query, params)
        return int(row["id"]) if row else 0

    def _reattach(self, square_id: str, search_id: int) -> list:
        """The same query was already paid for under another product. Copy its
        results across rather than searching again."""
        rows = self.db.query("SELECT * FROM candidates WHERE search_id=?", (search_id,))
        out = []
        for row in rows:
            payload = {k: row[k] for k in row.keys()}
            payload.pop("id", None)
            payload.pop("square_id", None)
            payload["raw"] = json.loads(payload.get("raw") or "{}")
            new_id = self.db.add_candidate(square_id, search_id, payload)
            if new_id:
                out.append(self.db.one("SELECT * FROM candidates WHERE id=?", (new_id,)))
        return [r for r in out if r is not None]
