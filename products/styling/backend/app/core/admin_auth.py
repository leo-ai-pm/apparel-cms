"""Styling-only manager sessions, with explicit opt-in single-account bindings."""
import hashlib
import hmac
import os
import re
import time
import uuid
from functools import wraps
from dataclasses import dataclass
from datetime import datetime, timezone
from urllib.parse import urlsplit
import ipaddress
from fastapi import HTTPException, Request
from app.core.database import SessionLocal
from app.models.demand import DemandAdminSession
from app.models.styling_account import StylingAccountSession
from app.models.tryon import utcnow
from sqlalchemy.exc import SQLAlchemyError

COOKIE = os.getenv("STYLING_ADMIN_COOKIE_NAME", "styling_admin_v1")
if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", COOKIE):
    raise RuntimeError("invalid styling manager cookie name")
TTL = 8 * 60 * 60
AUDIENCE = "personal_styling"
_IDENTIFIER = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}\Z")


def _auth_error(status, code, message):
    from app.schemas.admin_context import enabled
    if enabled():
        from app.services.admin_context import AdminContextError
        raise AdminContextError(status, code, message, status == 503)
    raise HTTPException(status, message)


def _safe_auth(fn):
    @wraps(fn)
    def guarded(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except SQLAlchemyError:
            from app.schemas.admin_context import enabled
            if enabled():
                _auth_error(503, "ADMIN_AUTH_UNAVAILABLE", "管理身份权威记录暂不可用，后台写入已停止。")
            raise
    return guarded


@dataclass(frozen=True)
class StylingAdminPrincipal:
    session_id: str
    subject: str | None
    scope: str | None
    source_instance_id: str | None
    auth_method: str
    approval_identity_kind: str
    audience: str = AUDIENCE
    role: str = "styling-manager"


def _enabled() -> bool:
    return os.getenv("STYLING_ADMIN_ENABLED", "1").strip().lower() in {"1", "true", "enabled"}


def configured() -> bool:
    return (_enabled() and (len(os.getenv("STYLING_ADMIN_PASSWORD", "")) >= 12 or demo_enabled())
            and len(os.getenv("STYLING_ADMIN_SECRET", "")) >= 32)


def demo_enabled():
    return os.getenv('STYLING_DEMO_ACCESS_ENABLED', '0') == '1'


def demo_mode():
    from app.services.admin_context import AdminContextError
    value = os.getenv('STYLING_DEMO_ACCESS_MODE', 'local')
    if value not in ('local', 'public'):
        raise AdminContextError(503, 'DEMO_ACCESS_NOT_CONFIGURED', '演示访问模式配置无效。')
    return value


def _public_demo_binding(origin):
    """Explicit synthetic deployment bindings; never inferred from proxy headers."""
    from app.services.admin_context import AdminContextError
    binding = tuple(os.getenv('STYLING_PUBLIC_DEMO_' + key, '') for key in
                    ('SUBJECT', 'SCOPE', 'INSTANCE_ID'))
    actual = tuple(os.getenv(key, '') for key in
                   ('STYLING_ADMIN_SUBJECT', 'STYLING_ADMIN_SCOPE', 'STYLING_DIRECT_INSTANCE_ID'))
    if (not all(_IDENTIFIER.fullmatch(value) for value in binding) or actual != binding
            or os.getenv('CONSUMER_APP_SCOPE') != binding[2]
            or os.getenv('CONSUMER_ALLOWED_ORIGINS') != origin
            or os.getenv('STYLING_ADMIN_COOKIE_SECURE') != '1'
            or os.getenv('CONSUMER_COOKIE_SECURE') != '1'):
        raise AdminContextError(503, 'DEMO_ACCESS_NOT_CONFIGURED', '公网演示身份、空间或HTTPS配置不一致。')
    return binding


def _demo_origin():
    from app.services.admin_context import AdminContextError
    origin = os.getenv('STYLING_ADMIN_PUBLIC_ORIGIN', '')
    try:
        parsed = urlsplit(origin)
        local = parsed.hostname == 'localhost' or bool(parsed.hostname and parsed.hostname.endswith('.localhost'))
        if not local:
            try:
                local = ipaddress.ip_address(parsed.hostname or '').is_loopback
            except ValueError:
                local = False
        mode = demo_mode()
        if (not parsed.hostname or not re.fullmatch(r'[A-Za-z0-9.:-]+', parsed.hostname)
                or (mode == 'local' and (not local or parsed.scheme not in ('http', 'https')))
                or (mode == 'public' and (local or parsed.scheme != 'https')) or parsed.username or parsed.password
                or parsed.path or parsed.query or parsed.fragment):
            raise ValueError()
        parsed.port
    except ValueError:
        raise AdminContextError(503, 'DEMO_ACCESS_NOT_CONFIGURED', '演示访问需要精确有效的Origin配置。') from None
    if mode == 'public':
        _public_demo_binding(origin)
    return origin


def ensure_demo_local(request, *, entering=False):
    from app.services.admin_context import AdminContextError
    origin = _demo_origin()
    if (not request.client or request.client.host not in ('127.0.0.1', '::1')
            or request.headers.get('sec-fetch-site') == 'cross-site'
            or request.headers.get('authorization') is not None):
        raise AdminContextError(403, 'DEMO_ACCESS_FORBIDDEN', '演示身份仅可从可信同源代理入口使用。')
    supplied = request.headers.get('origin')
    if (entering and supplied != origin) or (supplied is not None and supplied != origin):
        raise AdminContextError(403, 'DEMO_ORIGIN_FORBIDDEN', '演示操作必须来自精确同源入口。')


def account_binding_for_method(method):
    if method == 'password_single_account':
        return _account_binding()
    if method == 'demo_server' and demo_enabled() and _enabled():
        from app.schemas.admin_context import enabled
        if not enabled():
            return None
        _demo_origin()
        binding = _account_binding()
        if binding:
            return binding if demo_mode() == 'public' else ('styling-demo-manager', binding[1], binding[2])
    return None


def _account_binding() -> tuple[str, str, str] | None:
    """All identity fields are deployment configuration, never client selectors."""
    values = tuple(os.getenv(key, "") for key in
                   ("STYLING_ADMIN_SUBJECT", "STYLING_ADMIN_SCOPE", "STYLING_DIRECT_INSTANCE_ID"))
    if not any(values):
        return None
    if not all(_IDENTIFIER.fullmatch(value) for value in values):
        _auth_error(503, "ADMIN_AUTH_UNAVAILABLE", "穿搭管理账户绑定配置不完整或无效")
    return values


def _signature(value: str) -> str:
    return hmac.new(os.getenv("STYLING_ADMIN_SECRET", "").encode(), value.encode(), hashlib.sha256).hexdigest()


@_safe_auth
def token() -> str:
    if not configured():
        _auth_error(503, "ADMIN_AUTH_UNAVAILABLE", "管理员凭据尚未配置或已停用，后台未开放")
    binding = _account_binding()
    expires = int(time.time()) + TTL
    nonce = uuid.uuid4().hex
    value = f"{expires}.{nonce}"
    expires_at = datetime.fromtimestamp(expires, timezone.utc).replace(tzinfo=None)
    with SessionLocal() as db:
        db.add(DemandAdminSession(id=nonce, expires_at=expires_at))
        if binding:
            subject, scope, instance = binding
            db.add(StylingAccountSession(session_id=nonce, subject=subject, scope=scope,
                                        source_instance_id=instance, audience=AUDIENCE,
                                        auth_method="password_single_account", expires_at=expires_at))
        from app.schemas.admin_context import enabled
        if enabled():
            if binding is None:
                _auth_error(403, "ADMIN_FORBIDDEN", "旧共享角色身份不能建立新版管理上下文")
            db.flush()
            from app.services.admin_context import establish_context
            establish_context(db, StylingAdminPrincipal(nonce, subject, scope, instance,
                              "password_single_account", "account_bound"))
        db.commit()
    return value + "." + _signature(value)


@_safe_auth
def demo_token(request):
    """Issue only a server-bound demo identity, without business or budget writes."""
    from app.services.admin_context import AdminContextError, establish_context
    if not demo_enabled():
        raise AdminContextError(403, 'DEMO_ACCESS_DISABLED', '临时演示访问未启用。')
    ensure_demo_local(request, entering=True)
    binding = account_binding_for_method('demo_server')
    if not configured() or binding is None:
        raise AdminContextError(503, 'DEMO_ACCESS_NOT_CONFIGURED', '演示管理身份配置不可用。')
    # Malformed/expired/revoked cookies can start another session via explicit
    # enter; conflicting Cookie/Bearer identities cannot silently select one.
    names = [p.strip().split('=', 1)[0] for h in request.headers.getlist('cookie')
             for p in h.split(';') if '=' in p]
    if names.count(COOKIE) > 1:
        raise AdminContextError(401, 'ADMIN_AUTH_REQUIRED', '管理会话身份存在冲突。')
    if request.cookies.get(COOKIE):
        try:
            principal = require_admin(request)
        except (AdminContextError, HTTPException) as error:
            status = error.status if isinstance(error, AdminContextError) else error.status_code
            if status != 401:
                raise
        else:
            if principal.auth_method == 'demo_server':
                return request.cookies[COOKIE]
    nonce = uuid.uuid4().hex
    expires = int(time.time()) + TTL
    expires_at = datetime.fromtimestamp(expires, timezone.utc).replace(tzinfo=None)
    subject, scope, instance = binding
    with SessionLocal() as db:
        db.add(DemandAdminSession(id=nonce, expires_at=expires_at))
        db.add(StylingAccountSession(session_id=nonce, subject=subject, scope=scope,
            source_instance_id=instance, audience=AUDIENCE, auth_method='demo_server', expires_at=expires_at))
        db.flush()
        establish_context(db, StylingAdminPrincipal(nonce, subject, scope, instance, 'demo_server', 'account_bound'))
        db.commit()
    value = f'{expires}.{nonce}'
    return value + '.' + _signature(value)


def guard_demo_login(request: Request):
    if demo_enabled():
        from app.services.admin_context import AdminContextError
        ensure_demo_local(request, entering=True)
        raise AdminContextError(409, 'DEMO_LOGIN_NOT_REQUIRED', '演示模式无需密码，请直接进入/admin。')


def revoke_session(request: Request, *, db=None, principal=None) -> None:
    """Server-side invalidation survives restarts and copied browser cookies."""
    principal = principal or require_admin(request)
    def revoke(transaction):
        now = utcnow()
        session = transaction.get(DemandAdminSession, principal.session_id)
        account = transaction.get(StylingAccountSession, principal.session_id)
        if session:
            session.revoked_at = now
        if account:
            account.revoked_at = now
        from app.schemas.admin_context import enabled
        if enabled():
            from app.services.admin_context import revoke_context
            revoke_context(transaction, principal)
    if db is not None:
        revoke(db)
    else:
        with SessionLocal() as transaction:
            revoke(transaction)
            transaction.commit()


def same_origin(request: Request) -> None:
    if demo_enabled() and demo_mode() == 'public':
        ensure_demo_local(request, entering=True)
    if request.headers.get("sec-fetch-site") == "cross-site":
        _auth_error(403, "ADMIN_ORIGIN_FORBIDDEN", "管理操作必须来自同一网站")
    origin = request.headers.get("origin")
    # The same-origin Next proxy sets this header itself; it never copies a client's value.
    # Trust it only on the loopback connection used by that proxy.
    proxy_host = request.headers.get("x-styling-public-host") if request.client and request.client.host in ("127.0.0.1", "::1") else None
    if not origin:
        return
    public_origin = os.getenv("STYLING_ADMIN_PUBLIC_ORIGIN", "")
    expected = public_origin or f"{request.url.scheme}://{proxy_host or request.headers.get('host', '')}"
    try:
        actual, target = urlsplit(origin), urlsplit(expected)
        for candidate in (actual, target):
            if (candidate.scheme not in {"http", "https"} or not candidate.hostname
                    or candidate.username or candidate.password or candidate.path
                    or candidate.query or candidate.fragment):
                raise ValueError("invalid origin")
            candidate.port  # reject malformed ports
        if origin != expected:
            raise ValueError("different origin")
    except ValueError:
        _auth_error(403, "ADMIN_ORIGIN_FORBIDDEN", "管理操作必须来自同一网站")


@_safe_auth
def require_admin(request: Request) -> StylingAdminPrincipal:
    from app.schemas.admin_context import enabled
    if enabled():
        # Persist generation retirement independently of a rejected business txn.
        from app.services.admin_context import observe_authorization_generation
        observe_authorization_generation()
    if not configured():
        _auth_error(503, "ADMIN_AUTH_UNAVAILABLE", "管理员凭据尚未配置，后台未开放")
    # Personal manager sessions are cookie-only. Do not choose one identity over
    # a conflicting service/product Bearer, even when the cookie itself is valid.
    if request.headers.get("authorization") is not None:
        _auth_error(401, "ADMIN_AUTH_REQUIRED", "管理会话不接受Bearer身份或混合身份")
    named_cookies = [item.strip().split("=", 1)[0] for header in request.headers.getlist("cookie")
                     for item in header.split(";") if "=" in item]
    if named_cookies.count(COOKIE) > 1:
        _auth_error(401, "ADMIN_AUTH_REQUIRED", "管理会话身份存在冲突，请重新登录")
    parts = request.cookies.get(COOKIE, "").split(".")
    value = ".".join(parts[:2])
    if (len(parts) != 3 or not 1 <= len(parts[0]) <= 12
            or not parts[0].isascii() or not parts[0].isdecimal()
            or len(parts[1]) != 32 or any(c not in "0123456789abcdef" for c in parts[1])
            or len(parts[2]) != 64 or any(c not in "0123456789abcdef" for c in parts[2])
            or not hmac.compare_digest(_signature(value), parts[2])):
        _auth_error(401, "ADMIN_AUTH_REQUIRED", "请先登录穿搭管理后台")
    if int(parts[0]) <= time.time():
        _auth_error(401, "ADMIN_SESSION_EXPIRED", "原管理会话已到期，请重新登录")
    with SessionLocal() as db:
        session = db.get(DemandAdminSession, parts[1])
        now = utcnow()
        if not session:
            _auth_error(401, "ADMIN_AUTH_REQUIRED", "请先登录穿搭管理后台")
        if session.revoked_at is not None:
            _auth_error(401, "ADMIN_SESSION_REVOKED", "原管理会话已撤销，请重新登录")
        if session.expires_at <= now:
            _auth_error(401, "ADMIN_SESSION_EXPIRED", "原管理会话已到期，请重新登录")
        if session.expires_at != datetime.fromtimestamp(int(parts[0]), timezone.utc).replace(tzinfo=None):
            _auth_error(401, "ADMIN_AUTH_REQUIRED", "请先登录穿搭管理后台")
        account = db.get(StylingAccountSession, session.id)
        if account is None:
            principal = StylingAdminPrincipal(session.id, None, None, None,
                                              "password_shared_role", "legacy_shared_role")
        else:
            binding = account_binding_for_method(account.auth_method)
            if (binding is None or (account.subject, account.scope, account.source_instance_id) != binding
                    or account.audience != AUDIENCE
                    or account.revoked_at is not None or account.expires_at <= now
                    or account.expires_at != session.expires_at):
                code = "ADMIN_SESSION_EXPIRED" if account.expires_at <= now else "ADMIN_SESSION_REVOKED"
                _auth_error(401, code, "原穿搭管理账户会话已失效，请重新登录")
            principal = StylingAdminPrincipal(session.id, account.subject, account.scope,
                                              account.source_instance_id, account.auth_method, "account_bound")
            if account.auth_method == 'demo_server':
                ensure_demo_local(request)
            if enabled():
                from app.models.admin_context import AdminSessionContext
                context = db.get(AdminSessionContext, session.id)
                if context is not None and context.revoked_at is not None:
                    _auth_error(401, "ADMIN_SESSION_REVOKED", "原管理会话授权已撤销，请重新登录")
    if request.method not in ("GET", "HEAD"):
        same_origin(request)
    request.state.styling_admin_principal = principal
    return principal


def require_account_bound(request: Request) -> StylingAdminPrincipal:
    """Freshly authenticate an account-bound manager for new direct operations."""
    principal = require_admin(request)
    if principal.approval_identity_kind != "account_bound":
        _auth_error(403, "ADMIN_FORBIDDEN", "旧共享角色会话缺账户绑定，不能用于新版直连批准或发送")
    return principal


@_safe_auth
def revalidate_principal(db, principal, *, account_required=False):
    """Repeat validity inside a caller's write transaction, including replay."""
    if not configured():
        _auth_error(401, "ADMIN_SESSION_REVOKED", "穿搭管理会话已停用")
    read = (lambda key: principal.get(key)) if isinstance(principal, dict) else (lambda key: getattr(principal, key, None))
    session = db.get(DemandAdminSession, read('session_id'), populate_existing=True)
    at = utcnow()
    if session is None:
        _auth_error(401, "ADMIN_AUTH_REQUIRED", "穿搭管理会话已失效")
    if session.revoked_at is not None:
        _auth_error(401, "ADMIN_SESSION_REVOKED", "穿搭管理会话已撤销")
    if session.expires_at <= at:
        _auth_error(401, "ADMIN_SESSION_EXPIRED", "穿搭管理会话已到期")
    account = db.get(StylingAccountSession, session.id, populate_existing=True)
    if account is None:
        if account_required or read('approval_identity_kind') != 'legacy_shared_role':
            _auth_error(403, "ADMIN_FORBIDDEN", "该管理会话没有账户绑定")
        return
    if (account.revoked_at is not None or account.expires_at <= at or account.expires_at != session.expires_at
            or account.audience != AUDIENCE
            or account_binding_for_method(account.auth_method) != (account.subject, account.scope, account.source_instance_id)
            or (read('subject'), read('scope'), read('source_instance_id')) !=
               (account.subject, account.scope, account.source_instance_id)
            or read('auth_method') != account.auth_method):
        code = "ADMIN_SESSION_EXPIRED" if account.expires_at <= at else "ADMIN_SESSION_REVOKED"
        _auth_error(401, code, "穿搭管理账户授权上下文已失效")
