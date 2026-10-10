"""需求信号接口（PRD v1.3 第 12.7 节）：草稿查询 + 人工点击上传。"""
from fastapi import APIRouter, Depends
from app.core.admin_auth import require_admin
from fastapi.responses import JSONResponse

from app.schemas.signal import UploadSignalRequest
from app.services import signals

router = APIRouter(prefix="/api/v1", tags=["signals"])


def _error(code: str, message: str, status_code: int = 400):
    return JSONResponse(status_code=status_code, content={"error": {"code": code, "message": message}})


@router.get("/signals", dependencies=[Depends(require_admin)])
def list_signals(session_id: str):
    return {"signals": signals.list_signals(session_id.strip())}


@router.post("/signals/{signal_id}/upload", dependencies=[Depends(require_admin)])
def upload_signal(signal_id: str, req: UploadSignalRequest):
    result = signals.upload_signal(signal_id.strip(), req.feedback_type)
    if "error" in result:
        err = result["error"]
        return _error(err["code"], err["message"], 400)
    return result


@router.get("/recommendations")
def recommendations(session_id: str):
    rows = signals.list_signals(session_id.strip())
    draft = next((row for row in rows if row["status"] == "draft"), rows[0] if rows else None)
    return {"product_ids": [item["product_id"] for item in draft["outfit_plan"].get("items", [])] if draft else []}
