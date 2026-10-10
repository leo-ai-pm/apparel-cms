"""Request lifecycle persistence is separate from extraction status and text completion."""
import uuid
from copy import deepcopy

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.api.consumer_events import router
from app.core.database import SessionLocal
from app.models.demand import DemandTurn
from app.models.generation import GenerationRequest
from app.services import generation
from app.services import fixed_styling


def accepted():
    request_id, session_id, turn_id = [uuid.uuid4().hex for _ in range(3)]
    with SessionLocal() as db:
        db.add(DemandTurn(id=turn_id, request_id=request_id, session_id=session_id,
                          text="合成隔离需求", status="no_explicit_demand", extractor="rules-v2.1"))
        db.commit()
    return request_id, session_id, turn_id


def test_accept_links_existing_turn_and_is_idempotent():
    request, session, turn = accepted()
    row = generation.accept(request, session)
    assert row["status"] == "accepted" and row["turn_id"] == turn
    assert generation.accept(request, session)["request_id"] == request
    with SessionLocal() as db:
        assert db.query(GenerationRequest).filter_by(request_id=request).count() == 1
    with pytest.raises(HTTPException) as error:
        generation.accept(request, "wrong-session")
    assert error.value.status_code == 404


def test_no_key_failure_is_persisted_without_changing_extraction():
    request, session, turn = accepted()
    generation.accept(request, session)
    assert generation.start(request, session)["status"] == "running"
    row = generation.fail(request, session, "NO_API_KEY")
    assert row["status"] == "failed" and row["error_code"] == "NO_API_KEY"
    assert row["outcome"] is None and row["result"] is None
    with SessionLocal() as db:
        assert db.get(DemandTurn, turn).status == "no_explicit_demand"
    assert generation.fail(request, session, "NO_API_KEY") == row
    with pytest.raises(HTTPException):
        generation.start(request, session)


@pytest.mark.parametrize("outcome", ["clarification", "refusal", "no_match", "recommendation", "action_completed", "action_failed"])
def test_text_completion_has_explicit_non_outfit_outcome(outcome):
    request, session, _ = accepted()
    generation.accept(request, session)
    generation.start(request, session)
    result = {"content": "合成测试回复"}
    row = generation.succeed(request, session, outcome, result)
    assert row["status"] == "succeeded" and row["outcome"] == outcome
    assert row["effective_outfit"] is False
    assert row["result"] == result
    assert generation.succeed(request, session, outcome, result) == row
    with pytest.raises(HTTPException):
        generation.fail(request, session, "INTERNAL")


def test_complete_outfit_needs_persistent_version_not_client_claim():
    request, session, _ = accepted()
    generation.accept(request, session)
    generation.start(request, session)
    with pytest.raises(HTTPException):
        generation.succeed(request, session, "complete_outfit", {"content": "complete"})
    assert generation.lookup(request, session)["status"] == "running"


def test_unknown_or_cross_session_request_has_same_not_found_boundary():
    request, session, _ = accepted()
    generation.accept(request, session)
    for rid, sid in ((request, "wrong-session"), (uuid.uuid4().hex, session)):
        with pytest.raises(HTTPException) as error:
            generation.lookup(rid, sid)
        assert error.value.status_code == 404


def test_old_turn_without_generation_record_is_not_guessed_failed():
    request, session, turn = accepted()
    row = generation.lookup(request, session)
    assert row["recorded"] is False and row["status"] == "not_recorded"
    assert row["turn_id"] == turn and row["outcome"] is None and row["error_code"] is None
    with SessionLocal() as db:
        assert db.get(GenerationRequest, request) is None


def test_startup_interrupts_accepted_and_running_and_preserves_terminals():
    a, sa, _ = accepted()
    b, sb, _ = accepted()
    c, sc, _ = accepted()
    for request, session in ((a, sa), (b, sb), (c, sc)):
        generation.accept(request, session)
    generation.start(a, sa)
    generation.start(c, sc)
    generation.fail(c, sc, "NO_API_KEY")
    generation.interrupted()
    assert generation.lookup(a, sa)["error_code"] == "GENERATION_INTERRUPTED"
    assert generation.lookup(b, sb)["error_code"] == "GENERATION_INTERRUPTED"
    assert generation.lookup(c, sc)["error_code"] == "NO_API_KEY"


