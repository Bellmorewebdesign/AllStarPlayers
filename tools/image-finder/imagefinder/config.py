"""Settings, and where everything lives on disk.

Nothing here reaches the network. Keys come from the environment or from
config.json in the work directory, which is deliberately outside the
repository's tracked files — see .gitignore next to run.py.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field, asdict
from pathlib import Path

DEFAULT_API_BASE = "https://uf04sxkrfk.execute-api.us-east-1.amazonaws.com/default"

# Where a fresh install keeps its database, downloads and exports. Overridable
# with IMAGEFINDER_HOME so several catalogs can be worked on side by side.
DEFAULT_HOME = Path(os.environ.get("IMAGEFINDER_HOME", Path.home() / ".all-star-image-finder"))


@dataclass
class ProviderSettings:
    """One image-search back end.

    `enabled` is off by default for anything that costs money or needs a key:
    the program should never start spending without being told to.
    """
    enabled: bool = False
    api_key: str = ""
    extra: dict = field(default_factory=dict)
    # Seconds between calls to this provider. Providers publish wildly
    # different limits, so this is per provider rather than global.
    min_interval_seconds: float = 1.0
    # How many of this provider's calls a single run may make. 0 means "no
    # budget set", which is treated as "do not call" for billable providers.
    daily_budget: int = 0


@dataclass
class Settings:
    home: Path = DEFAULT_HOME
    api_base: str = DEFAULT_API_BASE
    host: str = "127.0.0.1"
    port: int = 8765

    # How many candidates to try to collect per product, and the most any one
    # provider may contribute, so one chatty provider cannot fill the page.
    candidates_per_product: int = 8
    per_provider_limit: int = 6

    # Downloads
    max_download_bytes: int = 25 * 1024 * 1024
    optimized_max_edge: int = 1400
    optimized_quality: int = 82

    http_timeout: float = 20.0
    max_retries: int = 3

    providers: dict[str, ProviderSettings] = field(default_factory=dict)

    # ---- paths ----
    @property
    def db_path(self) -> Path:
        return self.home / "imagefinder.sqlite3"

    @property
    def originals_dir(self) -> Path:
        return self.home / "originals"

    @property
    def optimized_dir(self) -> Path:
        return self.home / "optimized"

    @property
    def export_dir(self) -> Path:
        return self.home / "export"

    @property
    def config_path(self) -> Path:
        return self.home / "config.json"

    def ensure_dirs(self) -> None:
        for path in (self.home, self.originals_dir, self.optimized_dir, self.export_dir):
            path.mkdir(parents=True, exist_ok=True)

    # ---- persistence ----
    def to_json(self) -> dict:
        data = asdict(self)
        data["home"] = str(self.home)
        data["providers"] = {name: asdict(p) for name, p in self.providers.items()}
        return data

    def save(self) -> None:
        self.ensure_dirs()
        payload = self.to_json()
        # The file holds API keys, so it is written readable by this user only.
        self.config_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        try:
            os.chmod(self.config_path, 0o600)
        except OSError:
            pass  # Windows, mostly; the file still lands in the user profile.


def default_providers() -> dict[str, ProviderSettings]:
    """The shipped list, and the shape of the decision each one represents.

    Free, no key, licence published with every result:
      openverse, wikimedia  -> on by default.

    Costs money and needs a key: off until somebody turns it on and sets a
    budget. See README.md for what each one charges.
    """
    return {
        "openverse": ProviderSettings(enabled=True, min_interval_seconds=1.0, daily_budget=0),
        "wikimedia": ProviderSettings(enabled=True, min_interval_seconds=0.5, daily_budget=0),
        "google_cse": ProviderSettings(
            enabled=False, min_interval_seconds=1.0, daily_budget=100,
            extra={"cx": "", "rights": "cc_publicdomain|cc_attribute|cc_sharealike"},
        ),
        "brave": ProviderSettings(enabled=False, min_interval_seconds=1.1, daily_budget=100),
    }


def load(home: Path | None = None) -> Settings:
    """Read config.json if it exists, then let the environment win.

    Environment overrides matter for the tests and for running the program on
    a machine where you would rather not write a key to disk at all.
    """
    settings = Settings(home=Path(home) if home else DEFAULT_HOME)
    settings.providers = default_providers()

    if settings.config_path.exists():
        try:
            raw = json.loads(settings.config_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            raw = {}
        for key in ("api_base", "host", "candidates_per_product", "per_provider_limit",
                    "optimized_max_edge", "optimized_quality", "http_timeout", "max_retries"):
            if key in raw:
                setattr(settings, key, raw[key])
        if "port" in raw:
            settings.port = int(raw["port"])
        for name, values in (raw.get("providers") or {}).items():
            current = settings.providers.get(name, ProviderSettings())
            for field_name in ("enabled", "api_key", "min_interval_seconds", "daily_budget"):
                if field_name in values:
                    setattr(current, field_name, values[field_name])
            if "extra" in values and isinstance(values["extra"], dict):
                current.extra = {**current.extra, **values["extra"]}
            settings.providers[name] = current

    env = os.environ
    settings.api_base = env.get("IMAGEFINDER_API_BASE", settings.api_base)
    settings.host = env.get("IMAGEFINDER_HOST", settings.host)
    settings.port = int(env.get("IMAGEFINDER_PORT", settings.port))

    # Keys: OPENVERSE_API_KEY, GOOGLE_CSE_API_KEY + GOOGLE_CSE_CX, BRAVE_API_KEY
    if env.get("OPENVERSE_API_KEY"):
        settings.providers["openverse"].api_key = env["OPENVERSE_API_KEY"]
    if env.get("GOOGLE_CSE_API_KEY"):
        settings.providers["google_cse"].api_key = env["GOOGLE_CSE_API_KEY"]
        settings.providers["google_cse"].enabled = True
    if env.get("GOOGLE_CSE_CX"):
        settings.providers["google_cse"].extra["cx"] = env["GOOGLE_CSE_CX"]
    if env.get("BRAVE_API_KEY"):
        settings.providers["brave"].api_key = env["BRAVE_API_KEY"]
        settings.providers["brave"].enabled = True

    # Test hooks: point a provider at a local stand-in instead of the real host.
    for name in list(settings.providers):
        override = env.get(f"IMAGEFINDER_{name.upper()}_BASE")
        if override:
            settings.providers[name].extra["base_url"] = override

    settings.ensure_dirs()
    return settings
