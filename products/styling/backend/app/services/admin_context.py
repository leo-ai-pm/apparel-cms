"""Manager intent binding and global action ownership in caller transactions.

No function here sends HTTP, allocates a transport lease or reads another product.
The operation GET projection never exposes context/session/private response bodies.
"""
from functools import wraps
import hashlib
import hmac
import json
import os
import re
import secrets
import uuid
from datetime import timezone

from pydantic import ValidationError
from sqlalchemy.exc import SQLAlchemyError

from app.models.admin_context import (
    AdminAuthorizationGeneration, AdminSessionContext, AdminOperation, AdminOperationResponse,
)
from app.models.demand import DemandAdminSession
from app.models.styling_account import StylingAccountSession
from app.models.styling_delivery import StylingDirectAction, StylingDirectDelivery
from app.models.tryon import utcnow
from app.schemas.admin_context import (
    ACTION_CONTRACT, CONTEXT_CONTRACT, AdminActionFields, AdminIdentity,
    AdminOperationMetadata, ExpectedAdminContext, enabled,
)


class AdminContextError(Exception):
    def __init__(self, status, code, message, retryable=False):
        self.status, self.code, self.message, self.retryable = status, code, message, retryable
        super().__init__(code)


def _error(status, code, message, retryable=False):
    raise AdminContextError(status, code, message, retryable)


