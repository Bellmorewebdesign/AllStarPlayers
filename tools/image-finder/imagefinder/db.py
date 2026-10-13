"""The SQLite store.

Everything the program knows lives here: imported products, the queries it
generated or you edited, the searches it has already paid for, the candidates
those searches returned, your decisions, and what was downloaded. Stopping the
program at any point and starting it again loses nothing.
"""
from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path

SCHEMA_VERSION = 1

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- One row per Square catalog item, as the public API returned it.
CREATE TABLE IF NOT EXISTS products (
  square_id          TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  description        TEXT,
  category_ids       TEXT,
  category_names     TEXT,
  skus               TEXT,
  colors             TEXT,
  sizes              TEXT,
  variation_count    INTEGER DEFAULT 0,
  square_image_count INTEGER DEFAULT 0,
  price_min          INTEGER,
  price_max          INTEGER,
  currency           TEXT,
  build_id           TEXT,
  imported_at        TEXT,
  -- pending | reviewing | done | skipped | no_matches | search_failed
  status             TEXT NOT NULL DEFAULT 'pending',
  status_note        TEXT,
  updated_at         TEXT
);

-- What we will type into a search box. One per line in the UI; editable.
CREATE TABLE IF NOT EXISTS queries (
  id         INTEGER PRIMARY KEY,
  square_id  TEXT NOT NULL,
  text       TEXT NOT NULL,
  origin     TEXT NOT NULL DEFAULT 'auto',   -- auto | edited
  created_at TEXT,
  UNIQUE (square_id, text)
);

-- The search cache. A row exists for every (provider, query, params) we have
-- ever sent, successful or not, so a restart never pays for the same search
-- twice. `billable` records whether that call cost anything.
CREATE TABLE IF NOT EXISTS searches (
  id           INTEGER PRIMARY KEY,
  provider     TEXT NOT NULL,
  query        TEXT NOT NULL,
  params       TEXT NOT NULL DEFAULT '',
  outcome      TEXT NOT NULL,   -- ok | no_matches | search_failed | rate_limited
                                -- | budget_exhausted | not_configured
  http_status  INTEGER,
  error_kind   TEXT,
  error_detail TEXT,
  result_count INTEGER DEFAULT 0,
  billable     INTEGER DEFAULT 0,
  created_at   TEXT,
  UNIQUE (provider, query, params)
);

CREATE TABLE IF NOT EXISTS candidates (
  id             INTEGER PRIMARY KEY,
  square_id      TEXT NOT NULL,
  search_id      INTEGER,
  provider       TEXT NOT NULL,
  provider_id    TEXT,
  title          TEXT,
  source_page    TEXT,
  image_url      TEXT NOT NULL,
  thumb_url      TEXT,
  width          INTEGER,
  height         INTEGER,
  license        TEXT,
  license_url    TEXT,
  -- known: the provider published a licence. unknown: it did not, and finding
  -- the image grants nothing. Never inferred from where it was found.
  license_status TEXT NOT NULL DEFAULT 'unknown',
  creator        TEXT,
  source_name    TEXT,
  query          TEXT,
  raw            TEXT,
  created_at     TEXT,
  UNIQUE (square_id, image_url)
);

CREATE TABLE IF NOT EXISTS decisions (
  candidate_id    INTEGER PRIMARY KEY,
  square_id       TEXT NOT NULL,
  decision        TEXT NOT NULL,              -- approved | rejected
  match_note      TEXT,
  match_confirmed INTEGER NOT NULL DEFAULT 0, -- a person ticked "same item"
  rights_status   TEXT NOT NULL DEFAULT 'unknown',  -- permitted | unknown | not_permitted
  rights_note     TEXT,
  is_main         INTEGER NOT NULL DEFAULT 0,
  decided_at      TEXT
);

CREATE TABLE IF NOT EXISTS downloads (
  candidate_id INTEGER PRIMARY KEY,
  status       TEXT NOT NULL,   -- ok | download_blocked | download_failed
  error_kind   TEXT,
  error_detail TEXT,
  local_path   TEXT,
  optimized_path TEXT,
  bytes        INTEGER,
  width        INTEGER,
  height       INTEGER,
  sha256       TEXT,
  fetched_at   TEXT
);

-- Calls that cost something, per day and provider, for the budget.
CREATE TABLE IF NOT EXISTS budget (
  day      TEXT NOT NULL,
  provider TEXT NOT NULL,
  calls    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, provider)
);

CREATE TABLE IF NOT EXISTS events (
  id        INTEGER PRIMARY KEY,
  at        TEXT,
  kind      TEXT,
  square_id TEXT,
  detail    TEXT
);

