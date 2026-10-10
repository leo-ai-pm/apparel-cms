from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException
from sqlalchemy.exc import SQLAlchemyError

from app.api.chat import router
from app.api.products import router as products_router
from app.api.tryon import recover_interrupted_generations, router as tryon_router
from app.api.signals import router as signals_router
from app.api.cart import router as cart_router
from app.api.admin import SourceApprovalBlocked, router as admin_router
from app.api.consumer_events import router as consumer_events_router
from app.api.outfits import router as outfits_router
from app.api.consumer_profiles import router as consumer_profiles_router, profile_error_handler
from app.api.profile_snapshots import router as profile_snapshots_router
from app.api.personal_preview import router as personal_preview_router, preview_error_handler
from app.api.demo_access import router as demo_access_router
from app.services.personal_preview import PreviewError
from app.services.personal_preview_media import MediaError
from app.api.styling_direct import router as styling_direct_router
from app.core.styling_direct_auth import DirectAuthError
from app.services.styling_evidence import StylingEvidenceError
from app.services.styling_delivery import StylingDeliveryError
from app.schemas.consumer_profile import ProfileError
from app.core.config import DATA_DIR, PRODUCT_IMAGE_DIR
from app.core.database import init_db
from app.services import generation, fixed_styling
from app.services.admin_context import enabled as admin_context_enabled, AdminContextError


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    if admin_context_enabled():
        # Observe an actual deployment start even if no management HTTP arrives.
        # Restoring earlier settings must not revive retired session contexts.
        from app.services.admin_context import observe_authorization_generation
        observe_authorization_generation()
    recover_interrupted_generations()
    generation.interrupted()
    preview_poll = None
    import os
    import asyncio
    if (os.environ.get('STYLING_PERSONAL_PREVIEW_ENABLED', '0') == '1'
            and os.environ.get('STYLING_PERSONAL_PREVIEW_WORKER_AUTORUN', '1') == '1'):
        from app.services.personal_preview import get_store
        from app.services.personal_preview_worker import poll
        preview_poll = asyncio.create_task(poll(store=get_store()))
    try:
        yield
    finally:
        if preview_poll is not None:
            preview_poll.cancel()
            try:
                await preview_poll
            except asyncio.CancelledError:
                pass
        fixed_styling.close_service()


app = FastAPI(title="个性化穿搭Agent", lifespan=lifespan)
app.add_exception_handler(ProfileError, profile_error_handler)
app.add_exception_handler(PreviewError, preview_error_handler)


async def preview_media_error(request, exc):
    return await preview_error_handler(request, PreviewError(
        exc.code, '私有照片处理暂不可用，请保留原任务编号。', exc.status))


app.add_exception_handler(MediaError, preview_media_error)


async def admin_context_error(_request, exc):
    content = {'error': {'code': exc.code, 'message': exc.message, 'retryable': exc.retryable}}
    if exc.code == 'DEMO_LOGIN_NOT_REQUIRED':
        content['entry_path'] = '/admin'
    return JSONResponse(status_code=exc.status,
                        content=content,
                        headers={'Cache-Control': 'no-store'})


app.add_exception_handler(AdminContextError, admin_context_error)


@app.middleware('http')
async def public_demo_legacy_generation_guard(request, call_next):
    from app.core.admin_auth import demo_enabled, demo_mode, ensure_demo_local
    if request.method not in {'GET', 'HEAD', 'OPTIONS'} and request.url.path.startswith('/api/v1/') and demo_enabled():
        try:
            if demo_mode() == 'public':
                if request.method == 'POST' and request.url.path == '/api/v1/tryon':
                    return JSONResponse(status_code=403, content={'error': {
                        'code': 'PUBLIC_DEMO_LEGACY_GENERATION_DISABLED',
                        'message': '公网演示请使用有归属和额度约束的本人效果入口。'}},
                        headers={'Cache-Control': 'no-store'})
                # Covers legacy chat/cart as well as identity-bound routes;
                # the separate /api/integrations machine callback is unaffected.
                ensure_demo_local(request, entering=True)
        except AdminContextError as exc:
            return await admin_context_error(request, exc)
    return await call_next(request)


@app.exception_handler(SQLAlchemyError)
async def admin_storage_error(request, _exc):
    if admin_context_enabled() and request.url.path.startswith('/api/v1/admin/'):
        identity = request.url.path in {'/api/v1/admin/login', '/api/v1/admin/me'}
        return await admin_context_error(request, AdminContextError(503,
            'ADMIN_AUTH_UNAVAILABLE' if identity else 'ADMIN_OPERATION_STORAGE_UNAVAILABLE',
            '管理权威存储暂不可用，请保留原操作并先查询。', True))
    return await internal_error(request, _exc)


