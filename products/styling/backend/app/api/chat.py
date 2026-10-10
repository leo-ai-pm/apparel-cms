import asyncio
import json
import uuid
from datetime import timezone
from sqlalchemy import select
from app.core.database import SessionLocal
from app.models.chat import ChatSession

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse

from app.core.config import settings
from app.core.cost_guard import cost_guard
from app.core.request_admission import admit_request
from app.core.consumer_identity import resolve_consumer_owner
from app.models.profile_snapshot import ConsumerSessionOwner
from app.schemas.consumer_profile import ProfileError
from app.schemas.chat import ChatRequest
from app.services import agent, llm, generation, fixed_styling, profile_snapshots
from app.services.fixed_execution import execute_chat, bound_replay
from app.services.demand import process_admitted_turn

router = APIRouter(prefix="/api/v1", tags=["chat"])


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _admission_rejection(request_id: str, session_id: str, code: str, message: str, headers=None):
    # No request record exists yet. HTTP failure keeps the original identity
    # retryable when the actual admission condition clears; SSE errors are
    # reserved for an accepted execution with a queryable terminal state.
    return JSONResponse(status_code=429, headers=headers, content={
        "error": {"code": code, "message": message}, "detail": message,
        "request_id": request_id, "session_id": session_id,
    })


@router.get("/health")
def health():
    if fixed_styling.enabled():
        fixed = fixed_styling.health()
        return {"status": "ok", "model": fixed.get("model"),
                "has_key": fixed.get("model_configured", False), "generation": fixed}
    return {
        "status": "ok",
        "model": settings.deepseek_model,
        "has_key": bool(settings.deepseek_api_key),
    }


@router.get("/sessions")
def list_sessions(owner=Depends(resolve_consumer_owner)):
    with SessionLocal() as db:
        rows = db.scalars(select(ChatSession).order_by(ChatSession.created_at.desc())).all()
        owners = {row.session_id: row.owner_key for row in db.scalars(select(ConsumerSessionOwner)).all()}
        return {"sessions": [{"id": row.id, "createdAt": row.created_at.replace(tzinfo=timezone.utc).timestamp() * 1000} for row in rows
                             if row.id not in owners or owners[row.id] == owner.binding_key]}


@router.get("/sessions/{session_id}/messages")
def get_messages(session_id: str, owner=Depends(resolve_consumer_owner)):
    fixed_styling.authorize_session(owner, session_id)
    return {"session_id": session_id, "messages": agent.load_history(session_id)}