CREATE INDEX IF NOT EXISTS idx_candidates_product ON candidates (square_id);
CREATE INDEX IF NOT EXISTS idx_decisions_product  ON decisions (square_id);
CREATE INDEX IF NOT EXISTS idx_queries_product    ON queries (square_id);
CREATE INDEX IF NOT EXISTS idx_products_status    ON products (status);
"""


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


class Database:
    """A thin wrapper. Connections are per thread, because the web server
    answers more than one request at a time and SQLite objects are not shared.
    """

    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._local = threading.local()
        self._write_lock = threading.Lock()
        self._init_schema()

    # ---- connections ----
    @property
    def conn(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = sqlite3.connect(self.path, timeout=30)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA foreign_keys=ON")
            conn.execute("PRAGMA busy_timeout=10000")
            self._local.conn = conn
        return conn

    def _init_schema(self) -> None:
        with self._write_lock:
            self.conn.executescript(SCHEMA)
            self.conn.execute(
                "INSERT INTO meta(key, value) VALUES('schema_version', ?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (str(SCHEMA_VERSION),),
            )
            self.conn.commit()

    def close(self) -> None:
        conn = getattr(self._local, "conn", None)
        if conn is not None:
            conn.close()
            self._local.conn = None

    # ---- small helpers ----
    def execute(self, sql: str, params: tuple = ()) -> sqlite3.Cursor:
        with self._write_lock:
            cur = self.conn.execute(sql, params)
            self.conn.commit()
            return cur

    def query(self, sql: str, params: tuple = ()) -> list[sqlite3.Row]:
        return list(self.conn.execute(sql, params))

    def one(self, sql: str, params: tuple = ()) -> sqlite3.Row | None:
        cur = self.conn.execute(sql, params)
        return cur.fetchone()

    def scalar(self, sql: str, params: tuple = ()):
        row = self.one(sql, params)
        return None if row is None else row[0]

    def log(self, kind: str, detail: str = "", square_id: str | None = None) -> None:
        self.execute(
            "INSERT INTO events(at, kind, square_id, detail) VALUES(?,?,?,?)",
            (now(), kind, square_id, detail),
        )

    # ---- meta ----
    def get_meta(self, key: str, default: str | None = None) -> str | None:
        row = self.one("SELECT value FROM meta WHERE key=?", (key,))
        return default if row is None else row["value"]

    def set_meta(self, key: str, value: str) -> None:
        self.execute(
            "INSERT INTO meta(key, value) VALUES(?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )

    # ---- budget ----
    def budget_used(self, provider: str, day: str | None = None) -> int:
        row = self.one(
            "SELECT calls FROM budget WHERE day=? AND provider=?", (day or today(), provider)
        )
        return 0 if row is None else int(row["calls"])

    def budget_spend(self, provider: str, calls: int = 1, day: str | None = None) -> None:
        self.execute(
            "INSERT INTO budget(day, provider, calls) VALUES(?,?,?) "
            "ON CONFLICT(day, provider) DO UPDATE SET calls = calls + excluded.calls",
            (day or today(), provider, calls),
        )

    # ---- products ----
    def upsert_product(self, row: dict) -> None:
        self.execute(
            """
            INSERT INTO products (square_id, name, description, category_ids, category_names,
                                  skus, colors, sizes, variation_count, square_image_count,
                                  price_min, price_max, currency, build_id, imported_at, updated_at)
            VALUES (:square_id, :name, :description, :category_ids, :category_names,
                    :skus, :colors, :sizes, :variation_count, :square_image_count,
                    :price_min, :price_max, :currency, :build_id, :imported_at, :updated_at)
            ON CONFLICT(square_id) DO UPDATE SET
              name=excluded.name, description=excluded.description,
              category_ids=excluded.category_ids, category_names=excluded.category_names,
              skus=excluded.skus, colors=excluded.colors, sizes=excluded.sizes,
              variation_count=excluded.variation_count,
              square_image_count=excluded.square_image_count,
              price_min=excluded.price_min, price_max=excluded.price_max,
              currency=excluded.currency, build_id=excluded.build_id,
              updated_at=excluded.updated_at
            """,
            row,  # type: ignore[arg-type]
        )

    def set_product_status(self, square_id: str, status: str, note: str = "") -> None:
        self.execute(
            "UPDATE products SET status=?, status_note=?, updated_at=? WHERE square_id=?",
            (status, note, now(), square_id),
        )

    # ---- queries ----
    def add_query(self, square_id: str, text: str, origin: str = "auto") -> None:
        text = text.strip()
        if not text:
            return
        self.execute(
            "INSERT INTO queries(square_id, text, origin, created_at) VALUES(?,?,?,?) "
            "ON CONFLICT(square_id, text) DO UPDATE SET origin=excluded.origin",
            (square_id, text, origin, now()),
        )

    def queries_for(self, square_id: str) -> list[sqlite3.Row]:
        return self.query(
            "SELECT * FROM queries WHERE square_id=? ORDER BY origin DESC, id", (square_id,)
        )

    # ---- candidates ----
    def add_candidate(self, square_id: str, search_id: int | None, cand: dict) -> int | None:
        """Returns the row id, or None when this image was already collected."""
        cur = self.execute(
            """
            INSERT INTO candidates (square_id, search_id, provider, provider_id, title,
                                    source_page, image_url, thumb_url, width, height,
                                    license, license_url, license_status, creator,
                                    source_name, query, raw, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(square_id, image_url) DO NOTHING
            """,
            (
                square_id, search_id, cand["provider"], cand.get("provider_id"),
                cand.get("title"), cand.get("source_page"), cand["image_url"],
                cand.get("thumb_url"), cand.get("width"), cand.get("height"),
                cand.get("license"), cand.get("license_url"),
                cand.get("license_status", "unknown"), cand.get("creator"),
                cand.get("source_name"), cand.get("query"),
                json.dumps(cand.get("raw") or {}), now(),
            ),
        )
        return cur.lastrowid if cur.rowcount else None

    def candidates_for(self, square_id: str) -> list[sqlite3.Row]:
        return self.query(
            """
            SELECT c.*, d.decision, d.match_note, d.match_confirmed, d.rights_status,
                   d.rights_note, d.is_main, dl.status AS download_status,
                   dl.optimized_path, dl.local_path, dl.error_kind AS download_error,
                   dl.bytes AS download_bytes
            FROM candidates c
            LEFT JOIN decisions d ON d.candidate_id = c.id
            LEFT JOIN downloads dl ON dl.candidate_id = c.id
            WHERE c.square_id = ?
            ORDER BY (d.is_main IS NULL), d.is_main DESC, c.id
            """,
            (square_id,),
        )

    def decide(self, candidate_id: int, square_id: str, decision: str, *, match_note: str = "",
               match_confirmed: bool = False, rights_status: str = "unknown",
               rights_note: str = "", is_main: bool = False) -> None:
        self.execute(
            """
            INSERT INTO decisions (candidate_id, square_id, decision, match_note, match_confirmed,
                                   rights_status, rights_note, is_main, decided_at)
            VALUES (?,?,?,?,?,?,?,?,?)
            ON CONFLICT(candidate_id) DO UPDATE SET
              decision=excluded.decision, match_note=excluded.match_note,
              match_confirmed=excluded.match_confirmed, rights_status=excluded.rights_status,
              rights_note=excluded.rights_note, is_main=excluded.is_main,
              decided_at=excluded.decided_at
            """,
            (candidate_id, square_id, decision, match_note, int(match_confirmed),
             rights_status, rights_note, int(is_main), now()),
        )

    def set_main(self, square_id: str, candidate_id: int) -> None:
        """Exactly one main image per product."""
        with self._write_lock:
            self.conn.execute("UPDATE decisions SET is_main=0 WHERE square_id=?", (square_id,))
            self.conn.execute("UPDATE decisions SET is_main=1 WHERE candidate_id=?", (candidate_id,))
            self.conn.commit()

    def record_download(self, candidate_id: int, **fields) -> None:
        cols = ["status", "error_kind", "error_detail", "local_path", "optimized_path",
                "bytes", "width", "height", "sha256"]
        values = [fields.get(c) for c in cols]
        self.execute(
            f"""
            INSERT INTO downloads (candidate_id, {', '.join(cols)}, fetched_at)
            VALUES (?, {', '.join('?' * len(cols))}, ?)
            ON CONFLICT(candidate_id) DO UPDATE SET
              {', '.join(f'{c}=excluded.{c}' for c in cols)}, fetched_at=excluded.fetched_at
            """,
            (candidate_id, *values, now()),
        )

    # ---- counts for the dashboard ----
    def counts(self) -> dict:
        total = self.scalar("SELECT COUNT(*) FROM products") or 0
        with_square = self.scalar("SELECT COUNT(*) FROM products WHERE square_image_count > 0") or 0
        approved = self.scalar(
            "SELECT COUNT(DISTINCT square_id) FROM decisions WHERE decision='approved'") or 0
        main = self.scalar(
            "SELECT COUNT(*) FROM decisions WHERE decision='approved' AND is_main=1") or 0
        downloaded = self.scalar("SELECT COUNT(*) FROM downloads WHERE status='ok'") or 0
        by_status = {
            row["status"]: row["n"]
            for row in self.query("SELECT status, COUNT(*) AS n FROM products GROUP BY status")
        }
        return {
            "products": total,
            "with_square_image": with_square,
            "missing_photo": total - with_square,
            "products_with_approved": approved,
            "main_images": main,
            "downloaded": downloaded,
            "by_status": by_status,
            "candidates": self.scalar("SELECT COUNT(*) FROM candidates") or 0,
            "searches": self.scalar("SELECT COUNT(*) FROM searches") or 0,
            "billable_searches": self.scalar(
                "SELECT COALESCE(SUM(billable),0) FROM searches") or 0,
        }
