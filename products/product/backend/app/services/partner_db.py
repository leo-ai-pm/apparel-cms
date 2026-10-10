"""New, explicitly owned SQLite store. No legacy DB/config imports."""
from contextlib import contextmanager
import os
from pathlib import Path
import sqlite3
import stat

from ..core.errors import AppError
from ..core.partner_config import config, REPOSITORY

DDL = [
    "CREATE TABLE partner_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)",
    """CREATE TABLE direct_receipts(
        id INTEGER PRIMARY KEY AUTOINCREMENT, direct_receive_id TEXT NOT NULL UNIQUE,
        scope TEXT NOT NULL, source_instance_id TEXT NOT NULL, target_instance_id TEXT NOT NULL,
        source_agent TEXT NOT NULL, handoff_id TEXT NOT NULL, revision INTEGER NOT NULL,
        payload_digest TEXT NOT NULL, payload BLOB NOT NULL, envelope TEXT NOT NULL,
        source_subject TEXT NOT NULL, approval_ref TEXT NOT NULL,receipt TEXT NOT NULL,
        proof BLOB NOT NULL,proof_request TEXT NOT NULL,provenance_status TEXT NOT NULL,warnings TEXT NOT NULL,
        envelope_raw BLOB NOT NULL,
        UNIQUE(scope,source_instance_id,source_agent,handoff_id,revision))""",
    """CREATE TABLE direct_supplements(
        direct_receive_id TEXT PRIMARY KEY REFERENCES direct_receipts(direct_receive_id),
        supplement_id TEXT NOT NULL,digest TEXT NOT NULL,content BLOB NOT NULL,
        receipt TEXT NOT NULL,proof BLOB NOT NULL,proof_request TEXT NOT NULL,
        provenance_status TEXT NOT NULL,warnings TEXT NOT NULL)""",
    """CREATE TABLE integration_attempts(
        attempt_id TEXT PRIMARY KEY,scope TEXT NOT NULL,source_instance_id TEXT NOT NULL,
        subject TEXT NOT NULL,handoff_id TEXT NOT NULL,revision INTEGER NOT NULL,
        purpose TEXT NOT NULL,started_at TEXT NOT NULL,finished_at TEXT,
        state TEXT NOT NULL,error_code TEXT,direct_receive_id TEXT)""",
    """CREATE TABLE signals_v2(
        id INTEGER PRIMARY KEY AUTOINCREMENT,signal_id TEXT NOT NULL UNIQUE,
        scope TEXT NOT NULL,source_instance_id TEXT NOT NULL,target_instance_id TEXT NOT NULL,
        handoff_id TEXT NOT NULL,revision INTEGER NOT NULL,direct_receive_id TEXT NOT NULL UNIQUE REFERENCES direct_receipts(direct_receive_id),
        content BLOB NOT NULL,digest TEXT NOT NULL,
        UNIQUE(source_instance_id,scope,handoff_id,revision))""",
]


def database_path():
    value = os.getenv("PARTNER_DB_PATH", "")
    path = Path(value)
    original_product = (REPOSITORY.parent / "产品Agent").resolve()
    if (not value or not path.is_absolute() or path.is_symlink() or path.resolve().is_relative_to(REPOSITORY)
            or path.resolve().is_relative_to(original_product)):
        raise AppError("NOT_CONFIGURED", "产品接收需要仓库外独立数据库", 503)
    if os.getenv("DB_PATH") and path.resolve() == Path(os.environ["DB_PATH"]).expanduser().resolve():
        raise AppError("NOT_CONFIGURED", "不能复用旧业务数据库", 503)
    return path


@contextmanager
def connection(*, write=False):
    cfg = config()
    path = database_path()
    conn = None
    try:
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        try:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            os.close(fd)
        except FileExistsError:
            pass
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != 0o600:
            raise AppError("NOT_CONFIGURED", "产品接收数据库权限或类型不符合要求", 503)
        conn = sqlite3.connect(path, timeout=10, isolation_level=None)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys=ON")
        # Serialize first-time initialization before opening a read transaction;
        # reads never upgrade their transaction into a schema write.
        conn.execute("BEGIN IMMEDIATE")
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")}
        expected = {"application": "partner-product-python", "schema_version": "1",
                    "instance_id": cfg["instance_id"], "authorized_scope": cfg["authorized_scope"]}
        if not tables:
            for statement in DDL:
                conn.execute(statement)
            conn.executemany("INSERT INTO partner_meta VALUES(?,?)", expected.items())
        elif "partner_meta" not in tables or dict(conn.execute("SELECT key,value FROM partner_meta")) != expected:
            raise AppError("STORAGE_SCHEMA_UNSUPPORTED", "目标数据库归属或版本不受支持", 503)
        conn.commit()
        conn.execute("BEGIN IMMEDIATE" if write else "BEGIN")
        yield conn
        conn.commit()
    except (OSError, sqlite3.Error):
        if conn:
            conn.rollback()
        raise AppError("STORAGE_UNAVAILABLE", "产品接收存储暂不可用", 503) from None
    except Exception:
        if conn:
            conn.rollback()
        raise
    finally:
        if conn:
            conn.close()
