"""Shared formal-turn ledger for the fixed JSON consumer API."""
import hashlib
import json
import re

from app.core.cost_guard import cost_guard
from app.core.request_admission import admit_request
from app.services import fixed_styling as fixed, generation
from app.services.demand import process_admitted_turn
from app.services import profile_snapshots
from app.schemas.profile_snapshot import ProfileBinding, RequestConditions


def bound_replay(owner, session_id, request_id, binding, body, operation, *, authorization):
    # Verify the endpoint, owner and original raw body before consulting terminal
    # execution. Accepted replays do not depend on current defaults or limits.
    with profile_snapshots.SessionLocal() as db:
        profile_snapshots.validate_binding(db, owner, session_id, request_id, binding,
                                           body, expected_operation=operation, authorization=authorization)
    return profile_snapshots.replay(owner, session_id, request_id, binding, body, authorization=authorization)


def execute_chat(session_id: str, request_id: str, text: str, *, profile_owner=None,
                 profile_binding=None) -> dict:
    """Finish the admitted SSE request in its worker, even after client disconnect.

    This worker owns the previously acquired concurrency slot. It returns an
    error envelope rather than leaving an unobserved task exception.
    """
    from app.services import agent
    try:
        use = (profile_snapshots.get_use(profile_owner, session_id, request_id, profile_binding)
               if profile_binding is not None else None)
        result = fixed.process_chat(session_id, request_id, text, **({'profile_use': use} if use is not None else {}))
        agent.save_history(session_id, text, result["content"])
        result.update(request_id=request_id, session_id=session_id)
        if profile_binding is not None:
            result['profile_binding'] = profile_binding
        generation.succeed(request_id, session_id, result["outcome"], result)
        return result
    except fixed.FixedStylingError as error:
        generation.fail(request_id, session_id, error.code)
        return {"request_id": request_id, "session_id": session_id,
                "error": {"code": error.code, "message": error.message}}
    except Exception:
        generation.fail(request_id, session_id, "INTERNAL")
        return {"request_id": request_id, "session_id": session_id,
                "error": {"code": "INTERNAL", "message": "本次搭配未完成，请读取请求状态。"}}
    finally:
        cost_guard.release_slot()


def execute_turn(session_id: str, body: dict, *, profile_owner=None, profile_authorization=None) -> dict:
    allowed = {"contract_version", "request_id", "idempotency_key", "turn_id",
               "expected_state_revision", "expected_conversation_revision", "user_utterance", "view_context",
               "profile_binding", "request_conditions"}
    valid = (type(body) is dict and not set(body) - allowed and body.get("contract_version") == "0.1.0"
             and type(body.get("user_utterance")) is str and 0 < len(body["user_utterance"].strip()) <= 3000
             and type(body.get("expected_state_revision")) is int and body["expected_state_revision"] >= 0
             and type(body.get("expected_conversation_revision")) is int and body["expected_conversation_revision"] >= 0)
    valid = valid and all(type(body.get(k)) is str and re.fullmatch(r"[A-Za-z0-9_-]{1,64}", body[k])
                          for k in ("request_id", "idempotency_key", "turn_id"))
    if valid and "view_context" in body:
        view = body["view_context"]
        valid = (type(view) is dict and not set(view) - {"look_version_id", "selected_item_ids"}
                 and "look_version_id" in view
                 and (view["look_version_id"] is None or
                      (type(view["look_version_id"]) is str and 0 < len(view["look_version_id"]) <= 128)))
        if valid and "selected_item_ids" in view:
            valid = type(view["selected_item_ids"]) is list and all(type(i) is str for i in view["selected_item_ids"])
    binding = body.get("profile_binding")
    if binding is None and fixed.requires_profile_binding(session_id):
        raise fixed.FixedStylingError("PROFILE_BINDING_REQUIRED", "本次交流需要先准备资料快照。")
    if binding is not None:
        ProfileBinding.model_validate(binding)
    if "request_conditions" in body:
        RequestConditions.model_validate(body["request_conditions"])
        if binding is None:
            raise fixed.FixedStylingError("PROFILE_BINDING_REQUIRED", "本次条件需要先准备资料快照。")
    valid = valid and body.get("idempotency_key") == body.get("request_id")
    if not valid:
        raise fixed.FixedStylingError("INVALID_REQUEST", "自然语言交流字段无效；按钮操作请使用actions接口。")
    if profile_owner is not None:
        fixed.authorize_session(profile_owner, session_id)
    request_id = body["request_id"]
    if binding is not None:
        record = bound_replay(profile_owner, session_id, request_id, binding, body, "turn",
                              authorization=profile_authorization)
        if record is not None:
            if record["status"] == "succeeded":
                return record["result"]
            if record["status"] == "failed":
                raise fixed.FixedStylingError(record["error_code"], "原请求失败；同编号不会再次执行。")
            raise fixed.FixedStylingError("REQUEST_IN_PROGRESS", "交流已受理，请读取原请求状态。")
    fixed.session_view(session_id)  # Reject a missing/foreign fixed session before admission.
    encoded = json.dumps(body, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    fingerprint = hashlib.sha256(encoded.encode()).hexdigest()
    if not cost_guard.acquire_slot():
        raise fixed.FixedStylingError("RATE_LIMITED", "当前请求较多，请稍后重试。")
    admitted = False
    try:
        kwargs = ({"profile_owner": profile_owner, "profile_binding": binding, "request_body": body,
                   "profile_operation": "turn", "profile_authorization": profile_authorization}
                  if binding is not None else {})
        admission = admit_request(request_id, session_id, body["user_utterance"], "", "", fingerprint, **kwargs)
        if admission == "conflict":
            raise fixed.FixedStylingError("IDEMPOTENCY_CONFLICT", "请求编号已用于不同内容。")
        if admission == "quota":
            raise fixed.FixedStylingError("DAILY_LIMIT", "今日交流受理次数已达上限。")
        if admission == "duplicate":
            record = generation.lookup(request_id, session_id)
            if record["status"] == "succeeded":
                return record["result"]
            if record["status"] == "failed":
                raise fixed.FixedStylingError(record["error_code"], "原请求失败；同编号不会再次执行。")
            raise fixed.FixedStylingError("REQUEST_IN_PROGRESS", "交流已受理，请读取原请求状态。")
        admitted = True
        if not process_admitted_turn(request_id):
            raise fixed.FixedStylingError("REQUEST_IN_PROGRESS", "交流已记录，请读取原请求状态。")
        generation.start(request_id, session_id)
        use = (profile_snapshots.get_use(profile_owner, session_id, request_id, binding)
               if binding is not None else None)
        m2_body = {k: v for k, v in body.items() if k not in {"profile_binding", "request_conditions"}}
        result = fixed.turn(session_id, m2_body, **({'profile_use': use} if use is not None else {}))
        if binding is not None:
            result['profile_binding'] = binding
        generation.succeed(request_id, session_id, result["outcome"], result)
        return result
    except fixed.FixedStylingError as error:
        if admitted:
            generation.fail(request_id, session_id, error.code)
        raise
    except Exception:
        if admitted:
            generation.fail(request_id, session_id, "INTERNAL")
        raise
    finally:
        cost_guard.release_slot()
