"""Opaque long-lived anonymous identity; no client-supplied subject selectors."""
import hashlib
import json
import os
import re
import secrets
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from typing import Callable
from urllib.parse import urlsplit

from fastapi import Request, Response
from sqlalchemy.exc import SQLAlchemyError

from app.core.database import SessionLocal
from app.models.consumer_profile import ConsumerProfileIdentity
from app.models.consumer_context import ConsumerIdentityRevocation
from app.models.tryon import utcnow
from app.schemas.consumer_profile import ProfileError

IDENTITY_TTL_SECONDS = 180 * 24 * 60 * 60
_TOKEN = re.compile(r"^[A-Za-z0-9_-]{43}$")
_SCOPE = re.compile(r"^[A-Za-z0-9_.-]{1,80}$")


@dataclass(frozen=True)
class ConsumerOwner:
    app_scope: str
    scope_kind: str
    owner_ref: str

    def __post_init__(self):
        if (not isinstance(self.app_scope, str) or not _SCOPE.fullmatch(self.app_scope)
                or not isinstance(self.scope_kind, str) or self.scope_kind not in {"device", "user"}
                or not isinstance(self.owner_ref, str)
                or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", self.owner_ref)):
            raise ProfileError("PROFILE_OWNER_INVALID", "资料归属无效", 403)

    @property
    def binding(self) -> dict:
        return {"app_scope": self.app_scope, "scope_kind": self.scope_kind, "owner_ref": self.owner_ref}

    @property
    def binding_key(self) -> str:
        return hashlib.sha256(json.dumps(self.binding, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


@dataclass(frozen=True)
class AuthenticatedConsumerPrincipal:
    """Only an existing trusted server auth adapter may set request.state.consumer_principal."""
    app_scope: str
    subject_id: str
    # Optional only for legacy trusted read adapters; mutation contexts require
    # all three facts from the actual server auth adapter, not client input.
    auth_instance_id: str | None = None
    expires_at: datetime | None = None
    revalidate: Callable | None = field(default=None, repr=False, compare=False)


@dataclass(frozen=True)
class ConsumerAuthorization:
    owner: ConsumerOwner
    identity_token_digest: str | None = field(default=None, repr=False)
    principal: AuthenticatedConsumerPrincipal | None = field(default=None, repr=False)


def current_app_scope() -> str:
    value = os.environ.get("CONSUMER_APP_SCOPE", "personalized_styling")
    if not _SCOPE.fullmatch(value):
        raise ProfileError("PROFILE_STORAGE_UNAVAILABLE", "资料空间配置不可用", 503)
    return value


def consumer_cookie_name(app_scope: str | None = None) -> str:
    scope = app_scope or current_app_scope()
    return "styling_consumer_" + hashlib.sha256(scope.encode()).hexdigest()[:12]


def enforce_consumer_origin(request: Request) -> None:
    from app.core.admin_auth import demo_enabled, demo_mode, ensure_demo_local
    if demo_enabled() and demo_mode() == 'public':
        ensure_demo_local(request, entering=request.method not in {'GET', 'HEAD', 'OPTIONS'})
        return
    if request.method in {"GET", "HEAD", "OPTIONS"}:
        return
    if request.headers.get("sec-fetch-site") == "cross-site":
        raise ProfileError("PROFILE_OWNER_INVALID", "请求来源不允许操作资料", 403)
    origin = request.headers.get("origin")
    if origin:
        own = str(request.base_url).rstrip("/")
        configured = os.environ.get("CONSUMER_ALLOWED_ORIGINS", "http://127.0.0.1:3026,http://localhost:3026")
        allowed = {own, *(item.strip().rstrip("/") for item in configured.split(",") if item.strip())}
        if origin.rstrip("/") not in allowed or urlsplit(origin).scheme not in {"http", "https"}:
            raise ProfileError("PROFILE_OWNER_INVALID", "请求来源不允许操作资料", 403)


def resolve_consumer_owner(request: Request, response: Response) -> ConsumerOwner:
    enforce_consumer_origin(request)
    secure_cookie = consumer_cookie_secure(request)
    app_scope = current_app_scope()
    principal = getattr(request.state, "consumer_principal", None)
    if principal is not None:
        if (not isinstance(principal, AuthenticatedConsumerPrincipal) or principal.app_scope != app_scope
                or not isinstance(principal.subject_id, str) or not 1 <= len(principal.subject_id) <= 256):
            raise ProfileError("PROFILE_OWNER_INVALID", "资料归属无效", 403)
        owner_ref = hashlib.sha256((app_scope + "\0" + principal.subject_id).encode()).hexdigest()
        owner = ConsumerOwner(app_scope, "user", owner_ref)
        request.state.consumer_authorization = ConsumerAuthorization(owner, principal=principal)
        return owner

    cookie_name = consumer_cookie_name(app_scope)
    token = request.cookies.get(cookie_name)
    now = utcnow()
    try:
        with SessionLocal() as db:
            row = None
            if isinstance(token, str) and _TOKEN.fullmatch(token):
                digest = hashlib.sha256(token.encode()).hexdigest()
                row = db.query(ConsumerProfileIdentity).filter_by(app_scope=app_scope, token_hash=digest).first()
                if row is not None and db.get(ConsumerIdentityRevocation, row.owner_ref) is not None:
                    # Explicit revocation is an authentication failure, not a
                    # reason to silently create a replacement anonymous owner.
                    raise ProfileError("PROFILE_OWNER_INVALID", "当前资料身份已失效，请重新确认资料范围", 403)
                if row is not None and row.expires_at <= now:
                    row = None
            if row is None:
                token = secrets.token_urlsafe(32)
                row = ConsumerProfileIdentity(owner_ref=uuid.uuid4().hex, app_scope=app_scope,
                                              token_hash=hashlib.sha256(token.encode()).hexdigest(),
                                              created_at=now, expires_at=now + timedelta(seconds=IDENTITY_TTL_SECONDS))
                db.add(row)
                db.commit()
            owner = ConsumerOwner(app_scope, "device", row.owner_ref)
            request.state.consumer_authorization = ConsumerAuthorization(owner, identity_token_digest=row.token_hash)
            remaining = max(1, int((row.expires_at - now).total_seconds()))
    except SQLAlchemyError:
        raise ProfileError("PROFILE_STORAGE_UNAVAILABLE", "资料身份存储暂不可用", 503) from None
    response.set_cookie(cookie_name, token, max_age=remaining, httponly=True, samesite="strict",
                        secure=secure_cookie, path="/")
    return owner


def consumer_cookie_secure(request: Request) -> bool:
    configured = os.getenv('CONSUMER_COOKIE_SECURE')
    if configured not in (None, '0', '1'):
        raise ProfileError('PROFILE_STORAGE_UNAVAILABLE', '消费者HTTPS配置不可用', 503)
    return request.url.scheme == 'https' if configured is None else configured == '1'
