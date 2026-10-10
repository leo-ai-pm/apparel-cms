"""Partner managed entrypoint; legacy providers/DB/static UI are never loaded."""
import uuid

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from .api.partner import router
from .core.errors import AppError
app = FastAPI(title="产品需求 Agent · 伙伴受控接收")
app.include_router(router)


@app.exception_handler(AppError)
async def app_error_handler(request: Request, exc: AppError):
    return JSONResponse(
        status_code=exc.status_code,
        content={"error": {"code": exc.code, "message": exc.message,
                            "retryable": exc.status_code in {502, 503, 504}},
                 "request_id": "PREQ-" + uuid.uuid4().hex},
        headers={"Cache-Control": "no-store"},
    )


@app.exception_handler(RequestValidationError)
async def validation_handler(request: Request, exc: RequestValidationError):
    return JSONResponse(
        status_code=422,
        content={"error": {"code": "INVALID_INPUT", "message": "请求参数不合法", "retryable": False},
                 "request_id": "PREQ-" + uuid.uuid4().hex},
    )


@app.get("/health")
def health():
    return {"status": "ok", "mode": "managed", "capabilities": {
        "paid_models": False, "public_search": False, "legacy_cms": False, "catalog_probe": False}}


@app.middleware("http")
async def no_cache(request: Request, call_next):
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    return response