def test_generation_query_api_never_exposes_other_session():
    request, session, _ = accepted()
    generation.accept(request, session)
    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)
    path = f"/api/v1/generation-requests/{request}"
    assert client.get(path, params={"session_id": session}).json()["status"] == "accepted"
    assert client.get(path, params={"session_id": "wrong"}).status_code == 404


def canonical_version():
    # Controlled persistent-read fixture only; not evidence of a live model call.
    return {"look_version_id": "lv-1", "look_id": "M1V2-L001",
               "image_url": "/api/v1/outfits/assets/M1V2-L001", "image_sha256": "a" * 64,
               "origin": {"type": "self_generated"}, "acceptance_status": "accepted_by_user",
               "resources": {"inventory_snapshot_id": "synthetic-frozen-1"},
               "inventory_snapshot": {"recorded": True, "inventory_snapshot_id": "synthetic-frozen-1",
                                      "captured_at": "2026-10-10T02:00:00Z",
                                      "valid_until": "2026-10-17T02:00:00Z", "sha256": "b" * 64,
                                      "is_simulated": True},
               "items": {slot: {"sku_id": sku, "price_fen": price} for slot, sku, price in
                         zip(("top", "bottom", "shoes"), ("T101-M", "B101-M", "S101-38"), (10000, 20000, 30000))}}


def test_complete_outfit_snapshot_is_bound_to_canonical_version(monkeypatch):
    # Read-seam fixture, not a real model result; the request row uses actual isolated SQLite.
    request, session, _ = accepted()
    generation.accept(request, session)
    generation.start(request, session)
    version = canonical_version()
    monkeypatch.setattr(fixed_styling, "get_version", lambda sid, vid: deepcopy(version) if sid == session else None)
    wrong = deepcopy(version)
    wrong["items"]["top"]["price_fen"] = 1
    with pytest.raises(HTTPException) as error:
        generation.succeed(request, session, "complete_outfit", {"outfit": wrong})
    assert error.value.status_code == 409
    row = generation.succeed(request, session, "complete_outfit", {"outfit": version})
    assert row["effective_outfit"] is True
    monkeypatch.setattr(fixed_styling, "get_version", lambda *args: None)
    assert generation.succeed(request, session, "complete_outfit", {"outfit": version}) == row


def test_complete_outfit_rejects_different_inventory_snapshot(monkeypatch):
    request, session, _ = accepted()
    generation.accept(request, session)
    generation.start(request, session)
    version = canonical_version()
    monkeypatch.setattr(fixed_styling, "get_version", lambda sid, vid: deepcopy(version))
    supplied = deepcopy(version)
    supplied["inventory_snapshot"]["sha256"] = "c" * 64
    with pytest.raises(HTTPException) as error:
        generation.succeed(request, session, "complete_outfit", {"outfit": supplied})
    assert error.value.status_code == 409
    row = generation.lookup(request, session)
    assert row["status"] == "running" and row["effective_outfit"] is False and row["result"] is None


def test_complete_outfit_cannot_newly_count_unrecorded_inventory_snapshot(monkeypatch):
    request, session, _ = accepted()
    generation.accept(request, session)
    generation.start(request, session)
    version = canonical_version()
    version["inventory_snapshot"] = {"recorded": False, "inventory_snapshot_id": "synthetic-frozen-1",
                                      "captured_at": None, "valid_until": None, "sha256": None,
                                      "is_simulated": True}
    monkeypatch.setattr(fixed_styling, "get_version", lambda sid, vid: deepcopy(version))
    with pytest.raises(HTTPException) as error:
        generation.succeed(request, session, "complete_outfit", {"outfit": version})
    assert error.value.status_code == 409
    row = generation.lookup(request, session)
    assert row["status"] == "running" and row["effective_outfit"] is False and row["result"] is None


def test_failure_code_cannot_contain_raw_provider_or_user_details():
    request, session, _ = accepted()
    generation.accept(request, session)
    with pytest.raises(HTTPException) as error:
        generation.fail(request, session, "private key/user details")
    assert error.value.status_code == 422
