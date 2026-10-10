"""Exactly-once execution records and immutable terminal responses, without model calls."""
import json
import re
from datetime import timezone

from fastapi import HTTPException
from sqlalchemy import text

from app.core.database import SessionLocal
from app.models.demand import DemandTurn
from app.models.generation import GenerationRequest
from app.models.profile_snapshot import ConsumerProfileSnapshot
from app.models.tryon import utcnow

OUTCOMES = frozenset({"clarification", "refusal", "no_match", "recommendation", "complete_outfit",
                      "action_completed", "action_failed"})
_CODE = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")


def _lock(db):
    if db.bind.dialect.name == "sqlite":
        db.execute(text("BEGIN IMMEDIATE"))


def _time(value):
    return value.replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z") if value else None


def _row_dict(row, db=None):
    result = {"recorded": True, "request_id": row.request_id, "session_id": row.session_id,
            "turn_id": row.turn_id, "status": row.status, "outcome": row.outcome or None,
            "error_code": row.error_code or None, "result": json.loads(row.result_json),
            "accepted_at": _time(row.accepted_at), "started_at": _time(row.started_at),
            "finished_at": _time(row.finished_at), "data_origin": row.data_origin,
            "is_simulated": row.is_simulated,
            "effective_outfit": row.status == "succeeded" and row.outcome == "complete_outfit"}
    if db is not None:
        snapshot = db.query(ConsumerProfileSnapshot).filter_by(request_id=row.request_id, session_id=row.session_id).first()
        if snapshot is not None:
            result['profile_binding'] = {'snapshot_id': snapshot.snapshot_id, 'profile_id': snapshot.profile_id,
                                         'profile_version': snapshot.profile_version, 'snapshot_digest': snapshot.snapshot_digest}
    return result


def _own(db, request_id, session_id):
    row = db.get(GenerationRequest, request_id)
    if row is None or row.session_id != session_id:
        raise HTTPException(404, "请求记录不存在")
    return row


def accept(request_id: str, session_id: str, turn_id: str | None = None) -> dict:
    """Called only after a NEW successful quota/evidence admission; never backfill old turns."""
    with SessionLocal() as db:
        _lock(db)
        old = db.get(GenerationRequest, request_id)
        if old is not None:
            if old.session_id != session_id or (turn_id is not None and old.turn_id != turn_id):
                raise HTTPException(404, "请求记录不存在")
            return _row_dict(old, db)
        turn = db.query(DemandTurn).filter_by(request_id=request_id, session_id=session_id).first()
        if turn is None or (turn_id is not None and turn.id != turn_id):
            raise HTTPException(404, "受理交流不存在")
        row = GenerationRequest(request_id=request_id, session_id=session_id, turn_id=turn.id)
        db.add(row)
        db.commit()
        return _row_dict(row, db)


def start(request_id: str, session_id: str) -> dict:
    with SessionLocal() as db:
        _lock(db)
        row = _own(db, request_id, session_id)
        if row.status == "running":
            return _row_dict(row, db)
        if row.status != "accepted":
            raise HTTPException(409, "请求已结束，请读取原结果")
        row.status, row.started_at = "running", utcnow()
        db.commit()
        return _row_dict(row, db)


def _version_items(version: dict) -> list:
    items = version.get("items")
    if isinstance(items, dict):
        if set(items) != {"top", "bottom", "shoes"}:
            return []
        return [items[slot] for slot in ("top", "bottom", "shoes")]
    return items if isinstance(items, list) else []


def version_sku_ids(version: dict) -> list[str]:
    """Three slots in the fixed canonical shape; legacy list shape is accepted if complete."""
    items = _version_items(version)
    if (len(items) != 3 or any(not isinstance(item, dict) or not item.get("sku_id") for item in items)
            or len({item["sku_id"] for item in items}) != 3):
        return []
    return [item["sku_id"] for item in items]


def persisted_version(session_id: str, version_id: str) -> dict:
    """Read the fixed service's own immutable version; never manufacture a display/success."""
    try:
        from app.services.fixed_styling import FixedStylingError, get_version
    except ImportError:
        raise HTTPException(503, "固定搭配服务尚未接入") from None
    try:
        version = get_version(session_id, version_id)
    except FixedStylingError as error:
        status = 404 if error.code in {"SESSION_NOT_FOUND", "NOT_FOUND"} else 503
        raise HTTPException(status, "固定搭配版本不存在" if status == 404 else "固定搭配服务暂不可核对") from None
    if version is None:
        raise HTTPException(404, "固定搭配版本不存在")
    if not isinstance(version, dict):
        raise HTTPException(409, "固定搭配版本不可核对")
    origin = version.get("origin")
    if (version.get("is_example") is True
            or (isinstance(origin, str) and origin in {"example", "independent_example"})
            or version.get("acceptance_status") not in {"accepted", "accepted_by_user"}):
        raise HTTPException(409, "独立示例或未接受素材不能计为当前搭配")
    if (len(version_sku_ids(version)) != 3
            or version.get("look_version_id") != version_id or not version.get("image_url")):
        raise HTTPException(409, "完整搭配版本缺少图与三槽SKU绑定")
    return version


