from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.config import DATA_DIR, settings
from app.models.chat import Base
from app.models import product  # noqa: F401  注册 Product 表
from app.models import tryon  # noqa: F401  注册 TryonTask 表
from app.models import signal  # noqa: F401  注册 SignalDraft 表
from app.models import cart  # noqa: F401  注册 CartItem 表
from app.models import demand  # noqa: F401
from app.models import consumer_event, generation  # noqa: F401
from app.models import consumer_profile, profile_snapshot  # noqa: F401
from app.models import styling_account, styling_direct, styling_verification  # noqa: F401
from app.models import styling_delivery  # noqa: F401
from app.models import consumer_context  # noqa: F401
from app.models import admin_context  # noqa: F401

_is_sqlite = settings.database_url.startswith("sqlite")

_connect_args = {"check_same_thread": False} if _is_sqlite else {}
engine = create_engine(settings.database_url, connect_args=_connect_args)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False)


def init_db() -> None:
    if _is_sqlite:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
    Base.metadata.create_all(engine)
    _migrate()
    _seed_if_empty()


def _migrate() -> None:
    """SQLite 轻量迁移：给旧表补新增列（create_all 不会改已有表）。"""
    if not _is_sqlite:
        return
    with engine.begin() as conn:
        cols = [r[1] for r in conn.exec_driver_sql("PRAGMA table_info(tryon_tasks)")]
        if "stage" not in cols:
            conn.exec_driver_sql("ALTER TABLE tryon_tasks ADD COLUMN stage VARCHAR(20) DEFAULT 'done'")
        additions = {
            "demand_turns": {
                "error_code": "VARCHAR(64) NOT NULL DEFAULT ''",
                "extraction_attempts": "INTEGER NOT NULL DEFAULT 1",
                "negative_json": "TEXT NOT NULL DEFAULT '[]'",
            },
            "demand_occurrences": {
                "normalizer_version": "VARCHAR(40) NOT NULL DEFAULT 'rules-v1'",
                "context_turn_ids_json": "TEXT NOT NULL DEFAULT '[]'",
                "field_sources_json": "TEXT NOT NULL DEFAULT '{}'",
                "revision": "INTEGER NOT NULL DEFAULT 1",
                "lifecycle": "VARCHAR(20) NOT NULL DEFAULT 'active'",
            },
            "demand_handoffs": {"metadata_json": "TEXT NOT NULL DEFAULT '{}'"},
            "demand_audit": {
                "before_json": "TEXT NOT NULL DEFAULT '{}'",
                "after_json": "TEXT NOT NULL DEFAULT '{}'",
            },
        }
        for table, fields in additions.items():
            existing = {r[1] for r in conn.exec_driver_sql(f"PRAGMA table_info({table})")}
            for column, definition in fields.items():
                if column not in existing:
                    conn.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def _seed_if_empty() -> None:
    from app.seed_products import seed_products
    db = SessionLocal()
    try:
        seed_products(db)
    finally:
        db.close()
