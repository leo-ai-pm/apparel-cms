"""Real chat/admission/SSE seams, isolated DB and controlled provider failures."""
import uuid

from app.core.database import SessionLocal
from app.models.demand import DemandTurn
from app.services import generation, llm
from app.core.config import settings
from tests.conftest import collect_sse


def test_timeout_is_persisted_failure_and_same_request_not_reaccepted(client, monkeypatch):
    monkeypatch.setattr(settings, "llm_retries", 0)

    def broken(*args, **kwargs):
        raise llm.LLMError("LLM_TIMEOUT", "模型调用未完成")
        yield

    monkeypatch.setattr(llm, "stream_chat", broken)
    rid, sid = uuid.uuid4().hex, uuid.uuid4().hex
    body = {"request_id": rid, "session_id": sid, "message": "女 通勤 我想要浅色上衣"}
    response = client.post("/api/v1/chat", json=body)
    assert response.status_code == 200  # Transport opened; this must NOT count as generation success.
    events = collect_sse(response)
    error = [payload for event, payload in events if event == "error"][0]
    assert error["request_id"] == rid and error["session_id"] == sid
    assert not any(event == "done" for event, _ in events)
    record = generation.lookup(rid, sid)
    assert record["status"] == "failed" and record["error_code"] == "LLM_TIMEOUT"
    assert not record["effective_outfit"]
    assert client.post("/api/v1/chat", json=body).status_code == 409
    with SessionLocal() as db:
        assert db.query(DemandTurn).filter_by(request_id=rid).count() == 1
    assert client.get(f"/api/v1/sessions/{sid}/messages").json()["messages"] == []


def test_refusal_is_successful_execution_but_not_effective_outfit(client):
    rid, sid = uuid.uuid4().hex, uuid.uuid4().hex
    response = client.post("/api/v1/chat", json={"request_id": rid, "session_id": sid,
                                                "message": "替我付款下单"})
    done = [p for event, p in collect_sse(response) if event == "done"][0]
    assert done["request_id"] == rid and done["outcome"] == "refusal"
    record = generation.lookup(rid, sid)
    assert record["status"] == "succeeded" and record["outcome"] == "refusal"
    assert not record["effective_outfit"]
