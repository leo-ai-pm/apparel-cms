"""Pre-admission rejection is HTTP failure, not an accepted generation terminal.

Each case owns a fresh SQLite database and a real concurrency semaphore. The
provider seam throws a controlled offline error; no credential or HTTP is used.
"""
from datetime import date, timedelta
from types import SimpleNamespace
import uuid

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.api import chat as chat_api
from app.core import request_admission
from app.core.config import settings
from app.core.cost_guard import CostGuard
from app.models.chat import Base, DailyUsage
from app.models.demand import DemandRequestAdmission, DemandTurn
from app.models.generation import GenerationRequest
from app.services import agent, demand, generation, llm
from tests.conftest import collect_sse


@pytest.fixture
def isolated_admission(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path}/admission.db", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    local = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    for module in (chat_api, request_admission, agent, demand, generation):
        monkeypatch.setattr(module, "SessionLocal", local)
    monkeypatch.setenv("STYLING_FIXED_ENABLED", "0")
    monkeypatch.setattr(settings, "max_concurrency", 1)
    monkeypatch.setattr(settings, "daily_call_limit", 1)
    monkeypatch.setattr(settings, "llm_retries", 0)
    guard = CostGuard()
    monkeypatch.setattr(chat_api, "cost_guard", guard)
    days = [date(2097, 10, 10)]
    monkeypatch.setattr(request_admission, "date", SimpleNamespace(today=lambda: days[0]))
    calls, extractions = [], []
    failure = ["LLM_TIMEOUT"]

    def offline_failure(*args, **kwargs):
        calls.append(failure[0])
        raise llm.LLMError(failure[0], "离线受控执行失败")
        yield  # Preserve the streaming generator interface.

    process = demand.process_admitted_turn

    def counted_extraction(request_id):
        extractions.append(request_id)
        return process(request_id)

    monkeypatch.setattr(llm, "stream_chat", offline_failure)
    monkeypatch.setattr(chat_api, "process_admitted_turn", counted_extraction)
    body = {"request_id": uuid.uuid4().hex, "session_id": uuid.uuid4().hex,
            "message": "女 通勤 我想要浅色上衣", "budget": "800", "scene": "通勤"}
    yield {"db": local, "guard": guard, "days": days, "calls": calls, "extractions": extractions,
           "failure": failure, "body": body}
    engine.dispose()


def _assert_not_admitted(client, isolated, code):
    body = isolated["body"]
    response = client.post("/api/v1/chat", json=body)
    assert response.status_code == 429
    assert response.headers["content-type"].startswith("application/json")
    data = response.json()
    assert data["error"]["code"] == code
    assert data["error"]["message"] and data["detail"] == data["error"]["message"]
    assert data["request_id"] == body["request_id"] and data["session_id"] == body["session_id"]
    with isolated["db"]() as db:
        assert db.get(DemandRequestAdmission, body["request_id"]) is None
        assert db.query(DemandTurn).filter_by(request_id=body["request_id"]).count() == 0
        assert db.get(GenerationRequest, body["request_id"]) is None
    assert client.get(f"/api/v1/generation-requests/{body['request_id']}",
                      params={"session_id": body["session_id"]}).status_code == 404
    assert isolated["calls"] == isolated["extractions"] == []


def _assert_accepted_once(client, isolated, expected_error="LLM_TIMEOUT"):
    body = isolated["body"]
    response = client.post("/api/v1/chat", json=body)
    assert response.status_code == 200
    events = collect_sse(response)
    errors = [data for event, data in events if event == "error"]
    assert len(errors) == 1 and errors[0]["error"]["code"] == expected_error
    assert errors[0]["request_id"] == body["request_id"] and errors[0]["session_id"] == body["session_id"]
    assert not any(event == "done" for event, _ in events)
    record = client.get(f"/api/v1/generation-requests/{body['request_id']}",
                        params={"session_id": body["session_id"]}).json()
    assert record["status"] == "failed" and record["error_code"] == expected_error
    assert record["effective_outfit"] is False
    assert client.post("/api/v1/chat", json=body).status_code == 409
    assert isolated["calls"] == [expected_error]
    assert isolated["extractions"] == [body["request_id"]]
    with isolated["db"]() as db:
        assert db.query(DemandRequestAdmission).count() == 1
        assert db.query(DemandTurn).count() == 1
        assert db.query(GenerationRequest).count() == 1
        assert db.query(DailyUsage).filter_by(day=isolated["days"][0].isoformat()).one().count == 1
    assert isolated["guard"].acquire_slot() is True
    isolated["guard"].release_slot()


def test_busy_is_http429_unrecorded_then_same_identity_is_accepted_once(client, isolated_admission):
    isolated = isolated_admission
    assert isolated["guard"].acquire_slot() is True
    try:
        _assert_not_admitted(client, isolated, "RATE_LIMITED")
        _assert_not_admitted(client, isolated, "RATE_LIMITED")
        with isolated["db"]() as db:
            assert db.query(DailyUsage).count() == 0
    finally:
        isolated["guard"].release_slot()
    _assert_accepted_once(client, isolated)


def test_daily_limit_is_http429_and_same_identity_waits_for_actual_day_reset(client, isolated_admission):
    isolated = isolated_admission
    denied_day = isolated["days"][0].isoformat()
    with isolated["db"]() as db:
        db.add(DailyUsage(day=denied_day, count=1))
        db.commit()
    _assert_not_admitted(client, isolated, "DAILY_LIMIT")
    _assert_not_admitted(client, isolated, "DAILY_LIMIT")
    with isolated["db"]() as db:
        assert db.query(DailyUsage).one().count == 1
    assert isolated["guard"].acquire_slot() is True  # Rejected admission released its own slot.
    isolated["guard"].release_slot()
    isolated["days"][0] += timedelta(days=1)
    _assert_accepted_once(client, isolated)
    with isolated["db"]() as db:
        assert db.query(DailyUsage).filter_by(day=denied_day).one().count == 1


@pytest.mark.parametrize("error_code", ["RATE_LIMITED", "DAILY_LIMIT"])
def test_post_admission_same_error_code_remains_terminal_sse_failure(client, isolated_admission, error_code):
    isolated = isolated_admission
    isolated["failure"][0] = error_code
    _assert_accepted_once(client, isolated, error_code)
