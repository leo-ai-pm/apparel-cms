"""Fixed JSON route ledger integration; controlled offline parser, never live-model evidence."""
import uuid

import pytest

from app.core.database import SessionLocal
from app.models.demand import DemandRequestAdmission, DemandTurn
from app.models.generation import GenerationRequest
from app.services import fixed_styling as fixed
from app.services import fixed_execution
from tests.test_fixed_styling import OfflineParser, ROOT, turn_body


@pytest.fixture
def fixed_json(monkeypatch, tmp_path, client):
    monkeypatch.setenv("STYLING_FIXED_ENABLED", "1")
    monkeypatch.setenv("STYLING_FIXED_ROOT", str(ROOT))
    monkeypatch.setenv("STYLING_FIXED_DB", str(tmp_path / "json-execution.sqlite3"))
    monkeypatch.setenv("STYLING_FIXED_MODEL_CALL_LIMIT", "12")
    parser = OfflineParser()
    monkeypatch.setattr(fixed, "_make_model", lambda: parser)
    fixed.close_service()
    response = client.post("/api/v1/outfits/sessions", json={})
    assert response.status_code == 200
    view = response.json()
    yield client, parser, view
    fixed.close_service()


def body_for(view):
    return turn_body(view, "json-" + uuid.uuid4().hex)


def test_json_turn_records_formal_acceptance_and_success(fixed_json):
    client, parser, view = fixed_json
    body = body_for(view)
    result = client.post(f"/api/v1/outfits/sessions/{view['session_id']}/turns", json=body)
    assert result.status_code == 200
    assert result.json()["outcome"] == "complete_outfit"
    query = client.get(f"/api/v1/generation-requests/{body['request_id']}", params={"session_id": view["session_id"]})
    assert query.status_code == 200
    assert query.json()["status"] == "succeeded"
    assert query.json()["effective_outfit"] is True
    assert query.json()["result"] == result.json()
    with SessionLocal() as db:
        assert db.get(DemandRequestAdmission, body["request_id"]) is not None
        row = db.query(DemandTurn).filter_by(request_id=body["request_id"]).one()
        assert row.session_id == view["session_id"]
        assert db.get(GenerationRequest, body["request_id"]).turn_id == row.id
    assert parser.calls == 1 and fixed.health()["model_http_attempts"] == 0


def test_same_json_body_replays_terminal_without_model_or_new_turn(fixed_json):
    client, parser, view = fixed_json
    body = body_for(view)
    path = f"/api/v1/outfits/sessions/{view['session_id']}/turns"
    first, second = client.post(path, json=body), client.post(path, json=body)
    assert first.status_code == second.status_code == 200
    assert first.json() == second.json()
    assert parser.calls == 1
    with SessionLocal() as db:
        assert db.query(DemandTurn).filter_by(request_id=body["request_id"]).count() == 1
        assert db.query(GenerationRequest).filter_by(request_id=body["request_id"]).count() == 1


def test_same_json_id_different_body_conflicts_before_second_model(fixed_json):
    client, parser, view = fixed_json
    body = body_for(view)
    path = f"/api/v1/outfits/sessions/{view['session_id']}/turns"
    first = client.post(path, json=body)
    assert first.status_code == 200
    second = client.post(path, json={**body, "user_utterance": "合成另一个表达，预算改变"})
    assert second.status_code == 409
    assert second.json()["error"]["code"] == "IDEMPOTENCY_CONFLICT"
    assert parser.calls == 1
    with SessionLocal() as db:
        assert db.get(GenerationRequest, body["request_id"]).status == "succeeded"
        assert db.query(DemandTurn).filter_by(request_id=body["request_id"]).count() == 1


def test_failed_json_id_is_persisted_and_never_reexecutes(fixed_json, monkeypatch):
    client, parser, view = fixed_json
    body = body_for(view)
    path = f"/api/v1/outfits/sessions/{view['session_id']}/turns"

    def fail_parse(*args, **kwargs):
        from m2.core import Fault
        parser.calls += 1
        raise Fault("MODEL_UNAVAILABLE", "离线注入：模型不可用")

    monkeypatch.setattr(parser, "parse", fail_parse)
    first, second = client.post(path, json=body), client.post(path, json=body)
    assert first.status_code == second.status_code == 503
    assert first.json()["error"]["code"] == second.json()["error"]["code"] == "MODEL_UNAVAILABLE"
    assert parser.calls == 1
    record = client.get(f"/api/v1/generation-requests/{body['request_id']}", params={"session_id": view["session_id"]})
    assert record.json()["status"] == "failed"
    assert record.json()["error_code"] == "MODEL_UNAVAILABLE"
    assert record.json()["effective_outfit"] is False and record.json()["result"] is None
    assert fixed.session_view(view["session_id"])["history"] == []
    with SessionLocal() as db:
        assert db.query(DemandTurn).filter_by(request_id=body["request_id"]).count() == 1


def test_missing_fixed_session_does_not_admit_or_call_model(fixed_json):
    client, parser, view = fixed_json
    body = body_for(view)
    result = client.post(f"/api/v1/outfits/sessions/missing-{uuid.uuid4().hex}/turns", json=body)
    assert result.status_code == 404
    assert parser.calls == 0
    with SessionLocal() as db:
        assert db.get(DemandRequestAdmission, body["request_id"]) is None
        assert db.get(GenerationRequest, body["request_id"]) is None


@pytest.mark.parametrize("context", [{}, {"look_version_id": ""}, {"look_version_id": True},
                                    {"look_version_id": None, "draft": "private text"}, "invalid"])
def test_invalid_view_context_is_rejected_before_formal_admission(fixed_json, context):
    client, parser, view = fixed_json
    body = {**body_for(view), "view_context": context}
    response = client.post(f"/api/v1/outfits/sessions/{view['session_id']}/turns", json=body)
    assert response.status_code == 422
    assert parser.calls == 0
    with SessionLocal() as db:
        assert db.get(DemandRequestAdmission, body["request_id"]) is None
        assert db.get(GenerationRequest, body["request_id"]) is None


def test_unclaimed_extraction_does_not_execute_model(fixed_json, monkeypatch):
    client, parser, view = fixed_json
    monkeypatch.setattr(fixed_execution, "process_admitted_turn", lambda request: False)
    body = body_for(view)
    response = client.post(f"/api/v1/outfits/sessions/{view['session_id']}/turns", json=body)
    assert response.status_code in (409, 422, 503)
    assert parser.calls == 0
    with SessionLocal() as db:
        row = db.get(GenerationRequest, body["request_id"])
        assert row.status == "failed"
        assert row.result_json == "null"
