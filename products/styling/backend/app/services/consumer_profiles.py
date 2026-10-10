"""Atomic default-profile revisions; operation receipts never contain body values."""
import hashlib
import json
import uuid
from contextlib import nullcontext
from datetime import timedelta, timezone

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from pydantic import ValidationError

from app.core.consumer_identity import ConsumerOwner
from app.core.consumer_context import (check_expected_context, check_pending_token, invalidate_pending_tokens,
                                       issue_context, validate_authorization)
from app.core.database import SessionLocal
from app.models.consumer_profile import ConsumerProfileOperation, SavedConsumerProfile
from app.models.consumer_context import ConsumerOperationContext
from app.models.tryon import utcnow
from app.schemas.consumer_profile import (PROFILE_CONTRACT, ProfileError, ProfileFields, ProfileMutation,
                                         SavedProfileResponse)

PROFILE_TTL_SECONDS = 180 * 24 * 60 * 60


def _encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _empty():
    return ProfileFields().model_dump(mode="json")


def _time(value):
    return value.replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z") if value else None


def _lock(db):
    if db.bind.dialect.name == "sqlite":
        db.execute(text("BEGIN IMMEDIATE"))


def _invalidate_prepared(db, owner):
    try:
        from app.services.profile_snapshots import invalidate_prepared
    except ModuleNotFoundError as exc:
        if exc.name == "app.services.profile_snapshots":
            return 0  # BE02 not registered yet: no prepared snapshots can exist.
        raise
    return invalidate_prepared(db, owner, reason="PROFILE_CLEARED")


def _public(owner, row):
    try:
        fields = ProfileFields.model_validate(json.loads(row.base_profile_json)) if row else ProfileFields()
    except (ValidationError, ValueError, TypeError):
        raise ProfileError("PROFILE_STORAGE_UNAVAILABLE", "资料记录暂不可读取", 503) from None
    result = {"profile_contract": PROFILE_CONTRACT, "profile_id": row.profile_id if row else None,
            "profile_version": row.profile_version if row else 0, "scope_kind": owner.scope_kind,
            "status": row.status if row else "empty",
            "base_profile": fields.model_dump(mode="json"),
            "default_budget_fen": row.default_budget_fen if row else None,
            "updated_at": _time(row.updated_at) if row else None,
            "expires_at": _time(row.expires_at) if row else None,
            "storage_notice": "当前用户资料" if owner.scope_kind == "user" else "本设备的当前浏览器资料"}
    try:
        return SavedProfileResponse.model_validate(result).model_dump(mode="json")
    except ValidationError:
        raise ProfileError("PROFILE_STORAGE_UNAVAILABLE", "资料记录暂不可读取", 503) from None


def _profile(db, owner):
    return db.query(SavedConsumerProfile).filter_by(owner_binding=owner.binding_key).first()


def _flatten(value, prefix=""):
    result = {}
    for key, item in value.items():
        name = f"{prefix}.{key}" if prefix else key
        if isinstance(item, dict) and set(item) != {"system", "value"}:
            result.update(_flatten(item, name))
        else:
            result[name] = item
    return result


def _receipt(row, action_id, operation, before, fields, created_at):
    return {"profile_contract": PROFILE_CONTRACT, "profile_action_id": action_id,
            "operation": operation, "profile_id": row.profile_id, "version_before": before,
            "scope_kind": row.scope_kind,
            "profile_version": row.profile_version, "profile_status": row.status,
            "changed_field_names": sorted(fields), "status": "succeeded", "created_at": _time(created_at)}


def _record(db, owner, row, action_id, operation, before, fields, digest, now):
    receipt = _receipt(row, action_id, operation, before, fields, now)
    db.add(ConsumerProfileOperation(operation_id=uuid.uuid4().hex, owner_binding=owner.binding_key,
                                   profile_action_id=action_id, payload_digest=digest, operation_type=operation,
                                   profile_id=row.profile_id, version_before=before, version_after=row.profile_version,
                                   changed_field_names_json=_encoded(sorted(fields)), status="succeeded",
                                   result_json=_encoded(receipt), created_at=now))
    return receipt


def _expire(db, row, now):
    owner = ConsumerOwner(row.app_scope, row.scope_kind, row.owner_ref)
    before = row.profile_version
    old = {"base_profile": json.loads(row.base_profile_json), "default_budget_fen": row.default_budget_fen}
    row.base_profile_json, row.default_budget_fen = _encoded(_empty()), None
    row.profile_version, row.status, row.updated_at, row.expires_at = before + 1, "expired", now, None
    _invalidate_prepared(db, owner)
    fields = [key for key, value in _flatten(old).items() if value is not None]
    action_id = "expiry-" + uuid.uuid4().hex
    _record(db, owner, row, action_id, "expire", before, fields, "", now)


def purge_expired_profiles(db=None) -> int:
    try:
        with nullcontext(db) if db is not None else SessionLocal() as active:
            if db is None:
                _lock(active)
            now = utcnow()
            rows = active.query(SavedConsumerProfile).filter(SavedConsumerProfile.expires_at <= now).all()
            for row in rows:
                _expire(active, row, now)
            if db is None:
                active.commit()
            return len(rows)
    except SQLAlchemyError:
        raise ProfileError("PROFILE_STORAGE_UNAVAILABLE", "资料存储暂不可用", 503) from None


