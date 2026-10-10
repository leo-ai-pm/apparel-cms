from fastapi import APIRouter, Header
from secrets import compare_digest
import os

from ..core.errors import AppError
from ..schemas.agent import AnalysisRequest, ChatRequest
from ..schemas.api import PublishRequest
from ..services import agent_tools, deepseek, pipeline, store
from ..services.cms import CmsClient
from ..db import list_direct_signals, save_direct_signal
from ..schemas.signal import SignalIn

router = APIRouter(prefix="/api")


@router.get("/agent/signals")
def agent_signals():
    """Read locally stored, desensitized outfit signals without a CMS dependency."""
    records = list_direct_signals(limit=100)
    fields = ("signal_id", "timestamp", "scene", "season", "preference", "change_reason",
              "body_type_tag", "outfit_plan", "feedback_type", "source_agent")
    return {"signals": [{key: record.get(key) for key in fields} for record in records
                        if not str(record.get("signal_id", "")).startswith("SIG-DEMO-")]}


@router.post("/agent/signals", status_code=201)
def ingest_signal(payload: SignalIn, x_signal_key: str = Header(default="", alias="X-Signal-Key")):
    key = os.getenv("OUTFIT_SIGNAL_KEY", "")
    if len(key) < 32 or not compare_digest(x_signal_key, key):
        raise AppError("UNAUTHORIZED", "穿搭信号接口未授权", 401)
    if payload.signal_id.startswith(("SIG-DEMO-", "SIG-TEST-")):
        raise AppError("INVALID_SIGNAL", "演示和测试编号不能进入真实需求雷达", 400)
    try:
        created = save_direct_signal(payload.model_dump(exclude_none=True))
    except ValueError as error:
        raise AppError("SIGNAL_CONFLICT", str(error), 409) from error
    return {"signal_id": payload.signal_id, "created": created}


@router.get("/agent/status")
def agent_status():
    return {"configured": deepseek.is_configured(), "provider": "DeepSeek", "tools": agent_tools.tool_availability()}


@router.post("/agent/analyze")
def agent_analyze(body: AnalysisRequest):
    return deepseek.analyze(body.signal)


@router.post("/agent/chat")
def agent_chat(body: ChatRequest):
    return deepseek.chat(body)


@router.post("/pull")
def pull():
    return pipeline.pull()


@router.get("/drafts")
def list_drafts():
    return {"drafts": store.list_drafts()}


@router.get("/drafts/{draft_id}")
def get_draft(draft_id: int):
    row = store.get_draft_row(draft_id)
    if row is None:
        raise AppError("DRAFT_NOT_FOUND", "草稿不存在或已回传", 404)
    return row


@router.post("/drafts/{draft_id}/publish")
def publish(draft_id: int, body: PublishRequest):
    return pipeline.publish(draft_id, body)


@router.patch("/drafts/{draft_id}")
def save_draft(draft_id: int, body: PublishRequest):
    return pipeline.save_draft(draft_id, body)


@router.get("/packages")
def list_packages():
    return {"packages": store.list_packages()}


@router.get("/packages/{package_id}")
def get_package(package_id: str):
    row = store.get_package_row(package_id)
    if row is None:
        raise AppError("PACKAGE_NOT_FOUND", "证据包不存在", 404)
    return row


@router.post("/packages/{package_id}/rework")
def rework(package_id: str):
    return pipeline.rework(package_id)
