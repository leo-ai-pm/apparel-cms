import sqlite3
import json
from contextlib import contextmanager
from pathlib import Path

from .core.config import settings

SCHEMA_VERSION = 2


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(settings.db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db() -> None:
    Path(settings.db_path).parent.mkdir(parents=True, exist_ok=True)
    with _connect() as conn:
        conn.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        conn.execute(
            """CREATE TABLE IF NOT EXISTS packages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                package_id TEXT UNIQUE,
                version TEXT NOT NULL,
                status TEXT NOT NULL,
                signal_ids TEXT NOT NULL,
                sample_count TEXT NOT NULL,
                attribution TEXT NOT NULL,
                dedup_key TEXT NOT NULL,
                dedup_rule TEXT NOT NULL,
                source TEXT NOT NULL,
                constraints TEXT,
                requirement_desc TEXT,
                priority TEXT,
                priority_basis TEXT,
                created_at TEXT NOT NULL,
                published_at TEXT
            )"""
        )
        conn.execute(
            """CREATE TABLE IF NOT EXISTS processed_signals (
                signal_id TEXT PRIMARY KEY,
                package_id TEXT NOT NULL,
                processed_at TEXT NOT NULL
            )"""
        )
        conn.execute("""CREATE TABLE IF NOT EXISTS direct_signals (
            signal_id TEXT PRIMARY KEY,
            payload TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )""")
        columns = {row[1] for row in conn.execute("PRAGMA table_info(packages)")}
        if "priority" not in columns:
            conn.execute("ALTER TABLE packages ADD COLUMN priority TEXT")
        if "priority_basis" not in columns:
            conn.execute("ALTER TABLE packages ADD COLUMN priority_basis TEXT")
        row = conn.execute("SELECT value FROM meta WHERE key='schema_version'").fetchone()
        if row is None:
            conn.execute("INSERT INTO meta (key, value) VALUES ('schema_version', ?)", (str(SCHEMA_VERSION),))
        else:
            conn.execute("UPDATE meta SET value=? WHERE key='schema_version'", (str(SCHEMA_VERSION),))
        conn.commit()


@contextmanager
def get_conn():
    conn = _connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def list_direct_signals(limit: int = 100) -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute("SELECT payload FROM direct_signals ORDER BY created_at DESC, signal_id DESC LIMIT ?", (limit,)).fetchall()
    return [json.loads(row[0]) for row in rows]


def save_direct_signal(payload: dict) -> bool:
    with get_conn() as conn:
        existing = conn.execute("SELECT payload FROM direct_signals WHERE signal_id = ?", (payload["signal_id"],)).fetchone()
        if existing:
            if json.loads(existing[0]) != payload:
                raise ValueError("同编号信号内容不同，不能覆盖原记录")
            return False
        conn.execute("INSERT INTO direct_signals (signal_id, payload) VALUES (?, ?)", (payload["signal_id"], json.dumps(payload, ensure_ascii=False)))
    return True
