"""Manager-only evidence queries, immutable approvals and receipt-backed handoffs."""
import hashlib
import hmac
import json
import os
import threading
import time
import uuid
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, StrictInt, StrictStr, field_validator, model_validator
from sqlalchemy import case, func
from sqlalchemy.exc import IntegrityError

from app.core.admin_auth import (COOKIE, TTL, configured, require_admin, revoke_session,
                                 same_origin, token, revalidate_principal, guard_demo_login)
from app.core.config import DATA_DIR
from app.core.database import SessionLocal, engine
from app.models.demand import (DemandAudit, DemandHandoff, DemandOccurrence, DemandOccurrenceRevision,
                               DemandSendAttempt, DemandTurn)
from app.models.tryon import TryonTask, utcnow
from app.services.signals import desensitize
from app.schemas.admin_context import AdminActionFields, EmptyAdminAction
from app.services.admin_context import (enabled as context_enabled, AdminContextError, get_me,
    begin_action, finish_action, lookup_operation, action_headers, revalidate_context)


def _local_scope(request: Request):
    # This deployment owns one service space. A query parameter never grants access.
    if {"scope", "space_id", "workspace_id", "visitor_space_id"}.intersection(request.query_params):
        if context_enabled():
            raise AdminContextError(403, 'ADMIN_FORBIDDEN', '当前管理身份不能切换服务空间。')
        raise HTTPException(403, "当前管理身份不能切换服务空间")


router = APIRouter(prefix="/api/v1/admin", tags=["styling-admin"], dependencies=[Depends(_local_scope)])
_attempts: dict[str, list[float]] = defaultdict(list)
_login_lock = threading.Lock()
_REVIEW_STATES = {"pending", "approved", "rejected", "active", "excluded", "retracted"}
_TURN_STATES = {"extracted", "no_explicit_demand", "negative_preference", "needs_review", "extraction_failed", "extracting"}


class Login(BaseModel):
    model_config = ConfigDict(extra='forbid')
    password: StrictStr = Field(min_length=1, max_length=256)


class Review(AdminActionFields):
    # RFC3339 JSON strings remain the existing datetime transport format.
    model_config = ConfigDict(extra='forbid' if context_enabled() else 'ignore', strict=False)
    note: StrictStr = Field(min_length=2, max_length=500)
    days: StrictInt = 7
    expected_occurrence_ids: list[StrictStr] = Field(default_factory=list, max_length=10000)
    expected_revisions: dict[str, StrictInt] | None = None
    expected_evidence_digest: StrictStr | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    expected_revision: StrictInt | None = Field(default=None, ge=1)
    window_start: datetime | None = None
    window_end: datetime | None = None

    @model_validator(mode='before')
    @classmethod
    def strict_new_fields(cls, value):
        # The unchanged legacy tests/instances ignored advisory client flags.
        # New capability rejects them instead of silently dropping intent.
        if context_enabled() and isinstance(value, dict) and set(value).difference(cls.model_fields):
            raise ValueError('ADMIN_ACTION_INVALID')
        return value

    @field_validator('expected_revisions')
    @classmethod
    def positive_revisions(cls, value):
        if value is not None and any(revision < 1 for revision in value.values()):
            raise ValueError('invalid revisions')
        return value

    @field_validator('window_start', 'window_end', mode='before')
    @classmethod
    def explicit_time(cls, value):
        if value is not None and not isinstance(value, (str, datetime)):
            raise ValueError('invalid timestamp')
        return value


def _action_begin(db, principal, body, request, kind):
    if not context_enabled():
        return None, None
    if body is None:
        raise AdminContextError(422, 'ADMIN_CONTEXT_REQUIRED', '请先读取管理身份并确认原操作。')
    return begin_action(db, principal, body, method=request.method, path=request.url.path, kind=kind)


def _action_response(record, result, status=200):
    return JSONResponse(result, status_code=status, headers=action_headers(record.request_id))


def _read_frozen_scope(db, row, principal):
    if context_enabled():
        from app.models.styling_direct import StylingApprovalFact
        fact = db.query(StylingApprovalFact).filter_by(handoff_id=row.id, revision=row.version).first()
        if fact is not None and (fact.scope != principal.scope or fact.source_instance_id != principal.source_instance_id):
            raise HTTPException(404, '交接包不存在')


@router.get('/me', dependencies=[Depends(require_admin)])
def manager_me(request: Request):
    if not context_enabled():
        raise HTTPException(404, '当前实例未启用管理上下文契约')
    principal = require_admin(request)
    with SessionLocal() as db:
        _begin_write(db)
        result = get_me(db, principal)
        db.commit()
    return JSONResponse(result, headers={'Cache-Control': 'no-store'})


@router.get('/operations/{request_id}', dependencies=[Depends(require_admin)])
def manager_operation(request_id: str, request: Request):
    if not context_enabled():
        raise HTTPException(404, '当前实例未启用管理上下文契约')
    with SessionLocal() as db:
        result = lookup_operation(db, require_admin(request), request_id)
    return JSONResponse(result, headers={'Cache-Control': 'no-store'})


def _days(days: int) -> int:
    if days not in (0, 7):
        raise HTTPException(422, "时间范围须为7天或累计")
    return days


def _iso(value):
    if not value:
        return None
    if value.tzinfo is not None:
        value = value.astimezone(timezone.utc).replace(tzinfo=None)
    return value.isoformat() + "Z"


def _json(value, default):
    try:
        result = json.loads(value or "")
        return result if isinstance(result, type(default)) else default
    except (TypeError, ValueError):
        return default


def _window(days, start=None, end=None):
    _days(days)
    if days == 0 and start is None and end is not None:
        if end.tzinfo is None or end.utcoffset() != timedelta(0):
            raise HTTPException(422, "窗口结束时间须含UTC时区（Z或+00:00）")
        return None, end.replace(tzinfo=None)
    if (start is None) != (end is None):
        raise HTTPException(422, "自定义窗口须同时提供UTC起止时间")
    if start is not None:
        if any(v.tzinfo is None or v.utcoffset() != timedelta(0) for v in (start, end)):
            raise HTTPException(422, "窗口起止时间须含UTC时区（Z或+00:00）")
        start, end = (v.replace(tzinfo=None) for v in (start, end))
        if start >= end:
            raise HTTPException(422, "窗口开始时间须早于结束时间")
    else:
        end = utcnow()
        start = end - timedelta(days=days) if days else None
    return start, end


def _bounded(query, column, start, end):
    if start is not None:
        query = query.filter(column >= start)
    return query.filter(column < end)