@app.middleware('http')
async def strict_admin_writes(request, call_next):
    """Server capability gate; duplicate keys must not alter frozen intent."""
    if admin_context_enabled() and request.url.path.startswith('/api/v1/admin/'):
        import json
        import re
        from app.core.admin_auth import require_admin
        if request.method not in {'GET', 'HEAD', 'OPTIONS'}:
            allowed = request.method == 'POST' and (request.url.path in {
                '/api/v1/admin/login', '/api/v1/admin/logout'} or re.fullmatch(
                r'/api/v1/admin/(groups/[^/]+/approve|occurrences/[^/]+/(reject|restore)|'
                r'turns/[^/]+/retry|handoffs/[^/]+/(evidence-export|direct-send|direct-reconcile|direct-supplement|send))',
                request.url.path))
            if not allowed:
                try:
                    require_admin(request)
                except AdminContextError as exc:
                    return await admin_context_error(request, exc)
                except StarletteHTTPException as exc:
                    return await http_error(request, exc)
                return await admin_context_error(request, AdminContextError(
                    409, 'ADMIN_FEATURE_DISABLED', '此管理写入口未启用。'))
            raw = await request.body()
            if raw:
                def unique_pairs(items):
                    result = {}
                    for key, value in items:
                        if key in result:
                            raise ValueError('duplicate key')
                        result[key] = value
                    return result
                try:
                    json.loads(raw, object_pairs_hook=unique_pairs,
                               parse_constant=lambda _: (_ for _ in ()).throw(ValueError('non-finite')))
                except (ValueError, UnicodeDecodeError):
                    return await admin_context_error(request, AdminContextError(
                        422, 'ADMIN_ACTION_INVALID', '请求JSON无效或含重复字段。'))
        response = await call_next(request)
        response.headers['Cache-Control'] = 'no-store'
        return response
    return await call_next(request)


async def direct_error(_request, exc):
    return JSONResponse(status_code=exc.status, content={'error': {'code': exc.code, 'message': exc.message}},
                        headers={'Cache-Control': 'no-store'})


app.add_exception_handler(DirectAuthError, direct_error)
app.add_exception_handler(StylingEvidenceError, direct_error)
app.add_exception_handler(StylingDeliveryError, direct_error)


@app.exception_handler(StarletteHTTPException)
async def http_error(_request, exc):
    codes = {401: "UNAUTHORIZED", 403: "FORBIDDEN", 404: "NOT_FOUND", 409: "CONFLICT",
             422: "INVALID_REQUEST", 429: "RATE_LIMITED", 502: "RECEIVER_UNCONFIRMED", 503: "NOT_CONFIGURED"}
    detail = exc.detail if isinstance(exc.detail, str) else "请求未能完成"
    content = {
        "error": {"code": codes.get(exc.status_code, "REQUEST_FAILED"), "message": detail}, "detail": detail,
    }
    if isinstance(exc, SourceApprovalBlocked):
        content["error"]["code"] = "SOURCE_APPROVAL_BLOCKED"
        content["approval_eligibility"] = exc.approval_eligibility
    headers = dict(exc.headers or {})
    if _request.url.path.startswith(('/api/v1/generation-requests/', '/api/v1/personal-preview/')):
        # Error responses replace the route's Response, so its private cache
        # policy must also be applied here. Keep retry and other error headers.
        headers = {key: value for key, value in headers.items() if key.lower() != 'cache-control'}
        headers['Cache-Control'] = 'no-store'
    return JSONResponse(status_code=exc.status_code, content=content, headers=headers)


@app.exception_handler(RequestValidationError)
async def validation_error(_request, _exc):
    # Never echo Pydantic's input field, which may contain an admin password or user text.
    message = "请求字段无效，请核对类型、范围和必填字段"
    if admin_context_enabled() and _request.url.path.startswith('/api/v1/admin/') and _request.url.path != '/api/v1/admin/login':
        errors = _exc.errors()
        context_errors = [err for err in errors if 'expected_admin_context' in err.get('loc', ())]
        parsed_body = _exc.body
        if (parsed_body is None or (isinstance(parsed_body, dict) and
                parsed_body.get('expected_admin_context') is None) or
                any(err.get('type') == 'missing' and err.get('loc', ())[-1:] == ('expected_admin_context',)
               for err in context_errors) or any('ADMIN_CONTEXT_REQUIRED' in
                   str(err.get('ctx', {}).get('error', '')) for err in errors)):
            code = 'ADMIN_CONTEXT_REQUIRED'
        elif context_errors:
            code = 'ADMIN_CONTEXT_INVALID'
        else:
            code = 'ADMIN_ACTION_INVALID'
        return JSONResponse(status_code=422, content={'error': {'code': code, 'message': message,
                                                               'retryable': False}},
                            headers={'Cache-Control': 'no-store'})
    return JSONResponse(status_code=422, content={"error": {"code": "INVALID_REQUEST", "message": message},
                                                "detail": message}, headers={'Cache-Control': 'no-store'})


@app.exception_handler(Exception)
async def internal_error(_request, _exc):
    message = "服务内部错误，请稍后重试"
    headers = {'Cache-Control': 'no-store'} if _request.url.path.startswith(
        ('/api/v1/generation-requests/', '/api/v1/personal-preview/')) else None
    return JSONResponse(status_code=500, content={"error": {"code": "INTERNAL", "message": message},
                                                "detail": message}, headers=headers)

app.include_router(router)
app.include_router(products_router)
app.include_router(tryon_router)
app.include_router(signals_router)
app.include_router(cart_router)
app.include_router(admin_router)
app.include_router(consumer_events_router)
app.include_router(outfits_router)
app.include_router(consumer_profiles_router)
app.include_router(profile_snapshots_router)
app.include_router(personal_preview_router)
app.include_router(demo_access_router)
app.include_router(styling_direct_router)

static_dir = Path(__file__).parent / "static"
# 商品白底图与试穿结果图在 data/ 下（gitignore 忽略，不进仓库），单独挂载
product_images_dir = PRODUCT_IMAGE_DIR
product_images_dir.mkdir(parents=True, exist_ok=True)
tryon_results_dir = DATA_DIR / "tryon-results"
tryon_results_dir.mkdir(parents=True, exist_ok=True)
app.mount("/product-images", StaticFiles(directory=str(product_images_dir)), name="product-images")
app.mount("/tryon-results", StaticFiles(directory=str(tryon_results_dir)), name="tryon-results")
app.mount("/", StaticFiles(directory=str(static_dir), html=True), name="static")
