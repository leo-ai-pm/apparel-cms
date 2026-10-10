"""Versioned external intake and purpose-restricted internal service reads."""
from fastapi import APIRouter, Depends, Query, Request, Response
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from ..core.errors import AppError
from ..core.partner_auth import authenticate
from ..schemas.dh import decode_json
from ..services import partner_direct, partner_reader

router = APIRouter()


def reader_auth(request: Request):
    return authenticate(request, "product_workbench_reader")


def lookup_auth(request: Request):
    return authenticate(request, "styling_sender", "lookup")


async def body(request):
    if request.headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
        raise AppError("INVALID_CONTENT_TYPE", "接口仅接受JSON对象", 422)
    chunks, size = [], 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > 8 * 1024 * 1024:
            raise AppError("INPUT_TOO_LARGE", "交接信封超过大小限制", 413)
        chunks.append(chunk)
    raw = b"".join(chunks)
    return decode_json(raw), raw


@router.post("/api/integrations/styling/v1/handoffs")
async def receive(request: Request):
    sender = authenticate(request, "styling_sender", "deliver")
    data, raw = await body(request)
    result = await run_in_threadpool(partner_direct.receive, sender, data, request.headers.get("idempotency-key"), raw)
    return JSONResponse(result, status_code=200 if result["duplicate"] else 201)


@router.get("/api/integrations/styling/v1/handoffs/lookup", dependencies=[Depends(lookup_auth)])
def lookup(request: Request, handoff_id: str = Query(min_length=1, max_length=128), revision: int = Query(ge=1, le=2 ** 63 - 1)):
    sender = authenticate(request, "styling_sender", "lookup")
    return partner_direct.lookup(sender, handoff_id, revision)


@router.post("/api/integrations/styling/v1/handoffs/{direct_receive_id}/supplements")
async def append(request: Request, direct_receive_id: str):
    sender = authenticate(request, "styling_sender", "supplement")
    data, _ = await body(request)
    result = await run_in_threadpool(partner_direct.append_supplement, sender, direct_receive_id, data, request.headers.get("idempotency-key"))
    return JSONResponse(result, status_code=200 if result["duplicate"] else 201)


@router.get("/api/internal/signals", dependencies=[Depends(reader_auth)])
def signals(request: Request, limit: int = Query(50, ge=1, le=50), cursor: str | None = Query(None, max_length=2048)):
    reader = authenticate(request, "product_workbench_reader")
    return partner_reader.list_signals(reader, limit, cursor)


@router.get("/api/internal/signals/{signal_id}")
def signal(request: Request, signal_id: str):
    reader = authenticate(request, "product_workbench_reader")
    return partner_reader.get_signal(reader, signal_id)


@router.get("/api/internal/receipts/{direct_receive_id}/{kind}")
def original(request: Request, direct_receive_id: str, kind: str):
    reader = authenticate(request, "product_workbench_reader")
    if kind not in {"payload", "supplement"}:
        raise AppError("RECEIPT_NOT_FOUND", "原件类型不存在", 404)
    raw, digest = partner_reader.get_blob(reader, direct_receive_id, kind)
    header = "X-Handoff-Content-SHA256" if kind == "payload" else "X-Supplement-Content-SHA256"
    return Response(raw, media_type="application/json", headers={header: digest, "Cache-Control": "no-store"})


@router.post("/api/agent/signals")
def reject_bare(request: Request):
    authenticate(request, "styling_sender", "deliver")
    raise AppError("SOURCE_APPROVAL_REQUIRED", "正式信号须由已批准冻结DH接收生成", 409)


def disabled(request: Request, path: str = ""):
    authenticate(request)
    raise AppError("LEGACY_ROUTE_DISABLED", "新版实例已关闭此旧业务入口", 403)


for legacy in ("/api/agent/{path:path}", "/api/pull", "/api/drafts", "/api/drafts/{path:path}",
               "/api/packages", "/api/packages/{path:path}"):
    router.add_api_route(legacy, disabled, methods=["GET", "POST", "PATCH", "PUT", "DELETE", "HEAD", "OPTIONS"], include_in_schema=False)