def _filter_status(status, allowed):
    if status is not None and status not in allowed:
        raise HTTPException(422, "筛选状态无效")


def _evidence_query(db, days=7, key=None, *, bounds=None, category=None, status=None):
    """The supported SQLite deployment filters before applying evidence limits."""
    _filter_status(status, _REVIEW_STATES)
    start, end = bounds or _window(days)
    query = db.query(DemandOccurrence, DemandTurn).join(DemandTurn, DemandOccurrence.turn_id == DemandTurn.id)
    query = _bounded(query, DemandTurn.created_at, start, end)
    if key:
        query = query.filter(DemandOccurrence.group_key == key)
    if status in {"pending", "approved", "rejected"}:
        query = query.filter(DemandOccurrence.review_state == status)
    elif status:
        query = query.filter(DemandOccurrence.lifecycle == status)
    if category is not None:
        # Damaged legacy JSON must not make a manager query fail. Keep the
        # category predicate in SQL so a paged query loads only its own rows.
        safe_attributes = case((func.json_valid(DemandOccurrence.attributes_json),
                                DemandOccurrence.attributes_json), else_="{}")
        query = query.filter(func.json_extract(safe_attributes, "$.category") == category)
    return query.order_by(DemandTurn.created_at.desc(), DemandOccurrence.id)


def _rows(db, days=7, key=None, *, bounds=None, category=None, status=None):
    return _evidence_query(db, days, key, bounds=bounds, category=category, status=status).all()


def _source_snapshot(db, rows):
    """Bind resolved user facts, including referenced turns outside the window.

    Provenance stores turn IDs rather than per-field occurrence IDs, so bind
    every occurrence of each directly referenced turn conservatively. Reading
    and hashing use the caller's coherent read/write transaction.
    """
    _validate_sources(db, rows)
    source_ids = set()
    for occurrence, turn in rows:
        refs = set(_json(occurrence.context_turn_ids_json, []))
        for field_refs in _json(occurrence.field_sources_json, {}).values():
            refs.update(field_refs)
        source_ids.update(ref for ref in refs if ref != turn.id)
    ordered_ids = sorted(source_ids)
    turns = {}
    occurrences = defaultdict(list)
    # Bounded IN clauses also work with SQLite builds using the older variable
    # limit. Do not restrict source facts to the target group's time window.
    for offset in range(0, len(ordered_ids), 500):
        batch = ordered_ids[offset:offset + 500]
        for turn in db.query(DemandTurn).filter(DemandTurn.id.in_(batch)):
            turns[turn.id] = turn
        for occurrence in db.query(DemandOccurrence).filter(DemandOccurrence.turn_id.in_(batch)).order_by(
                DemandOccurrence.turn_id, DemandOccurrence.id):
            _source_data(occurrence)
            occurrences[occurrence.turn_id].append(_occurrence(occurrence))
    return [{"turn": _turn(turns[source_id]), "occurrences": occurrences[source_id]}
            for source_id in ordered_ids]