def read_profile(owner: ConsumerOwner, db=None, *, authorization=None) -> dict:
    try:
        with nullcontext(db) if db is not None else SessionLocal() as active:
            if db is None:
                _lock(active)
            if authorization is not None:
                validate_authorization(active, owner, authorization)
            row = _profile(active, owner)
            if row is not None and row.expires_at is not None and row.expires_at <= utcnow():
                _expire(active, row, utcnow())
            result = _public(owner, row)
            if authorization is not None:
                result["authorization_context"] = issue_context(active, owner, authorization)
            if db is None:
                active.commit()
            return result
    except SQLAlchemyError:
        raise ProfileError("PROFILE_STORAGE_UNAVAILABLE", "资料读取暂不可用", 503) from None


def _merge(base, patch):
    base = json.loads(_encoded(base))
    for key, value in patch.items():
        if key == "usual_sizes":
            if value is None:
                base[key] = _empty()[key]
            else:
                base[key].update(value)
        else:
            base[key] = value
    return ProfileFields.model_validate(base).model_dump(mode="json")


def _has_null(value):
    if isinstance(value, dict):
        return any(_has_null(item) for item in value.values())
    return value is None


def mutate_profile(owner: ConsumerOwner, req: ProfileMutation, *, authorization=None) -> dict:
    digest = hashlib.sha256(_encoded(req.model_dump(mode="json", exclude_unset=True)).encode()).hexdigest()
    try:
        with SessionLocal() as db:
            _lock(db)
            context = check_expected_context(db, owner, authorization, req.expected_authorization_context)
            old_action = db.query(ConsumerProfileOperation).filter_by(owner_binding=owner.binding_key,
                                                                     profile_action_id=req.profile_action_id).first()
            if old_action is not None:
                if old_action.payload_digest != digest:
                    raise ProfileError("PROFILE_ACTION_CONFLICT", "资料操作编号已用于其他内容", 409)
                return json.loads(old_action.result_json)
            mutation_token = check_pending_token(db, context, req.expected_authorization_context)
            row = _profile(db, owner)
            now = utcnow()
            if row is not None and row.expires_at is not None and row.expires_at <= now:
                _expire(db, row, now)
                db.flush()
            version = row.profile_version if row else 0
            if req.expected_profile_version != version:
                # Expiry is a retention fact and must persist even when this old edit is rejected.
                db.commit()
                raise ProfileError("PROFILE_VERSION_CONFLICT", "资料已变化，请重读当前版本后确认", 409)
            if row is None:
                row = SavedConsumerProfile(profile_id=uuid.uuid4().hex, owner_binding=owner.binding_key,
                                           app_scope=owner.app_scope, scope_kind=owner.scope_kind, owner_ref=owner.owner_ref,
                                           profile_version=0, status="empty", base_profile_json=_encoded(_empty()))
                db.add(row)
            before_values = {"base_profile": json.loads(row.base_profile_json), "default_budget_fen": row.default_budget_fen}
            patch = req.patch.model_dump(mode="json", exclude_unset=True)
            if req.operation == "clear":
                row.base_profile_json, row.default_budget_fen = _encoded(_empty()), None
                row.status, row.expires_at = "cleared", None
            else:
                if "base_profile" in patch:
                    base = _empty() if patch["base_profile"] is None else _merge(before_values["base_profile"], patch["base_profile"])
                    row.base_profile_json = _encoded(base)
                if "default_budget_fen" in patch:
                    row.default_budget_fen = patch["default_budget_fen"]
                row.status, row.expires_at = "saved", now + timedelta(seconds=PROFILE_TTL_SECONDS)
            row.profile_version, row.updated_at = version + 1, now
            if req.operation == "clear" or _has_null(patch):
                _invalidate_prepared(db, owner)
            after_values = {"base_profile": json.loads(row.base_profile_json), "default_budget_fen": row.default_budget_fen}
            flat_before, flat_after = _flatten(before_values), _flatten(after_values)
            fields = [key for key in set(flat_before) | set(flat_after)
                      if flat_after.get(key) != flat_before.get(key)]
            result = _record(db, owner, row, req.profile_action_id, req.operation, version, fields, digest, now)
            db.flush()
            action = db.query(ConsumerProfileOperation).filter_by(owner_binding=owner.binding_key,
                                                                 profile_action_id=req.profile_action_id).one()
            db.add(ConsumerOperationContext(operation_id=action.operation_id, context_id=context.context_id,
                                           token_digest=mutation_token.token_digest, owner_binding=owner.binding_key))
            mutation_token.accepted_action_id = req.profile_action_id
            db.flush()
            if req.operation == "clear":
                invalidate_pending_tokens(db, context)
            db.commit()
            return result
    except SQLAlchemyError:
        raise ProfileError("PROFILE_STORAGE_UNAVAILABLE", "资料保存暂不可用，请查询原操作", 503) from None


def lookup_operation(owner: ConsumerOwner, action_id: str, *, authorization=None) -> dict:
    try:
        with SessionLocal() as db:
            _lock(db)
            validate_authorization(db, owner, authorization)
            row = db.query(ConsumerProfileOperation).filter_by(owner_binding=owner.binding_key,
                                                              profile_action_id=action_id).first()
            if row is None:
                raise ProfileError("PROFILE_OPERATION_NOT_FOUND", "资料操作不存在", 404)
            return json.loads(row.result_json)
    except SQLAlchemyError:
        raise ProfileError("PROFILE_STORAGE_UNAVAILABLE", "资料操作暂不可读", 503) from None