def _storage(fn):
    @wraps(fn)
    def guarded(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except (SQLAlchemyError, json.JSONDecodeError, ValidationError):
            _error(503, "ADMIN_OPERATION_STORAGE_UNAVAILABLE", "管理操作权威记录暂不可用，请先查询原操作。", True)
    return guarded


def _auth_storage(fn):
    @wraps(fn)
    def guarded(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except (SQLAlchemyError, ValidationError):
            _error(503, "ADMIN_AUTH_UNAVAILABLE", "管理身份权威绑定暂不可用，后台写入已停止。", True)
    return guarded


def _read(principal, key):
    return principal.get(key) if isinstance(principal, dict) else getattr(principal, key, None)


def _json(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _sha(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _utc(value):
    if value is None:
        return None
    return value.replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")


def _configuration_digest():
    # Secret values never leave the digest calculation or appear in reports.
    keys = ("STYLING_ADMIN_ENABLED", "STYLING_ADMIN_PASSWORD", "STYLING_ADMIN_SECRET",
            "STYLING_ADMIN_SUBJECT", "STYLING_ADMIN_SCOPE", "STYLING_DIRECT_INSTANCE_ID",
            "STYLING_ADMIN_PUBLIC_ORIGIN", "STYLING_ADMIN_COOKIE_NAME", "STYLING_ADMIN_COOKIE_SECURE",
            "STYLING_DEMO_ACCESS_ENABLED", "STYLING_DEMO_ACCESS_MODE", "STYLING_PUBLIC_DEMO_SUBJECT",
            "STYLING_PUBLIC_DEMO_SCOPE", "STYLING_PUBLIC_DEMO_INSTANCE_ID", "CONSUMER_APP_SCOPE",
            "CONSUMER_ALLOWED_ORIGINS", "CONSUMER_COOKIE_SECURE")
    return _sha(_json({**{key: os.getenv(key, "") for key in keys},
                      "role": "styling-manager", "audience": "personal_styling",
                      "context_contract": CONTEXT_CONTRACT}))


def current_generation(db):
    """Observe a configuration transition; retirement is permanent when committed."""
    active = db.query(AdminAuthorizationGeneration).filter_by(retired_at=None).all()
    digest = _configuration_digest()
    if len(active) == 1 and hmac.compare_digest(active[0].configuration_digest, digest):
        return active[0]
    now = utcnow()
    for old in active:
        old.retired_at = now
    # Retire context bindings even if a configuration value later returns.
    db.query(AdminSessionContext).filter_by(revoked_at=None).update(
        {AdminSessionContext.revoked_at: now}, synchronize_session="fetch")
    value = AdminAuthorizationGeneration(id=uuid.uuid4().hex,
                                         configuration_digest=digest, created_at=now)
    db.add(value)
    db.flush()
    return value


def observe_authorization_generation():
    """Authentication observes generations before rejection in its own transaction.

    Consequently a failed request's business rollback cannot revive a previous
    configuration. Existing live instances keep this opt-in code disabled.
    """
    if not enabled():
        return
    from app.core.database import SessionLocal
    from sqlalchemy import text
    try:
        with SessionLocal() as db:
            if db.bind.dialect.name == "sqlite":
                db.execute(text("BEGIN IMMEDIATE"))
            current_generation(db)
            db.commit()
    except SQLAlchemyError:
        _error(503, "ADMIN_AUTH_UNAVAILABLE", "管理身份权威绑定暂不可用，后台写入已停止。", True)


@_auth_storage
def _real_principal(db, principal):
    from app.core.admin_auth import revalidate_principal
    revalidate_principal(db, principal, account_required=True)
    if (_read(principal, "role") not in (None, "styling-manager")
            or _read(principal, "audience") not in (None, "personal_styling")
            or _read(principal, "approval_identity_kind") != "account_bound"):
        _error(403, "ADMIN_FORBIDDEN", "该会话没有完整管理账户授权。")
    return db.get(StylingAccountSession, _read(principal, "session_id"), populate_existing=True)


@_auth_storage
def establish_context(db, principal):
    account = _real_principal(db, principal)
    generation = current_generation(db)
    existing = db.get(AdminSessionContext, account.session_id, populate_existing=True)
    if existing is not None:
        if (existing.revoked_at is not None or existing.expires_at <= utcnow()
                or existing.generation_id != generation.id):
            _error(401, "ADMIN_SESSION_REVOKED", "原管理会话授权已失效，请重新登录。")
        return existing
    context = AdminSessionContext(session_id=account.session_id, context_id=secrets.token_urlsafe(32),
        generation_id=generation.id, subject=account.subject, scope=account.scope,
        source_instance_id=account.source_instance_id, role="styling-manager",
        audience=account.audience, auth_method=account.auth_method, expires_at=account.expires_at)
    db.add(context)
    db.flush()
    return context


@_auth_storage
def get_me(db, principal):
    if not enabled():
        _error(409, "ADMIN_FEATURE_DISABLED", "当前实例未启用管理原子上下文。")
    context = establish_context(db, principal)
    expiry = _utc(context.expires_at)
    value = {"identity_contract": "styling_admin_identity_v1", "subject": context.subject,
        "role": context.role, "audience": context.audience, "scope": context.scope,
        "source_instance_id": context.source_instance_id, "auth_method": context.auth_method,
        "approval_identity_kind": "account_bound", "expires_at": expiry,
        "authorization_context": {"context_contract": CONTEXT_CONTRACT,
            "context_id": context.context_id, "expires_at": expiry}}
    return AdminIdentity.model_validate(value).model_dump(mode="json")


me = get_me


@_auth_storage
def revalidate_context(db, principal, expected):
    # This must precede any operation replay, business writes, execution or lease.
    account = _real_principal(db, principal)
    if expected is None:
        _error(422, "ADMIN_CONTEXT_REQUIRED", "管理操作缺少原会话上下文，请保留编辑并重新核对。")
    if hasattr(expected, "model_dump"):
        expected = expected.model_dump(mode="json")
    try:
        expected = ExpectedAdminContext.model_validate(expected)
    except ValidationError:
        _error(422, "ADMIN_CONTEXT_INVALID", "管理上下文格式或版本无效。")
    generation = current_generation(db)
    context = db.get(AdminSessionContext, account.session_id, populate_existing=True)
    if (context is None or context.revoked_at is not None or context.expires_at <= utcnow()
            or context.generation_id != generation.id
            or (context.subject, context.scope, context.source_instance_id,
                context.audience, context.auth_method, context.role) !=
               (account.subject, account.scope, account.source_instance_id,
                account.audience, account.auth_method, "styling-manager")
            or not hmac.compare_digest(context.context_id, expected.context_id)):
        _error(409, "ADMIN_AUTH_CONTEXT_CHANGED", "原管理上下文已变化，旧操作只能查询事实，请重新核对。")
    return context


def _legacy_actions(db, principal, request_id):
    return (db.query(StylingDirectAction, StylingDirectDelivery)
        .join(StylingDirectDelivery, StylingDirectDelivery.id == StylingDirectAction.delivery_id)
        .filter(StylingDirectAction.scope == _read(principal, "scope"),
                StylingDirectAction.request_id == request_id,
                StylingDirectDelivery.scope == _read(principal, "scope"),
                StylingDirectDelivery.source_instance_id == _read(principal, "source_instance_id"))
        .all())


@_storage
def begin_action(db, principal, body, method, path, kind):
    value = body.model_dump(mode="json") if hasattr(body, "model_dump") else dict(body)
    context = revalidate_context(db, principal, value.get("expected_admin_context"))
    # Common strict fields are checked even for a non-Pydantic internal caller.
    try:
        AdminActionFields.model_validate({key: value.get(key) for key in
            ("admin_action_contract", "request_id", "expected_admin_context")})
    except ValidationError:
        _error(422, "ADMIN_ACTION_INVALID", "管理操作契约或请求标识无效。")
    if kind not in {"approve", "reject", "retry", "evidence_export", "direct_send", "direct_reconcile", "direct_supplement", "logout"}:
        _error(409, "ADMIN_FEATURE_DISABLED", "该管理写入口尚未启用原子上下文。")
    request_id = value["request_id"]
    method = method.upper()
    # Query strings and client-selected hosts are deliberately excluded.
    if method != "POST" or not isinstance(path, str) or not path.startswith("/api/v1/admin/") or "?" in path or "#" in path:
        _error(422, "ADMIN_ACTION_INVALID", "管理操作路径无效。")
    digest = _sha(_json({"method": method, "path": path, "body": value}))
    binding = _sha(context.context_id)
    record = db.query(AdminOperation).filter_by(source_instance_id=context.source_instance_id,
        scope=context.scope, request_id=request_id).first()
    if record is not None:
        if record.actor_subject != context.subject:
            _error(404, "ADMIN_OPERATION_NOT_FOUND", "未找到该本人管理操作。")
        if record.operation_context_ref != binding:
            _error(409, "ADMIN_ACTION_CONTEXT_CONFLICT", "原请求标识属于另一个管理上下文，不能替换后重交。")
        if record.operation_kind != kind or record.method != method or record.path != path or record.body_digest != digest:
            _error(409, "ADMIN_ACTION_BODY_CONFLICT", "原请求标识已绑定另一份管理操作内容。")
        if record.state == "pending":
            _error(409, "ADMIN_ACTION_IN_PROGRESS", "原管理操作仍在处理中，请只查询原状态。")
        if record.response_status is None or record.response is None:
            _error(503, "ADMIN_OPERATION_STORAGE_UNAVAILABLE", "原操作响应暂不可用，不能重复执行。", True)
        if _sha(record.response_json) != record.response_digest:
            _error(503, "ADMIN_OPERATION_STORAGE_UNAVAILABLE", "原操作响应校验未通过，不能重复执行。", True)
        replay = json.loads(record.response_json)
        if not isinstance(replay, dict):
            _error(503, "ADMIN_OPERATION_STORAGE_UNAVAILABLE", "原操作响应类型无效。", True)
        return record, replay
    legacy = _legacy_actions(db, principal, request_id)
    if legacy:
        if any(action.actor_subject != context.subject for action, _ in legacy):
            _error(404, "ADMIN_OPERATION_NOT_FOUND", "未找到该本人管理操作。")
        _error(409, "ADMIN_ACTION_LEGACY_UNBOUND", "该历史操作没有原上下文绑定，只能读取已有事实。")
    if not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", request_id):
        _error(422, "ADMIN_ACTION_INVALID", "新管理操作必须使用规范小写UUID请求标识。")
    record = AdminOperation(id=uuid.uuid4().hex, source_instance_id=context.source_instance_id,
        scope=context.scope, request_id=request_id, actor_subject=context.subject,
        operation_context_ref=binding, operation_kind=kind, method=method, path=path,
        body_digest=digest, state="pending", outcome=None, accepted_at=utcnow(),
        result_ref_json="null")
    db.add(record)
    db.flush()
    return record, None


@_storage
def finish_action(db, record, result, status_code=200, outcome="completed", state="completed", result_ref=None, *, status=None):
    if status is not None:
        status_code = status
    if not isinstance(result, dict) or isinstance(status_code, bool) or not isinstance(status_code, int):
        _error(503, "ADMIN_OPERATION_STORAGE_UNAVAILABLE", "管理操作响应无法安全保存。", True)
    if record.state != "pending":
        _error(409, "ADMIN_ACTION_BODY_CONFLICT", "已完成管理操作不能覆盖原响应。")
    content = _json(result)
    record.state, record.outcome = state, outcome
    record.completed_at = utcnow()
    record.result_ref_json = _json(result_ref)
    record.response_digest, record.response_status = _sha(content), status_code
    record.response = AdminOperationResponse(content_json=content)
    # Validate the metadata relationship before persisting any completed fact.
    _metadata(record)
    db.flush()
    return result


def _metadata(record):
    return AdminOperationMetadata.model_validate({
        "operation_contract": ACTION_CONTRACT, "request_id": record.request_id,
        "actor_subject": record.actor_subject, "operation_kind": record.operation_kind,
        "context_binding": "bound", "operation_context_ref": record.operation_context_ref,
        "body_digest": record.body_digest, "state": record.state, "outcome": record.outcome,
        "accepted_at": _utc(record.accepted_at), "completed_at": _utc(record.completed_at),
        "result_ref": json.loads(record.result_ref_json),
    }).model_dump(mode="json")


def _legacy_metadata(action, delivery):
    kind = {"send": "direct_send", "reconcile": "direct_reconcile", "supplement": "direct_supplement"}.get(action.operation)
    if kind is None:
        _error(503, "ADMIN_OPERATION_STORAGE_UNAVAILABLE", "历史操作类型无法安全读取。", True)
    response = json.loads(action.response_json)
    if action.finished_at is None:
        state, outcome = "pending", None
    elif isinstance(response, dict) and response.get("status") == "received":
        state, outcome = "completed", "received"
    else:
        state, outcome = "unconfirmed", "unconfirmed"
    return AdminOperationMetadata.model_validate({
        "operation_contract": ACTION_CONTRACT, "request_id": action.request_id,
        "actor_subject": action.actor_subject, "operation_kind": kind,
        "context_binding": "legacy_unbound", "operation_context_ref": None, "body_digest": None,
        "state": state, "outcome": outcome, "accepted_at": _utc(action.created_at),
        "completed_at": _utc(action.finished_at),
        "result_ref": {"kind": "direct_delivery", "id": delivery.id, "revision": delivery.revision},
    }).model_dump(mode="json")


@_storage
def lookup_operation(db, principal, request_id):
    _real_principal(db, principal)
    if not isinstance(request_id, str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{1,160}", request_id):
        _error(404, "ADMIN_OPERATION_NOT_FOUND", "未找到该本人管理操作。")
    record = db.query(AdminOperation).filter_by(source_instance_id=_read(principal, "source_instance_id"),
        scope=_read(principal, "scope"), request_id=request_id).first()
    if record is not None:
        if record.actor_subject != _read(principal, "subject"):
            _error(404, "ADMIN_OPERATION_NOT_FOUND", "未找到该本人管理操作。")
        return _metadata(record)
    legacy = _legacy_actions(db, principal, request_id)
    if len(legacy) == 1 and legacy[0][0].actor_subject == _read(principal, "subject"):
        return _legacy_metadata(*legacy[0])
    _error(404, "ADMIN_OPERATION_NOT_FOUND", "未找到该本人管理操作。")


def action_headers(request_id):
    return {"Cache-Control": "no-store", "X-Styling-Admin-Action-Contract": ACTION_CONTRACT,
            "X-Styling-Admin-Request-Id": request_id}


def revoke_context(db, principal):
    value = db.get(AdminSessionContext, _read(principal, "session_id"), populate_existing=True)
    if value is not None and value.revoked_at is None:
        value.revoked_at = utcnow()