def _evidence_digest(rows, source_snapshot=None):
    """One content digest for approval previews and the write-locked approval."""
    canonical = [{"id": o.id, "revision": o.revision, "attributes": _json(o.attributes_json, {}),
                  "title": o.title, "description": o.description, "text": t.text,
                  "normalizer": o.normalizer_version, "extractor": t.extractor, "data_origin": t.data_origin,
                  "context_turn_ids": _json(o.context_turn_ids_json, []),
                  "field_sources": _json(o.field_sources_json, {})}
                 for o, t in sorted(rows, key=lambda pair: pair[0].id)]
    if source_snapshot:
        sources = []
        for source in source_snapshot:
            # Ordinary pending -> approved progress changes neither the user
            # fact nor its eligibility. This keeps repeated approvals idempotent,
            # including when the referenced source is also in the target group.
            appearances = [{**item, "review_state": "effective" if item["review_state"] in
                            {"pending", "approved"} else item["review_state"]}
                           for item in source["occurrences"]]
            sources.append({"turn": source["turn"], "occurrences": appearances})
        canonical = {"version": "resolved-sources-v1", "evidence": canonical, "sources": sources}
    return hashlib.sha256(json.dumps(canonical, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def _digest_version(source_snapshot):
    return "resolved-sources-v1" if source_snapshot else "target-evidence-v1"


def _approval_eligibility(source_snapshot):
    # Provenance identifies a turn, not the exact occurrence for each field.
    # Conservatively pause if any appearance of a referenced turn is inactive.
    blocked = [{"turn_id": source["turn"]["id"], "occurrence_id": item["id"],
                "revision": item["revision"], "review_state": item["review_state"],
                "lifecycle": item["lifecycle"]}
               for source in source_snapshot for item in source["occurrences"]
               if item["lifecycle"] != "active" or item["review_state"] == "rejected"]
    return {"policy": "pause-inactive-sources-v1", "eligible": not blocked,
            "reason_codes": ["source_inactive"] if blocked else [], "blocked_sources": blocked,
            "message": "引用来源含已排除或无效记录，相关新审批已暂停；重新核对不会解除，请等待人工复核。"
            if blocked else "当前来源未触发暂停；仍须人工核对全部证据与出处。"}


class SourceApprovalBlocked(HTTPException):
    """Public domain error; only the verified source-eligibility result is exposed."""

    def __init__(self, eligibility):
        self.approval_eligibility = eligibility
        super().__init__(409, eligibility["message"])


def _active(row):
    return row.lifecycle == "active" and row.review_state != "rejected"


def _occurrence(row):
    return {"id": row.id, "turn_id": row.turn_id, "group_key": row.group_key, "title": row.title,
            "description": row.description, "attributes": _json(row.attributes_json, {}),
            "review_state": row.review_state, "reason": row.reason, "revision": row.revision,
            "lifecycle": row.lifecycle, "normalizer_version": row.normalizer_version,
            "context_turn_ids": _json(row.context_turn_ids_json, []),
            "field_sources": _json(row.field_sources_json, {})}


def _turn(row):
    return {"id": row.id, "session_id": row.session_id, "text": row.text, "status": row.status,
            "extractor": row.extractor, "data_origin": row.data_origin, "created_at": _iso(row.created_at),
            "error_code": row.error_code, "extraction_attempts": row.extraction_attempts,
            "negative_preferences": _json(row.negative_json, [])}


def _audit(db, action, target_id, note, before=None, after=None, actor="styling-manager"):
    db.add(DemandAudit(id=uuid.uuid4().hex, action=action, target_id=target_id, note=note,
                       actor=actor,
                       before_json=json.dumps(before or {}, ensure_ascii=False),
                       after_json=json.dumps(after or {}, ensure_ascii=False)))


def _begin_write(db):
    # SQLite needs the write reservation before reading the evidence set; otherwise
    # an approval can commit after a concurrent exclusion using an obsolete read.
    if db.get_bind().dialect.name == "sqlite":
        db.connection().exec_driver_sql("BEGIN IMMEDIATE")


def _remember_revision(db, row, action):
    if not db.query(DemandOccurrenceRevision).filter_by(occurrence_id=row.id, revision=row.revision).first():
        db.add(DemandOccurrenceRevision(id=uuid.uuid4().hex, occurrence_id=row.id, revision=row.revision,
                    snapshot_json=json.dumps(_occurrence(row), ensure_ascii=False), action=action))


def _eligibility(db, row):
    payload = _json(row.payload_json, {})
    meta = _json(row.metadata_json, {})
    reasons = []
    if not payload.get("evidence"):
        reasons.append("evidence_missing")
    digest = hashlib.sha256(row.payload_json.encode()).hexdigest()
    if meta.get("payload_digest") and meta["payload_digest"] != digest:
        reasons.append("snapshot_content_changed")
    expected = meta.get("evidence_revisions", {})
    for evidence in payload.get("evidence", []):
        occurrence_id = evidence.get("occurrence_id")
        item = db.get(DemandOccurrence, occurrence_id)
        if item is None:
            reasons.append("evidence_missing")
        elif not _active(item):
            reasons.append("evidence_inactive")
        elif occurrence_id in expected and expected[occurrence_id] != item.revision:
            reasons.append("evidence_revision_changed")
    return sorted(set(reasons))


def _handoff(row, db=None):
    payload = _json(row.payload_json, {})
    demand = payload.get("demand") if isinstance(payload.get("demand"), dict) else {}
    result = {"id": row.id, "version": row.version, "status": row.status, "created_at": _iso(row.created_at),
              "last_error": row.last_error, "occurrences": demand.get("occurrences", 0),
              "group_key": demand.get("group_key") or row.group_key,
              "title": demand.get("title") if isinstance(demand.get("title"), str) else None}
    if db is not None:
        from app.models.styling_direct import StylingApprovalFact
        approval = db.query(StylingApprovalFact).filter_by(handoff_id=row.id, revision=row.version).first()
        result['approval_identity_kind'] = 'account_bound' if approval else 'legacy_shared_role'
        result['source_approval_ref'] = {'approval_record_id': approval.approval_record_id} if approval else None
        reasons = _eligibility(db, row)
        cutoff = utcnow() - timedelta(seconds=60)
        active_attempt = db.query(DemandSendAttempt).filter(DemandSendAttempt.handoff_id == row.id,
            DemandSendAttempt.status == "sending", DemandSendAttempt.attempted_at >= cutoff).order_by(
            DemandSendAttempt.attempted_at.desc()).first()
        activity = [active_attempt.attempted_at] if active_attempt else []
        if row.status == "sending" and row.received_at is not None and row.received_at >= cutoff:
            activity.append(row.received_at)
        in_progress = bool(activity) and row.status != "received"
        retry_after = max(1, int((max(activity) - cutoff).total_seconds() + 0.999)) if in_progress else 0
        result.update({"needs_review": bool(reasons), "review_reasons": reasons,
                       "send_eligible": not reasons and row.status in {"approved", "failed", "sending"} and not in_progress,
                       "send_in_progress": in_progress, "retry_after_seconds": retry_after,
                       "received_at": _iso(row.received_at), "metadata": _json(row.metadata_json, {})})
    return result


def _attempt(row):
    return {"id": row.id, "handoff_id": row.handoff_id, "status": row.status,
            "attempted_at": _iso(row.attempted_at), "finished_at": _iso(row.finished_at),
            "error_code": row.error_code, "receipt": _json(row.receipt_json, {})}


def _audit_row(row):
    return {"id": row.id, "action": row.action, "target_id": row.target_id, "actor": row.actor,
            "note": row.note, "before": _json(row.before_json, {}), "after": _json(row.after_json, {}),
            "created_at": _iso(row.created_at)}


@router.post("/login", dependencies=[Depends(guard_demo_login)])
def login(body: Login, request: Request, response: Response):
    same_origin(request)
    if not configured():
        raise HTTPException(503, "管理员凭据尚未配置，后台未开放")
    address = request.client.host if request.client else "unknown"
    now = time.monotonic()
    with _login_lock:
        _attempts[address] = [t for t in _attempts[address] if now - t < 300]
        if len(_attempts[address]) >= 5:
            raise HTTPException(429, "登录尝试过多，请5分钟后重试")
        if not hmac.compare_digest(body.password.encode(), os.environ["STYLING_ADMIN_PASSWORD"].encode()):
            _attempts[address].append(now)
            raise HTTPException(401, "管理员密码不正确")
        _attempts.pop(address, None)
    response.set_cookie(COOKIE, token(), max_age=TTL, httponly=True, samesite="strict",
                        secure=os.getenv("STYLING_ADMIN_COOKIE_SECURE", "1") != "0", path="/")
    return {"role": "styling-manager"}


@router.post("/logout", dependencies=[Depends(require_admin)])
def logout(request: Request, response: Response, body: EmptyAdminAction | None = None):
    if context_enabled():
        principal = require_admin(request)
        with SessionLocal() as db:
            _begin_write(db)
            record, replay = _action_begin(db, principal, body, request, 'logout')
            if replay is not None:
                return _action_response(record, replay, record.response_status)
            revoke_session(request, db=db, principal=principal)
            # Context validity also checks authoritative session revocation.
            finish_action(db, record, {'status': 'logged_out'}, outcome='completed')
            result = _action_response(record, {'status': 'logged_out'})
            db.commit()
        result.delete_cookie(COOKIE, path='/')
        return result
    revoke_session(request)
    response.delete_cookie(COOKIE, path="/")
    return {"status": "logged_out"}


@router.get("/overview", dependencies=[Depends(require_admin)])
def overview(days: int = Query(7), category: str | None = None, status: str | None = None,
             page: int = Query(1, ge=1), page_size: int = Query(50, ge=1, le=100),
             window_start: datetime | None = None, window_end: datetime | None = None):
    bounds = _window(days, window_start, window_end)
    with SessionLocal() as db:
        rows = _rows(db, days, bounds=bounds, category=category, status=status)
        groups = {}
        for occurrence, turn in rows:
            if not _active(occurrence):
                continue
            group = groups.setdefault(occurrence.group_key, {
                "key": occurrence.group_key, "title": occurrence.title, "description": occurrence.description,
                "attributes": _json(occurrence.attributes_json, {}), "count": 0, "sessions": set(),
                "last_seen": _iso(turn.created_at), "pending": 0, "data_origins": set(),
            })
            group["count"] += 1
            group["sessions"].add(turn.session_id)
            group["pending"] += occurrence.review_state == "pending"
            group["data_origins"].add(turn.data_origin)
        handoffs = db.query(DemandHandoff).order_by(DemandHandoff.created_at.desc()).all()
        latest = {}
        for handoff in handoffs:
            latest.setdefault(handoff.group_key, _handoff(handoff, db))
        pending_handoffs = [h for h in handoffs if h.status != "received" and h.created_at < bounds[1]
                           and (bounds[0] is None or h.created_at >= bounds[0])
                           and (category is None or _json(h.payload_json, {}).get("demand", {}).get("attributes", {}).get("category") == category)
                           and (status is None or h.group_key in groups)]
        for group in groups.values():
            group["session_count"] = len(group.pop("sessions"))
            group["data_origins"] = sorted(group["data_origins"])
            group["handoff"] = latest.get(group["key"])
        ranking = sorted(groups.values(), key=lambda g: g["key"])
        ranking.sort(key=lambda g: g["last_seen"], reverse=True)
        ranking.sort(key=lambda g: -g["count"])
        turns_query = _bounded(db.query(DemandTurn), DemandTurn.created_at, *bounds)
        tasks_query = _bounded(db.query(TryonTask), TryonTask.created_at, *bounds)
        if category is not None or status is not None:
            turns_query = turns_query.filter(DemandTurn.id.in_({t.id for _, t in rows}))
        task_counts = dict(tasks_query.with_entities(TryonTask.status, func.count()).group_by(TryonTask.status).all())
        images = []
        for task in tasks_query.order_by(TryonTask.created_at.desc()).limit(60):
            filename = Path(urlsplit(task.result_url).path).name
            result_path = DATA_DIR / "tryon-results" / filename if filename else None
            exists = bool(result_path and result_path.is_file())
            images.append({"id": task.id, "session_id": task.session_id, "status": task.status,
                           "scene": task.scene, "product_ids": task.product_ids.split(",") if task.product_ids else [],
                           "result_url": task.result_url if exists and task.result_url.startswith("/tryon-results/") else "",
                           "file_exists": exists, "file_name": filename, "bytes": result_path.stat().st_size if exists else None,
                           "created_at": _iso(task.created_at), "updated_at": _iso(task.updated_at),
                           "error": task.error_message, "historical_model": None, "api_attempts": None, "cost": None})
        turns = [_turn(t) for t in turns_query.order_by(DemandTurn.created_at.desc(), DemandTurn.id).limit(100)]
        offset = (page - 1) * page_size
        return {"scope": "当前服务空间", "days": days, "window_start": _iso(bounds[0]), "window_end": _iso(bounds[1]),
                "groups": ranking[offset:offset + page_size], "groups_total": len(ranking),
                "page": page, "page_size": page_size, "has_more": offset + page_size < len(ranking),
                "turns": turns, "images": images,
                "counts": {"turns": turns_query.count(), "occurrences": sum(g["count"] for g in ranking),
                           "groups": len(ranking), "pending": sum(g["pending"] for g in ranking),
                           "pending_handoffs": len(pending_handoffs),
                           "tasks": sum(task_counts.values()), "succeeded": task_counts.get("succeeded", 0),
                           "failed": task_counts.get("failed", 0), "processing": task_counts.get("processing", 0)},
                "storage": {"database": engine.url.database, "results": str(DATA_DIR / "tryon-results"),
                            "uploads": str(DATA_DIR / "tryon_uploads"), "raw_photo_policy": "处理完成或失败后删除原始上传照片"},
                "receiver_configured": bool(os.getenv("STYLING_DEMAND_RECEIVER_URL") and os.getenv("STYLING_DEMAND_RECEIVER_KEY")),
                "updated_at": _iso(bounds[1])}


@router.get("/groups/{key}", dependencies=[Depends(require_admin)])
def group_detail(key: str, days: int = Query(7), category: str | None = None, status: str | None = None,
                 page: int | None = Query(None, ge=1), page_size: int | None = Query(None, ge=1, le=100),
                 window_start: datetime | None = None, window_end: datetime | None = None):
    bounds = _window(days, window_start, window_end)
    paged = page is not None or page_size is not None
    selected_page, selected_size = page or 1, page_size or 50
    with SessionLocal() as db:
        query = _evidence_query(db, days, key, bounds=bounds, category=category, status=status)
        total = query.count()
        offset = (selected_page - 1) * selected_size
        rows = query.offset(offset).limit(selected_size).all() if paged else query.all()
        handoffs = db.query(DemandHandoff).filter_by(group_key=key).order_by(DemandHandoff.version.desc()).all()
        # A known group outside the current window is an empty successful query.
        if not rows and not handoffs and not db.query(DemandOccurrence).filter_by(group_key=key).first():
            raise HTTPException(404, "需求分组不存在")
        return {"window_start": _iso(bounds[0]), "window_end": _iso(bounds[1]),
                "total": total, "page": selected_page, "page_size": selected_size if paged else total,
                "has_more": paged and offset + selected_size < total,
                "pagination_mode": "paged" if paged else "legacy_full",
                "evidence": [{**_occurrence(o), "session_id": t.session_id, "text": t.text,
                              "created_at": _iso(t.created_at), "extractor": t.extractor,
                              "data_origin": t.data_origin} for o, t in rows],
                "handoffs": [_handoff(h, db) for h in handoffs]}


@router.get("/groups/{key}/approval-set", dependencies=[Depends(require_admin)])
def approval_set(key: str, days: int = Query(7),
                 window_start: datetime | None = None, window_end: datetime | None = None):
    """Full active membership; a page or review filter never limits approval."""
    bounds = _window(days, window_start, window_end)
    with SessionLocal() as db:
        # Python sqlite3's legacy mode does not BEGIN on SELECT. An explicit
        # read transaction keeps the membership, revisions and digest coherent.
        if db.get_bind().dialect.name == "sqlite":
            db.connection().exec_driver_sql("BEGIN")
        if not db.query(DemandOccurrence).filter_by(group_key=key).first():
            raise HTTPException(404, "需求分组不存在")
        query = _evidence_query(db, days, key, bounds=bounds).filter(
            DemandOccurrence.lifecycle == "active", DemandOccurrence.review_state != "rejected")
        rows = query.limit(10001).all()
        if len(rows) > 10000:
            raise HTTPException(409, "有效证据超过10000条，请缩小时间范围后核对；完整批准集合不会截断")
        sources = _source_snapshot(db, rows)
        return {"group_key": key, "days": days, "window_start": _iso(bounds[0]), "window_end": _iso(bounds[1]),
                "active_count": len(rows), "expected_occurrence_ids": [o.id for o, _ in rows],
                "expected_revisions": {o.id: o.revision for o, _ in rows},
                "evidence_digest": _evidence_digest(rows, sources),
                "evidence_digest_version": _digest_version(sources), "source_snapshot": sources,
                "approval_eligibility": _approval_eligibility(sources)}


@router.get("/turns", dependencies=[Depends(require_admin)])
def turns(days: int = Query(7), status: str | None = None, session_id: str | None = None,
          page: int = Query(1, ge=1), page_size: int = Query(50, ge=1, le=100),
          window_start: datetime | None = None, window_end: datetime | None = None):
    _filter_status(status, _TURN_STATES)
    bounds = _window(days, window_start, window_end)
    with SessionLocal() as db:
        query = _bounded(db.query(DemandTurn), DemandTurn.created_at, *bounds)
        if status:
            query = query.filter_by(status=status)
        if session_id:
            query = query.filter_by(session_id=session_id)
        total = query.count()
        records = query.order_by(DemandTurn.created_at.desc(), DemandTurn.id).offset((page - 1) * page_size).limit(page_size).all()
        return {"items": [{**_turn(t), "occurrences": [_occurrence(o) for o in
                    db.query(DemandOccurrence).filter_by(turn_id=t.id).order_by(DemandOccurrence.id)]} for t in records],
                "total": total, "page": page, "page_size": page_size, "scope": "当前服务空间",
                "window_start": _iso(bounds[0]), "window_end": _iso(bounds[1])}


@router.get("/turns/{turn_id}", dependencies=[Depends(require_admin)])
def turn_detail(turn_id: str):
    with SessionLocal() as db:
        row = db.get(DemandTurn, turn_id)
        if row is None:
            raise HTTPException(404, "交流记录不存在")
        occurrences = db.query(DemandOccurrence).filter_by(turn_id=turn_id).order_by(DemandOccurrence.id).all()
        source_ids = {source for o in occurrences for source in _json(o.context_turn_ids_json, [])}
        sources = db.query(DemandTurn).filter(DemandTurn.id.in_(source_ids), DemandTurn.session_id == row.session_id).all()
        return {**_turn(row), "occurrences": [_occurrence(o) for o in occurrences],
                "context_turns": [_turn(t) for t in sources],
                "revision_history": [{"occurrence_id": revision.occurrence_id, "revision": revision.revision,
                    "action": revision.action, "actor": revision.actor, "created_at": _iso(revision.created_at),
                    "snapshot": _json(revision.snapshot_json, {})} for revision in
                    db.query(DemandOccurrenceRevision).filter(DemandOccurrenceRevision.occurrence_id.in_([o.id for o in occurrences]))
                    .order_by(DemandOccurrenceRevision.occurrence_id, DemandOccurrenceRevision.revision)]}


@router.post("/turns/{turn_id}/retry", dependencies=[Depends(require_admin)])
def retry_turn(turn_id: str, request: Request, body: EmptyAdminAction | None = None):
    from app.services.demand import retry_failed_turn
    if context_enabled():
        principal = require_admin(request)
        with SessionLocal() as db:
            _begin_write(db)
            record, replay = _action_begin(db, principal, body, request, 'retry')
            if replay is not None:
                return _action_response(record, replay, record.response_status)
            try:
                result = retry_failed_turn(turn_id, db=db, before_execute=lambda:
                    revalidate_context(db, principal, body.expected_admin_context))
            except ValueError as exc:
                messages = {'TURN_NOT_RETRYABLE': '当前交流无需重试，或另一提炼正在处理',
                            'EXTRACTION_RETRY_LIMIT': '已达到提炼重试上限，请人工核对'}
                raise HTTPException(409, messages.get(str(exc), '当前交流不能重试')) from None
            if result is None:
                raise HTTPException(404, '交流记录不存在')
            _audit(db, 'extraction_retry', turn_id, '管理者重试原交流的有限提炼',
                   after=result, actor=principal.subject)
            failed = result['status'] == 'extraction_failed'
            finish_action(db, record, result, state='failed' if failed else 'completed',
                          outcome='failed' if failed else 'completed',
                          result_ref={'kind': 'demand_turn', 'id': turn_id, 'revision': None})
            response = _action_response(record, result)
            db.commit()
            return response
    try:
        result = retry_failed_turn(turn_id)
    except ValueError as exc:
        messages = {"TURN_NOT_RETRYABLE": "当前交流无需重试，或另一提炼正在处理",
                    "EXTRACTION_RETRY_LIMIT": "已达到提炼重试上限，请人工核对"}
        raise HTTPException(409, messages.get(str(exc), "当前交流不能重试")) from exc
    if result is None:
        raise HTTPException(404, "交流记录不存在")
    with SessionLocal() as db:
        _audit(db, "extraction_retry", turn_id, "管理者重试原交流的有限提炼", after=result)
        db.commit()
    return result


@router.post("/occurrences/{occurrence_id}/reject", dependencies=[Depends(require_admin)])
def reject(occurrence_id: str, body: Review, request: Request):
    principal = require_admin(request)
    note = desensitize(body.note.strip())
    if len(note) < 2:
        raise HTTPException(422, "请填写排除原因")
    with SessionLocal() as db:
        _begin_write(db)
        record, replay = _action_begin(db, principal, body, request, 'reject')
        if replay is not None:
            return _action_response(record, replay, record.response_status)
        row = db.get(DemandOccurrence, occurrence_id)
        if not row:
            raise HTTPException(404, "需求记录不存在")
        if body.expected_revision is not None and row.revision != body.expected_revision:
            raise HTTPException(409, "证据修订已变化，请重新加载")
        if row.review_state == "rejected":
            result = {"status": "rejected", "revision": row.revision}
            if record is not None:
                finish_action(db, record, result, result_ref={'kind': 'demand_occurrence',
                    'id': occurrence_id, 'revision': row.revision})
                response = _action_response(record, result)
                db.commit()
                return response
            return result
        before = _occurrence(row)
        _remember_revision(db, row, "original")
        row.review_state, row.lifecycle, row.reason = "rejected", "excluded", note
        row.revision += 1
        _remember_revision(db, row, "reject")
        _audit(db, "reject", row.id, note, before, _occurrence(row), actor=principal.subject or 'styling-manager')
        result = {"status": "rejected", "revision": row.revision}
        if record is not None:
            finish_action(db, record, result, result_ref={'kind': 'demand_occurrence',
                'id': occurrence_id, 'revision': row.revision})
            response = _action_response(record, result)
        db.commit()
        return response if record is not None else result


@router.post("/occurrences/{occurrence_id}/restore", dependencies=[Depends(require_admin)])
def restore(occurrence_id: str, body: Review):
    if context_enabled():
        raise AdminContextError(409, 'ADMIN_FEATURE_DISABLED', '证据恢复规则待D3确认，当前未启用。')
    if os.getenv("STYLING_DEMAND_D3_ENABLED") != "1":
        raise HTTPException(409, "证据恢复规则待D3确认，当前未启用")
    if body.expected_revision is None:
        raise HTTPException(422, "恢复须指定所见证据修订")
    note = desensitize(body.note.strip())
    if len(note) < 2:
        raise HTTPException(422, "请填写恢复原因")
    with SessionLocal() as db:
        _begin_write(db)
        row = db.get(DemandOccurrence, occurrence_id)
        if not row:
            raise HTTPException(404, "需求记录不存在")
        if row.revision != body.expected_revision:
            raise HTTPException(409, "证据修订已变化，请重新加载")
        if row.lifecycle != "excluded" or row.review_state != "rejected":
            raise HTTPException(409, "只能恢复管理者已排除的证据")
        before = _occurrence(row)
        _remember_revision(db, row, "original")
        row.review_state, row.lifecycle, row.reason = "pending", "active", note
        row.revision += 1
        _remember_revision(db, row, "restore")
        _audit(db, "restore", row.id, note, before, _occurrence(row))
        db.commit()
        return {"status": "pending", "revision": row.revision, "lifecycle": row.lifecycle}


def _source_data(occurrence):
    # Approval facts must not silently collapse damaged JSON to the same empty
    # value as valid legacy data. Ordinary list/query rendering stays tolerant.
    try:
        attrs = json.loads(occurrence.attributes_json)
        contexts = json.loads(occurrence.context_turn_ids_json)
        sources = json.loads(occurrence.field_sources_json)
    except (ValueError, TypeError):
        raise HTTPException(409, "出处数据损坏，请核对后再批准")
    fields = {"season", "scene", "category", "fit", "silhouette"}
    if (not isinstance(attrs, dict) or not set(attrs).issubset(fields)
            or any(value is not None and not isinstance(value, str) for value in attrs.values())
            or not isinstance(contexts, list) or any(not isinstance(ref, str) for ref in contexts)
            or not isinstance(sources, dict) or not set(sources).issubset(fields)):
        raise HTTPException(409, "出处数据格式错误，请核对后再批准")
    if any(not isinstance(refs, list) or not refs or any(not isinstance(ref, str) for ref in refs)
           for refs in sources.values()):
        raise HTTPException(409, "字段出处缺失，请核对后再批准")
    return attrs, contexts, sources


def _validate_sources(db, rows):
    for occurrence, turn in rows:
        attrs, contexts, sources = _source_data(occurrence)
        refs = set(contexts)
        for field_refs in sources.values():
            refs.update(field_refs)
        # Legacy rules-v1 rows lack source maps; preserve their original valid path.
        if occurrence.normalizer_version != "rules-v1":
            if any(value and not sources.get(field) for field, value in attrs.items()):
                raise HTTPException(409, "字段出处缺失，请核对后再批准")
        for source_id in refs:
            source = db.get(DemandTurn, source_id)
            if source is None or source.session_id != turn.session_id or not source.text or source.created_at > turn.created_at:
                raise HTTPException(409, "引用交流缺失或不属于同一会话，不能批准")
        if not turn.text:
            raise HTTPException(409, "原始交流出处缺失，不能批准")


@router.post("/groups/{key}/approve", dependencies=[Depends(require_admin)])
def approve(key: str, body: Review, request: Request):
    principal = require_admin(request)
    note = desensitize(body.note.strip())
    if len(note) < 2:
        raise HTTPException(422, "请填写审核说明")
    with SessionLocal() as db:
        _begin_write(db)
        revalidate_principal(db, principal)
        record, replay = _action_begin(db, principal, body, request, 'approve')
        if replay is not None:
            return _action_response(record, replay, record.response_status)
        bounds = _window(body.days, body.window_start, body.window_end)
        rows = [(o, t) for o, t in _rows(db, body.days, key, bounds=bounds) if _active(o)]
        if not rows:
            raise HTTPException(404, "当前范围没有有效需求")
        ids = {o.id for o, _ in rows}
        if len(body.expected_occurrence_ids) != len(set(body.expected_occurrence_ids)) or set(body.expected_occurrence_ids) != ids:
            raise HTTPException(409, "证据已经更新，请重新查看后审核")
        revisions = {o.id: o.revision for o, _ in rows}
        if body.expected_revisions is None and any(revision > 1 for revision in revisions.values()):
            raise HTTPException(409, "修订证据批准须提供所见ID及修订集合")
        if body.expected_revisions is not None and body.expected_revisions != revisions:
            raise HTTPException(409, "证据修订已经更新，请重新查看后审核")
        sources = _source_snapshot(db, rows)
        if sources and body.expected_evidence_digest is None:
            raise HTTPException(422, "跨轮出处批准须提供完整所见内容摘要，请重新取得基准并核对来源")
        # Review state changes after approval; it is deliberately not fingerprinted.
        evidence_digest = _evidence_digest(rows, sources)
        if body.expected_evidence_digest is not None and body.expected_evidence_digest != evidence_digest:
            raise HTTPException(409, "证据内容已经更新，请重新查看后审核")
        eligibility = _approval_eligibility(sources)
        if not eligibility["eligible"]:
            raise SourceApprovalBlocked(eligibility)
        explicit_bounds = [_iso(bounds[0]), _iso(bounds[1])] if body.window_end is not None else None
        fingerprint = hashlib.sha256(json.dumps([body.days, explicit_bounds, evidence_digest, note]).encode()).hexdigest()
        old = db.query(DemandHandoff).filter_by(group_key=key, fingerprint=fingerprint).first()
        if old:
            result = _handoff(old, db)
            if record is not None:
                finish_action(db, record, result, outcome='reused_frozen',
                              result_ref={'kind': 'handoff', 'id': old.id, 'revision': old.version})
                response = _action_response(record, result)
                db.commit()
                return response
            return result
        version = (db.query(func.max(DemandHandoff.version)).filter_by(group_key=key).scalar() or 0) + 1
        handoff_id = "DH-" + uuid.uuid4().hex
        occurrence = rows[0][0]
        origins = {t.data_origin for _, t in rows}
        approved_at = _iso(utcnow())
        payload = {"schema_version": "1.4", "handoff_id": handoff_id, "revision": version,
                   "source_agent": "outfit", "target_agent": "product", "data_origin": next(iter(origins)) if len(origins) == 1 else "mixed_demo",
                   "approved_at": approved_at, "review_note": note,
                   "demand": {"group_key": key, "title": occurrence.title, "description": occurrence.description,
                              "attributes": _json(occurrence.attributes_json, {}), "occurrences": len(rows),
                              "session_count": len({t.session_id for _, t in rows}), "window_days": body.days,
                              "material": None, "craft": None, "knowledge_status": "pending_database"},
                   "evidence": [{"occurrence_id": o.id, "turn_id": t.id,
                                 "session_ref": hashlib.sha256(t.session_id.encode()).hexdigest(),
                                 "text": t.text, "created_at": _iso(t.created_at), "extractor": t.extractor,
                                 "data_origin": t.data_origin} for o, t in rows]}
        payload_json = json.dumps(payload, ensure_ascii=False)
        metadata = {"window_start": _iso(bounds[0]), "window_end": _iso(bounds[1]),
                    "approved_by": principal.subject if principal.approval_identity_kind == 'account_bound' else "styling-manager",
                    "approved_at": approved_at, "evidence_revisions": revisions, "evidence_digest": evidence_digest,
                    "evidence_digest_version": _digest_version(sources), "source_snapshot": sources,
                    "payload_digest": hashlib.sha256(payload_json.encode()).hexdigest(),
                    "provenance": {o.id: {"normalizer_version": o.normalizer_version,
                        "context_turn_ids": _json(o.context_turn_ids_json, []),
                        "field_sources": _json(o.field_sources_json, {})} for o, _ in rows}}
        handoff = DemandHandoff(id=handoff_id, group_key=key, version=version, fingerprint=fingerprint,
                                payload_json=payload_json, metadata_json=json.dumps(metadata, ensure_ascii=False))
        db.add(handoff)
        if principal.approval_identity_kind == 'account_bound':
            from app.services.styling_evidence import record_approval
            record_approval(db, handoff, {name: getattr(principal, name) for name in
                            ('subject', 'scope', 'source_instance_id', 'auth_method', 'approval_identity_kind')})
        for o, _ in rows:
            o.review_state = "approved"
        _audit(db, "approve", handoff_id, note, after={"version": version, "evidence_revisions": revisions,
                                                     "payload_digest": metadata["payload_digest"]},
               actor=principal.subject if principal.approval_identity_kind == 'account_bound' else "styling-manager")
        try:
            db.flush()
            result = _handoff(handoff, db)
            if record is not None:
                finish_action(db, record, result, outcome='created',
                              result_ref={'kind': 'handoff', 'id': handoff_id, 'revision': version})
                response = _action_response(record, result)
            db.commit()
        except IntegrityError:
            db.rollback()
            old = db.query(DemandHandoff).filter_by(group_key=key, fingerprint=fingerprint).first()
            if old and record is None:
                return _handoff(old, db)
            raise HTTPException(409, "另一个审核刚刚完成，请刷新后重试")
        return response if record is not None else _handoff(handoff, db)


@router.get("/handoffs", dependencies=[Depends(require_admin)])
def handoffs(request: Request, status: str | None = None, group_key: str | None = None,
             page: int = Query(1, ge=1), page_size: int = Query(50, ge=1, le=100)):
    _filter_status(status, {"approved", "sending", "failed", "received"})
    with SessionLocal() as db:
        query = db.query(DemandHandoff)
        if context_enabled():
            from app.models.styling_direct import StylingApprovalFact
            principal = require_admin(request)
            query = query.outerjoin(StylingApprovalFact, StylingApprovalFact.handoff_id == DemandHandoff.id).filter(
                (StylingApprovalFact.approval_record_id.is_(None)) |
                ((StylingApprovalFact.scope == principal.scope) &
                 (StylingApprovalFact.source_instance_id == principal.source_instance_id)))
        if status:
            query = query.filter_by(status=status)
        if group_key:
            query = query.filter_by(group_key=group_key)
        total = query.count()
        records = query.order_by(DemandHandoff.created_at.desc(), DemandHandoff.id).offset((page - 1) * page_size).limit(page_size)
        return {"items": [_handoff(h, db) for h in records], "total": total, "page": page, "page_size": page_size}


@router.get("/handoffs/{handoff_id}", dependencies=[Depends(require_admin)])
def handoff_detail(handoff_id: str, request: Request):
    principal = require_admin(request)
    with SessionLocal() as db:
        row = db.get(DemandHandoff, handoff_id)
        if row is None:
            raise HTTPException(404, "交接包不存在")
        _read_frozen_scope(db, row, principal)
        attempts = db.query(DemandSendAttempt).filter_by(handoff_id=handoff_id).order_by(DemandSendAttempt.attempted_at, DemandSendAttempt.id)
        audits = db.query(DemandAudit).filter_by(target_id=handoff_id).order_by(DemandAudit.created_at, DemandAudit.id)
        return {**_handoff(row, db), "payload": _json(row.payload_json, {}),
                "send_attempts": [_attempt(a) for a in attempts], "audit": [_audit_row(a) for a in audits]}


@router.get("/audit", dependencies=[Depends(require_admin)])
def audit(target_id: str | None = None, action: str | None = None,
          page: int = Query(1, ge=1), page_size: int = Query(50, ge=1, le=100)):
    with SessionLocal() as db:
        query = db.query(DemandAudit)
        if target_id:
            query = query.filter_by(target_id=target_id)
        if action:
            query = query.filter_by(action=action)
        total = query.count()
        records = query.order_by(DemandAudit.created_at.desc(), DemandAudit.id).offset((page - 1) * page_size).limit(page_size)
        return {"items": [_audit_row(a) for a in records], "total": total, "page": page, "page_size": page_size}


@router.get("/handoffs/{handoff_id}/export", dependencies=[Depends(require_admin)])
def export(handoff_id: str, request: Request):
    principal = require_admin(request)
    with SessionLocal() as db:
        row = db.get(DemandHandoff, handoff_id)
        if not row:
            raise HTTPException(404, "交接包不存在")
        _read_frozen_scope(db, row, principal)
        frozen_bytes = row.payload_json.encode("utf-8")
        if not context_enabled():
            _audit(db, "export", row.id, "导出已批准的冻结交接包；未产生接收事实", after={"version": row.version})
            db.commit()
        return Response(content=frozen_bytes, media_type="application/json",
                        headers={"Content-Disposition": f'attachment; filename="{row.id}.json"',
                                 'Cache-Control': 'no-store'})


@router.post("/handoffs/{handoff_id}/send", dependencies=[Depends(require_admin)])
def send(handoff_id: str):
    if context_enabled():
        raise AdminContextError(409, 'ADMIN_LEGACY_MUTATION_DISABLED', '旧发送入口已关闭，请重新核对新版直连操作。')
    endpoint = os.getenv("STYLING_DEMAND_RECEIVER_URL", "")
    key = os.getenv("STYLING_DEMAND_RECEIVER_KEY", "")
    capabilities = {value.strip() for value in os.getenv("STYLING_DEMAND_RECEIVER_RECEIPT_CAPABILITIES", "").split(",") if value.strip()}
    if capabilities.difference({"revision", "payload_digest"}):
        raise HTTPException(503, "接收方回执能力配置不受支持")
    try:
        parsed = urlsplit(endpoint)
        parsed.port  # Reject malformed/out-of-range ports before claiming a send attempt.
    except ValueError as exc:
        raise HTTPException(503, "接收接口地址配置无效") from exc
    if not key or not parsed.netloc or parsed.username or parsed.fragment or not (parsed.scheme == "https" or
            (parsed.scheme == "http" and parsed.hostname in ("localhost", "127.0.0.1", "::1"))):
        raise HTTPException(503, "新版接收接口尚未配置，可先导出交接包联调")
    with SessionLocal() as db:
        _begin_write(db)
        row = db.get(DemandHandoff, handoff_id)
        if not row:
            raise HTTPException(404, "交接包不存在")
        if row.status == "received":
            return _handoff(row, db)
        # Newer evidence or a newer approval never rewrites/supersedes this frozen
        # version. Only changes to its own evidence or content block this send.
        reasons = _eligibility(db, row)
        if reasons:
            raise HTTPException(409, "快照证据或内容已经变化，需重新审核")
        cutoff = utcnow() - timedelta(seconds=60)
        stale_attempts = db.query(DemandSendAttempt).filter_by(handoff_id=handoff_id, status="sending").all()
        if any(a.attempted_at >= cutoff for a in stale_attempts):
            raise HTTPException(409, "交接正在发送，请稍后刷新")
        # Preserve the legacy handoff claim timestamp to recover old in-flight rows.
        if row.status == "sending" and row.received_at is not None and row.received_at >= cutoff:
            raise HTTPException(409, "交接正在发送，请稍后刷新")
        if row.status not in {"approved", "failed", "sending"}:
            raise HTTPException(409, "交接状态不允许发送")
        for attempt in stale_attempts:
            attempt.status, attempt.error_code, attempt.finished_at = "unconfirmed", "send_interrupted", utcnow()
        attempt_id = uuid.uuid4().hex
        attempt = DemandSendAttempt(id=attempt_id, handoff_id=handoff_id)
        db.add(attempt)
        row.status, row.received_at = "sending", utcnow()
        row.last_error = ""
        frozen_bytes = row.payload_json.encode("utf-8")
        revision = row.version
        payload_digest = hashlib.sha256(frozen_bytes).hexdigest()
        _audit(db, "send_attempt", row.id, "人工发送冻结版本", after={"attempt_id": attempt_id, "version": revision})
        db.commit()
    receipt, error_code = {}, ""
    try:
        headers = {"Authorization": f"Bearer {key}", "Idempotency-Key": handoff_id,
                   "Content-Type": "application/json"}
        if "payload_digest" in capabilities:
            headers["X-Handoff-Content-SHA256"] = payload_digest
        response = httpx.post(endpoint, content=frozen_bytes, headers=headers,
                              timeout=15, follow_redirects=False)
        response.raise_for_status()
        receipt = response.json()
        if not isinstance(receipt, dict) or receipt.get("handoff_id") != handoff_id or receipt.get("status") != "received":
            error_code = "receipt_mismatch"
        elif "revision" in receipt and (isinstance(receipt["revision"], bool) or receipt["revision"] != revision):
            error_code = "receipt_revision_mismatch"
        elif "revision" in capabilities and "revision" not in receipt:
            error_code = "receipt_revision_missing"
        elif "payload_digest" in receipt and receipt["payload_digest"] != payload_digest:
            error_code = "receipt_digest_mismatch"
        elif "payload_digest" in capabilities and "payload_digest" not in receipt:
            error_code = "receipt_digest_missing"
    except httpx.TimeoutException:
        error_code = "receiver_timeout"
    except httpx.InvalidURL:
        error_code = "receiver_invalid_url"
    except httpx.HTTPStatusError:
        error_code = "receiver_http_error"
    except httpx.HTTPError:
        error_code = "receiver_network_error"
    except (ValueError, TypeError):
        error_code = "receipt_invalid_json"
    # Store only receipt identity/status fields, never arbitrary partner payloads.
    safe_receipt = {field: desensitize(receipt[field][:256]) if isinstance(receipt[field], str) else receipt[field]
                   for field in ("handoff_id", "status", "revision", "payload_digest")
                   if isinstance(receipt, dict) and field in receipt and isinstance(receipt[field], (str, int))}
    with SessionLocal() as db:
        _begin_write(db)
        row = db.get(DemandHandoff, handoff_id)
        attempt = db.get(DemandSendAttempt, attempt_id)
        attempt.finished_at, attempt.error_code = utcnow(), error_code
        attempt.receipt_json = json.dumps(safe_receipt, ensure_ascii=False)
        newest = db.query(DemandSendAttempt).filter_by(handoff_id=handoff_id).order_by(
            DemandSendAttempt.attempted_at.desc(), DemandSendAttempt.id.desc()).first()
        owns_state = newest.id == attempt_id
        if error_code:
            attempt.status = "failed"
            # A very late failure must not overwrite another attempt's receipt.
            if owns_state and row.status != "received":
                row.status, row.received_at = "failed", None
                row.last_error = "接收未确认：网络异常或回执不匹配。请核对伙伴接口后重试。"
            _audit(db, "send_failed", row.id, "接收未确认", after={"attempt_id": attempt_id, "error_code": error_code})
            db.commit()
            raise HTTPException(502, "接收未确认：网络异常或回执不匹配。请核对伙伴接口后重试。")
        attempt.status = "received"
        # Every attempt sends the same immutable object/idempotency key. A valid
        # late receipt confirms that object even if a retry is now in progress.
        row.status, row.received_at, row.last_error = "received", utcnow(), ""
        _audit(db, "received", row.id, "匹配接收回执", after={"attempt_id": attempt_id, "receipt": safe_receipt})
        db.commit()
        return _handoff(row, db)