def succeed(request_id: str, session_id: str, outcome: str, result: dict | None = None) -> dict:
    if outcome not in OUTCOMES:
        raise HTTPException(422, "请求完成类型无效")
    try:
        encoded = json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    except (TypeError, ValueError):
        raise HTTPException(422, "请求结果字段无效") from None
    # Immutable terminal replay must remain available if an external asset is unavailable later.
    with SessionLocal() as db:
        old = _own(db, request_id, session_id)
        if old.status == "succeeded" and old.outcome == outcome and old.result_json == encoded:
            return _row_dict(old, db)
        if old.status != "running":
            raise HTTPException(409, "请求终态不可覆盖")
    if outcome == "complete_outfit":
        outfit = result.get("outfit") if isinstance(result, dict) else None
        if not isinstance(outfit, dict) or not isinstance(outfit.get("look_version_id"), str):
            raise HTTPException(409, "完整搭配必须绑定持久化版本")
        version = persisted_version(session_id, outfit["look_version_id"])
        if (len(version_sku_ids(outfit)) != 3
                or _version_items(outfit) != _version_items(version)
                or outfit.get("look_id") != version.get("look_id")
                or outfit.get("image_url") != version["image_url"]
                or outfit.get("image_sha256") != version.get("image_sha256")
                or outfit.get("resources") != version.get("resources")
                or outfit.get("inventory_snapshot") != version.get("inventory_snapshot")
                or outfit.get("profile_snapshot") != version.get("profile_snapshot")
                or not isinstance(version.get("inventory_snapshot"), dict)
                or version["inventory_snapshot"].get("recorded") is not True):
            raise HTTPException(409, "完整搭配结果与持久化版本不一致")
        with SessionLocal() as db:
            bound = db.query(ConsumerProfileSnapshot).filter_by(request_id=request_id, session_id=session_id).first()
            if bound is not None:
                from app.services.profile_snapshots import snapshot_summary
                if version.get('profile_snapshot') != snapshot_summary(bound.snapshot_id):
                    raise HTTPException(409, "完整搭配资料快照与当次受理不一致")
    with SessionLocal() as db:
        _lock(db)
        row = _own(db, request_id, session_id)
        if row.status == "succeeded" and row.outcome == outcome and row.result_json == encoded:
            return _row_dict(row, db)
        if row.status != "running":
            raise HTTPException(409, "请求终态不可覆盖")
        row.status, row.outcome, row.result_json = "succeeded", outcome, encoded
        row.error_code, row.finished_at = "", utcnow()
        db.commit()
        return _row_dict(row, db)


def fail(request_id: str, session_id: str, error_code: str) -> dict:
    if not isinstance(error_code, str) or not _CODE.fullmatch(error_code):
        raise HTTPException(422, "请求失败类型无效")
    with SessionLocal() as db:
        _lock(db)
        row = _own(db, request_id, session_id)
        if row.status == "failed" and row.error_code == error_code:
            return _row_dict(row, db)
        if row.status not in ("accepted", "running"):
            raise HTTPException(409, "请求终态不可覆盖")
        row.status, row.error_code, row.finished_at = "failed", error_code, utcnow()
        row.outcome, row.result_json = "", "null"
        db.commit()
        return _row_dict(row, db)


def interrupted() -> int:
    """Startup reconciliation only: do not mark historical unrecorded requests as failed."""
    with SessionLocal() as db:
        _lock(db)
        rows = db.query(GenerationRequest).filter(GenerationRequest.status.in_(("accepted", "running"))).all()
        for row in rows:
            row.status, row.error_code, row.finished_at = "failed", "GENERATION_INTERRUPTED", utcnow()
            row.outcome, row.result_json = "", "null"
        db.commit()
        return len(rows)


def lookup(request_id: str, session_id: str) -> dict:
    with SessionLocal() as db:
        row = db.get(GenerationRequest, request_id)
        if row is not None:
            if row.session_id != session_id:
                raise HTTPException(404, "请求记录不存在")
            return _row_dict(row, db)
        turn = db.query(DemandTurn).filter_by(request_id=request_id, session_id=session_id).first()
        if turn is None:
            raise HTTPException(404, "请求记录不存在")
        return {"recorded": False, "request_id": request_id, "session_id": session_id,
                "turn_id": turn.id, "status": "not_recorded", "outcome": None,
                "error_code": None, "result": None, "accepted_at": None,
                "started_at": None, "finished_at": None, "effective_outfit": False,
                "data_origin": turn.data_origin, "is_simulated": True}
