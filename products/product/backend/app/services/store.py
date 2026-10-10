"""本地任务状态持久化（SQLite）。只存任务状态，不存信号/证据包副本（D6）。"""

import json
from datetime import datetime

from ..db import get_conn

STATUS_DRAFT = "draft"
STATUS_PENDING = "pending"


def _now() -> str:
    return datetime.now().strftime("%Y-%m-%dT%H:%M:%S")


def _bump_version(version: str) -> str:
    try:
        return f"v{int(version.lstrip('v')) + 1}"
    except ValueError:
        return "v2"


def _row_to_dict(row) -> dict:
    d = dict(row)
    d["signal_ids"] = json.loads(d["signal_ids"])
    d["sample_count"] = json.loads(d["sample_count"])
    d["attribution"] = json.loads(d["attribution"])
    d["constraints"] = json.loads(d["constraints"]) if d.get("constraints") else []
    return d


def get_processed_signal_ids() -> set[str]:
    with get_conn() as conn:
        rows = conn.execute("SELECT signal_id FROM processed_signals").fetchall()
    return {r["signal_id"] for r in rows}


def get_claimed_signal_ids() -> set[str]:
    """已占用的信号 = 已回传的 + 仍在草稿里的（拉取时都要排除，避免重复建草稿）。"""
    claimed = get_processed_signal_ids()
    with get_conn() as conn:
        rows = conn.execute("SELECT signal_ids FROM packages WHERE status=?", (STATUS_DRAFT,)).fetchall()
    for r in rows:
        claimed.update(json.loads(r["signal_ids"]))
    return claimed


def create_draft(agg: dict) -> int:
    with get_conn() as conn:
        cur = conn.execute(
            """INSERT INTO packages
               (version, status, signal_ids, sample_count, attribution, dedup_key, dedup_rule, source,
                constraints, requirement_desc, priority, priority_basis, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                "v1",
                STATUS_DRAFT,
                json.dumps(agg["signal_ids"], ensure_ascii=False),
                json.dumps(agg["sample_count"].model_dump(), ensure_ascii=False),
                json.dumps(agg["attribution"].model_dump(), ensure_ascii=False),
                agg["dedup_key"],
                agg["dedup_rule"],
                agg["source"],
                json.dumps(agg["default_constraints"], ensure_ascii=False),
                "",
                agg["priority"],
                agg["priority_basis"],
                _now(),
            ),
        )
        return cur.lastrowid


def get_draft_row(draft_id: int) -> dict | None:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM packages WHERE id=? AND status=?", (draft_id, STATUS_DRAFT)
        ).fetchone()
    return _row_to_dict(row) if row else None


def get_package_row(package_id: str) -> dict | None:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM packages WHERE package_id=?", (package_id,)).fetchone()
    return _row_to_dict(row) if row else None


def list_drafts() -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM packages WHERE status=? ORDER BY id DESC", (STATUS_DRAFT,)
        ).fetchall()
    return [_row_to_dict(r) for r in rows]


def list_packages() -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM packages WHERE status=? ORDER BY id DESC", (STATUS_PENDING,)
        ).fetchall()
    return [_row_to_dict(r) for r in rows]


def next_package_id() -> str:
    today = datetime.now().strftime("%Y%m%d")
    prefix = f"PKG-{today}-"
    with get_conn() as conn:
        n = conn.execute(
            "SELECT COUNT(*) AS c FROM packages WHERE package_id LIKE ?", (prefix + "%",)
        ).fetchone()["c"]
    return f"{prefix}{n + 1:04d}"


def set_draft_package_id(draft_id: int, package_id: str) -> None:
    with get_conn() as conn:
        conn.execute(
            "UPDATE packages SET package_id=? WHERE id=? AND status=?", (package_id, draft_id, STATUS_DRAFT)
        )


def update_draft_fields(
    draft_id: int,
    requirement_desc: str,
    constraints: list[str],
    attribution: dict,
    dedup_key: str,
    priority: str,
    priority_basis: str,
) -> None:
    with get_conn() as conn:
        conn.execute(
            """UPDATE packages SET requirement_desc=?, constraints=?, attribution=?, dedup_key=?, priority=?, priority_basis=?
               WHERE id=? AND status=?""",
            (
                requirement_desc,
                json.dumps(constraints, ensure_ascii=False),
                json.dumps(attribution, ensure_ascii=False),
                dedup_key,
                priority,
                priority_basis,
                draft_id,
                STATUS_DRAFT,
            ),
        )


def finalize_publish(draft_id: int, package_id: str) -> None:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT signal_ids FROM packages WHERE id=? AND status=?", (draft_id, STATUS_DRAFT)
        ).fetchone()
        if row is None:
            raise RuntimeError("draft 不存在，无法标记已处理")
        signal_ids = json.loads(row["signal_ids"])
        conn.execute(
            "UPDATE packages SET status=?, published_at=? WHERE id=?",
            (STATUS_PENDING, _now(), draft_id),
        )
        for sid in signal_ids:
            conn.execute(
                "INSERT OR IGNORE INTO processed_signals (signal_id, package_id, processed_at) VALUES (?,?,?)",
                (sid, package_id, _now()),
            )


def create_rework_draft(package: dict) -> int:
    with get_conn() as conn:
        cur = conn.execute(
            """INSERT INTO packages
               (version, status, signal_ids, sample_count, attribution, dedup_key, dedup_rule, source,
                constraints, requirement_desc, priority, priority_basis, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                _bump_version(package["version"]),
                STATUS_DRAFT,
                json.dumps(package["signal_ids"], ensure_ascii=False),
                json.dumps(package["sample_count"], ensure_ascii=False),
                json.dumps(package["attribution"], ensure_ascii=False),
                package["dedup_key"],
                package["dedup_rule"],
                package["source"],
                json.dumps(package["constraints"] or [], ensure_ascii=False),
                package["requirement_desc"] or "",
                package["priority"],
                package["priority_basis"],
                _now(),
            ),
        )
        return cur.lastrowid