@router.post("/chat")
async def chat(req: ChatRequest, request: Request, response: Response,
               owner=Depends(resolve_consumer_owner)):
    session_id = req.session_id.strip() or uuid.uuid4().hex
    request_id = req.request_id or uuid.uuid4().hex
    raw_body = await request.json()
    headers = dict(response.headers)
    fixed_styling.authorize_session(owner, session_id)
    binding = raw_body.get("profile_binding")
    if binding is None and (req.request_conditions is not None or fixed_styling.requires_profile_binding(session_id)):
        raise ProfileError("PROFILE_BINDING_REQUIRED", "本次条件需要先准备资料快照。", 422)
    if binding is not None:
        if not req.request_id or not req.session_id:
            raise ProfileError("PROFILE_BINDING_INVALID", "绑定请求必须保留原会话及请求编号。", 422)
        record = bound_replay(owner, session_id, request_id, binding, raw_body, "chat",
                              authorization=request.state.consumer_authorization)
        if record is not None:
            if record["status"] not in ("succeeded", "failed"):
                return JSONResponse(status_code=409, headers=headers, content={
                    "error": {"code": "REQUEST_IN_PROGRESS", "message": "请求已受理，请读取原请求状态。"},
                    "request_id": request_id, "session_id": session_id})
            async def replay_stream():
                if record["status"] == "succeeded":
                    yield _sse("done", record["result"])
                else:
                    yield _sse("error", {"request_id": request_id, "session_id": session_id,
                                         "error": {"code": record["error_code"], "message": "原请求失败；同编号不会再次执行。"}})
            return StreamingResponse(replay_stream(), media_type="text/event-stream", headers=headers)

    # 成本保护：并发上限 + 每日配额
    if not cost_guard.acquire_slot():
        return _admission_rejection(request_id, session_id, "RATE_LIMITED", "当前访问人数过多，请稍后重试", headers)

    try:
        kwargs = ({"profile_owner": owner, "profile_binding": binding, "request_body": raw_body,
                   "profile_authorization": request.state.consumer_authorization}
                  if binding is not None else {})
        admission = admit_request(request_id, session_id, req.message, req.budget, req.scene, **kwargs)
    except Exception:
        cost_guard.release_slot()
        raise
    if admission in ("duplicate", "conflict"):
        cost_guard.release_slot()
        raise HTTPException(409, "请求编号已用于其他内容，请使用新编号" if admission == "conflict" else
                            "这次交流已经记录，请查看原请求结果；不要重复发送")
    if admission == "quota":
        cost_guard.release_slot()
        return _admission_rejection(request_id, session_id, "DAILY_LIMIT", "今日调用次数已达上限，请明日再试", headers)

    try:
        if not process_admitted_turn(request_id):
            raise HTTPException(409, "这次交流已经记录，请查看原请求结果；不要重复发送")
    except Exception:
        generation.fail(request_id, session_id, "EXTRACTION_INTERRUPTED")
        cost_guard.release_slot()
        raise

    async def event_stream():
        slot_in_worker = False
        try:
            generation.start(request_id, session_id)
            if fixed_styling.enabled():
                yield _sse("chunk", {"type": "status", "message": "正在为你搭配…"})
                kwargs = {"profile_owner": owner, "profile_binding": binding} if binding is not None else {}
                worker = asyncio.create_task(asyncio.to_thread(execute_chat, session_id, request_id, req.message, **kwargs))
                slot_in_worker = True
                result = await asyncio.shield(worker)
                if result.get("error"):
                    yield _sse("error", result)
                    return
                yield _sse("chunk", {"type": "text", "content": result["content"]})
                yield _sse("done", result)
                return
            async for event in agent.run_agent_events(session_id, req.message, req.budget, req.scene):
                if event.get("type") == "done":
                    result = {"session_id": event["session_id"], "content": event["content"],
                              "request_id": request_id, "outcome": event.get("outcome", "clarification"),
                              "product_ids": event.get("product_ids", []), "signal_id": event.get("signal_id")}
                    generation.succeed(request_id, session_id, result["outcome"], result)
                    yield _sse("done", result)
                else:
                    yield _sse("chunk", event)
        except llm.LLMError as e:
            generation.fail(request_id, session_id, e.code)
            yield _sse("error", {"request_id": request_id, "session_id": session_id,
                                 "error": {"code": e.code, "message": e.message}})
        except fixed_styling.FixedStylingError as e:
            generation.fail(request_id, session_id, e.code)
            yield _sse("error", {"request_id": request_id, "session_id": session_id,
                                 "error": {"code": e.code, "message": e.message}})
        except HTTPException as e:
            code = "FIXED_GENERATION_FAILED"
            if isinstance(e.detail, dict):
                code = e.detail.get("error", {}).get("code", code)
            generation.fail(request_id, session_id, code)
            yield _sse("error", {"request_id": request_id, "session_id": session_id,
                                 "error": {"code": code, "message": "本次搭配未完成，请读取请求状态后再试"}})
        except Exception:
            generation.fail(request_id, session_id, "INTERNAL")
            yield _sse("error", {"request_id": request_id, "session_id": session_id,
                                 "error": {"code": "INTERNAL", "message": "服务内部错误，请稍后重试"}})
        finally:
            if not slot_in_worker:
                record = generation.lookup(request_id, session_id)
                if record["status"] in ("accepted", "running"):
                    generation.fail(request_id, session_id, "CLIENT_DISCONNECTED")
                cost_guard.release_slot()

    return StreamingResponse(event_stream(), media_type="text/event-stream", headers=headers)
