"""Validate mutation intent against current authenticated owner inside its transaction."""
import hashlib
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from sqlalchemy.exc import SQLAlchemyError

from app.core.consumer_identity import (AuthenticatedConsumerPrincipal, ConsumerAuthorization, ConsumerOwner,
                                       current_app_scope)
from app.models.consumer_profile import ConsumerProfileIdentity
from app.models.consumer_context import (ConsumerAuthorizationContext, ConsumerIdentityRevocation,
                                        ConsumerMutationToken)
from app.models.tryon import utcnow
from app.schemas.consumer_profile import ProfileError

CONTEXT_CONTRACT = "consumer_profile_mutation_context_v1"
TOKEN_TTL_SECONDS = 600


def _time(value):
    return value.replace(tzinfo=timezone.utc).isoformat().replace("+00:00", "Z")


def validate_authorization(db, owner: ConsumerOwner, authorization: ConsumerAuthorization):
    """No context/token grants permission; current server identity remains required."""
    if (not isinstance(authorization, ConsumerAuthorization) or authorization.owner != owner
            or current_app_scope() != owner.app_scope):
        raise ProfileError("PROFILE_AUTH_CONTEXT_INVALID", "资料授权上下文不可用，请重新读取", 403)
    now = utcnow()
    if owner.scope_kind == "device":
        identity = db.get(ConsumerProfileIdentity, owner.owner_ref)
        if (identity is None or identity.app_scope != owner.app_scope
                or identity.token_hash != authorization.identity_token_digest
                or identity.expires_at <= now or db.get(ConsumerIdentityRevocation, owner.owner_ref) is not None):
            raise ProfileError("PROFILE_OWNER_INVALID", "当前资料身份已失效，请重新确认资料范围", 403)
        return hashlib.sha256(("device\0" + owner.owner_ref).encode()).hexdigest(), identity.expires_at
    principal = authorization.principal
    if (not isinstance(principal, AuthenticatedConsumerPrincipal) or principal.app_scope != owner.app_scope
            or not isinstance(principal.auth_instance_id, str) or not 1 <= len(principal.auth_instance_id) <= 128
            or not isinstance(principal.expires_at, datetime) or not callable(principal.revalidate)):
        raise ProfileError("PROFILE_AUTH_CONTEXT_INVALID", "当前登录适配器未提供资料写入授权实例", 403)
    expected_ref = hashlib.sha256((principal.app_scope + "\0" + principal.subject_id).encode()).hexdigest()
    if expected_ref != owner.owner_ref:
        raise ProfileError("PROFILE_AUTH_CONTEXT_CHANGED", "资料范围已变化，请重新明确确认", 403)
    expiry = principal.expires_at
    if expiry.tzinfo is not None:
        expiry = expiry.astimezone(timezone.utc).replace(tzinfo=None)
    try:
        valid = expiry > now and principal.revalidate(db) is True
    except SQLAlchemyError:
        raise
    except Exception:
        valid = False
    if not valid:
        raise ProfileError("PROFILE_OWNER_INVALID", "当前登录资料授权已失效，请重新确认", 403)
    return hashlib.sha256(("user\0" + principal.auth_instance_id).encode()).hexdigest(), expiry


def issue_context(db, owner, authorization):
    instance, identity_expiry = validate_authorization(db, owner, authorization)
    context = db.query(ConsumerAuthorizationContext).filter_by(owner_binding=owner.binding_key,
                                                              auth_instance_ref=instance).first()
    if context is None:
        context = ConsumerAuthorizationContext(context_id=uuid.uuid4().hex, owner_binding=owner.binding_key,
                                               auth_instance_ref=instance)
        db.add(context)
        db.flush()
    if context.revoked_at is not None:
        raise ProfileError("PROFILE_AUTH_CONTEXT_INVALIDATED", "原资料授权上下文已失效", 409)
    raw_token = secrets.token_urlsafe(32)
    now = utcnow()
    expiry = min(now + timedelta(seconds=TOKEN_TTL_SECONDS), identity_expiry)
    db.add(ConsumerMutationToken(token_digest=hashlib.sha256(raw_token.encode()).hexdigest(),
                                context_id=context.context_id, purpose="profile_mutation", issued_at=now,
                                expires_at=expiry))
    return {"context_contract": CONTEXT_CONTRACT, "context_id": context.context_id,
            "operation_token": raw_token, "issued_at": _time(now), "expires_at": _time(expiry)}


def check_expected_context(db, owner, authorization, expected):
    instance, _ = validate_authorization(db, owner, authorization)
    context = db.get(ConsumerAuthorizationContext, expected.context_id)
    if context is None:
        raise ProfileError("PROFILE_AUTH_CONTEXT_INVALID", "资料授权上下文不存在或无效", 403)
    if context.owner_binding != owner.binding_key or context.auth_instance_ref != instance:
        raise ProfileError("PROFILE_AUTH_CONTEXT_CHANGED", "资料范围已变化，请重新明确确认", 403)
    if context.revoked_at is not None:
        raise ProfileError("PROFILE_AUTH_CONTEXT_INVALIDATED", "原资料授权上下文已失效", 409)
    return context


def check_pending_token(db, context, expected):
    digest = hashlib.sha256(expected.operation_token.encode()).hexdigest()
    token = db.get(ConsumerMutationToken, digest)
    if token is None or token.context_id != context.context_id or token.purpose != "profile_mutation":
        raise ProfileError("PROFILE_AUTH_CONTEXT_INVALID", "资料操作令牌无效，请重新明确确认", 403)
    if token.revoked_at is not None:
        raise ProfileError("PROFILE_AUTH_CONTEXT_INVALIDATED", "原资料操作已失效，请重新明确确认", 409)
    if token.expires_at <= utcnow():
        raise ProfileError("PROFILE_AUTH_CONTEXT_EXPIRED", "原资料操作已过期，请重新明确确认", 409)
    if token.accepted_action_id is not None:
        raise ProfileError("PROFILE_AUTH_CONTEXT_INVALIDATED", "资料操作令牌已受理，请查询原操作", 409)
    return token


def invalidate_pending_tokens(db, context):
    # Clear invalidates all earlier operation-token facts for this profile owner,
    # including tokens attached to success/clear. Completed receipts are checked
    # before token status and remain metadata-only replays.
    contexts = db.query(ConsumerAuthorizationContext.context_id).filter_by(owner_binding=context.owner_binding)
    db.query(ConsumerMutationToken).filter(ConsumerMutationToken.context_id.in_(contexts),
        ConsumerMutationToken.revoked_at.is_(None)).update({"revoked_at": utcnow()}, synchronize_session=False)
