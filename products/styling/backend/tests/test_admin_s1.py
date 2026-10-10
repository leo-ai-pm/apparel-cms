"""PRD v1.6 S1 contract checks; all business evidence and receivers are simulated."""
import json
import uuid
from datetime import datetime, timedelta

import httpx
import pytest

from app.api import admin
from app.core.database import SessionLocal
from app.models.demand import (DemandAdminSession, DemandAudit, DemandHandoff, DemandOccurrence,
                               DemandOccurrenceRevision, DemandSendAttempt, DemandTurn)
from app.services.demand import record_turn


@pytest.fixture(autouse=True)
def clean_s1(monkeypatch):
    monkeypatch.setenv("STYLING_ADMIN_PASSWORD", "test-manager-password")
    monkeypatch.setenv("STYLING_ADMIN_SECRET", "test-signing-secret-" * 3)
    monkeypatch.setenv("STYLING_ADMIN_COOKIE_SECURE", "0")
    for key in ("STYLING_DEMAND_RECEIVER_URL", "STYLING_DEMAND_RECEIVER_KEY", "STYLING_DEMAND_D3_ENABLED",
                "STYLING_DEMAND_RECEIVER_RECEIPT_CAPABILITIES"):
        monkeypatch.delenv(key, raising=False)
    with SessionLocal() as db:
        for model in (DemandOccurrenceRevision, DemandSendAttempt, DemandOccurrence, DemandTurn,
                      DemandHandoff, DemandAudit, DemandAdminSession):
            db.query(model).delete()
        db.commit()
    admin._attempts.clear()


def login(client):
    assert client.post("/api/v1/admin/login", json={"password": "test-manager-password"}).status_code == 200


def sample(text="秋天通勤想要宽松阔腿裤", session_id="session-1"):
    request_id = uuid.uuid4().hex
    assert record_turn(session_id, request_id, text)
    with SessionLocal() as db:
        return db.query(DemandTurn).filter_by(request_id=request_id).one().id


def approve(client):
    sample()
    login(client)
    group = client.get("/api/v1/admin/overview").json()["groups"][0]
    rows = client.get(f'/api/v1/admin/groups/{group["key"]}').json()["evidence"]
    body = {"note": "已核对来源", "expected_occurrence_ids": [r["id"] for r in rows],
            "expected_revisions": {r["id"]: r["revision"] for r in rows}}
    response = client.post(f'/api/v1/admin/groups/{group["key"]}/approve', json=body)
    assert response.status_code == 200, response.text
    return response.json(), group, body


def receiver(monkeypatch, receipt):
    monkeypatch.setenv("STYLING_DEMAND_RECEIVER_URL", "https://partner.example/v1/demand")
    monkeypatch.setenv("STYLING_DEMAND_RECEIVER_KEY", "test-only-key")
    calls = []
    def post(endpoint, **kwargs):
        calls.append(kwargs)
        value = receipt(kwargs) if callable(receipt) else receipt
        if isinstance(value, Exception):
            raise value
        return httpx.Response(200, json=value, request=httpx.Request("POST", endpoint))
    monkeypatch.setattr(admin.httpx, "post", post)
    return calls


@pytest.mark.parametrize("endpoint", ["https://partner.example:bad/v1", "https://partner.example:70000/v1"])
def test_invalid_receiver_port_never_claims_attempt(client, monkeypatch, endpoint):
    handoff, _, _ = approve(client)
    monkeypatch.setenv("STYLING_DEMAND_RECEIVER_URL", endpoint)
    monkeypatch.setenv("STYLING_DEMAND_RECEIVER_KEY", "test-only-key")
    def forbidden(*args, **kwargs):
        raise AssertionError("invalid configuration must never send")
    monkeypatch.setattr(admin.httpx, "post", forbidden)
    response = client.post(f'/api/v1/admin/handoffs/{handoff["id"]}/send')
    assert response.status_code == 503
    with SessionLocal() as db:
        assert db.get(DemandHandoff, handoff["id"]).status == "approved"
        assert db.query(DemandSendAttempt).count() == 0


def test_httpx_invalid_url_records_failed_attempt(client, monkeypatch):
    handoff, _, _ = approve(client)
    receiver(monkeypatch, httpx.InvalidURL("synthetic invalid URL"))
    assert client.post(f'/api/v1/admin/handoffs/{handoff["id"]}/send').status_code == 502
    detail = client.get(f'/api/v1/admin/handoffs/{handoff["id"]}').json()
    assert detail["status"] == "failed"
    assert detail["send_attempts"][0]["error_code"] == "receiver_invalid_url"


def test_manager_queries_auth_scope_and_missing_objects(client):
    for route in ("turns", "turns/missing", "handoffs", "handoffs/missing", "audit"):
        assert client.get(f"/api/v1/admin/{route}").status_code == 401
    login(client)
    for route in ("turns", "handoffs", "audit", "overview"):
        assert client.get(f"/api/v1/admin/{route}?workspace_id=another-space").status_code == 403
    assert client.get("/api/v1/admin/turns/missing").status_code == 404
    assert client.get("/api/v1/admin/handoffs/missing").status_code == 404
    assert client.get("/api/v1/admin/groups/missing").status_code == 404


def test_turns_paginate_filter_and_retain_no_demand(client):
    sample(); no_demand = sample("谢谢，展示图片")
    negative = sample("不要紧身裤")
    login(client)
    listing = client.get("/api/v1/admin/turns?page=1&page_size=1").json()
    assert listing["total"] == 3 and len(listing["items"]) == 1
    assert client.get("/api/v1/admin/turns?page=2&page_size=1").json()["items"][0]["id"] != listing["items"][0]["id"]
    rows = client.get("/api/v1/admin/turns?status=no_explicit_demand").json()
    assert rows["total"] == 1 and rows["items"][0]["id"] == no_demand
    detail = client.get(f"/api/v1/admin/turns/{negative}").json()
    assert detail["negative_preferences"] and detail["occurrences"] == []
    assert client.get("/api/v1/admin/turns?page_size=101").status_code == 422


def test_context_turn_and_field_sources_are_visible(client):
    first = sample()
    second = sample("再宽松一点")
    login(client)
    detail = client.get(f"/api/v1/admin/turns/{second}").json()
    occurrence = detail["occurrences"][0]
    assert occurrence["context_turn_ids"] == [first]
    assert occurrence["field_sources"]["fit"] == [second]
    assert occurrence["field_sources"]["category"] == [first]
    assert detail["context_turns"][0]["id"] == first


def test_utc_window_is_half_open_reproducible_and_category_filtered(client):
    inside = sample()
    outside = sample("想要运动鞋", "shoes")
    boundary = sample("想要阔腿裤", "boundary")
    start = datetime(2026, 10, 1)
    end = datetime(2026, 10, 8)
    with SessionLocal() as db:
        db.get(DemandTurn, inside).created_at = start
        db.get(DemandTurn, outside).created_at = start - timedelta(microseconds=1)
        db.get(DemandTurn, boundary).created_at = end
        db.commit()
    login(client)
    query = "window_start=2026-10-01T00:00:00Z&window_end=2026-10-08T00:00:00Z"
    data = client.get(f"/api/v1/admin/overview?{query}&category=裤子&status=pending").json()
    assert data["counts"]["turns"] == data["counts"]["occurrences"] == 1
    assert data["window_start"] == "2026-10-01T00:00:00Z"
    assert data["window_end"] == "2026-10-08T00:00:00Z"
    assert client.get("/api/v1/admin/overview?window_start=2026-10-01T00:00:00Z").status_code == 422
    assert client.get("/api/v1/admin/overview?window_start=2026-10-01T00:00:00&window_end=2026-10-08T00:00:00").status_code == 422
    assert client.get("/api/v1/admin/overview?status=unknown").status_code == 422


def test_approval_revisions_frozen_metadata_and_wire_compatibility(client):
    handoff, group, body = approve(client)
    url = f'/api/v1/admin/groups/{group["key"]}/approve'
    assert client.post(url, json=body).json()["id"] == handoff["id"]
    wrong = {**body, "expected_revisions": {key: 99 for key in body["expected_revisions"]}}
    assert client.post(url, json=wrong).status_code == 409
    detail = client.get(f'/api/v1/admin/handoffs/{handoff["id"]}').json()
    assert detail["metadata"]["approved_by"] == "styling-manager"
    assert detail["metadata"]["evidence_revisions"] == body["expected_revisions"]
    assert detail["metadata"]["payload_digest"]
    assert detail["payload"]["schema_version"] == "1.4"
    assert "metadata" not in detail["payload"] and "field_sources" not in detail["payload"]["evidence"][0]
    original = detail["payload"]
    sample(session_id="new-session")
    assert client.get(f'/api/v1/admin/handoffs/{handoff["id"]}').json()["payload"] == original
    assert client.post(url, json=body).status_code == 409


def test_missing_or_foreign_context_blocks_approval(client):
    first = sample()
    second = sample("再宽松一点")
    sample(session_id="another-session")
    login(client)
    group = client.get("/api/v1/admin/overview").json()["groups"][0]
    rows = client.get(f'/api/v1/admin/groups/{group["key"]}').json()["evidence"]
    body = {"note": "已核对来源", "expected_occurrence_ids": [r["id"] for r in rows]}
    with SessionLocal() as db:
        occurrence = db.query(DemandOccurrence).filter_by(turn_id=second).one()
        occurrence.context_turn_ids_json = json.dumps(["nonexistent-source"])
        db.commit()
    assert client.post(f'/api/v1/admin/groups/{group["key"]}/approve', json=body).status_code == 409


def test_export_records_fact_without_receiving(client):
    handoff, _, _ = approve(client)
    data = client.get(f'/api/v1/admin/handoffs/{handoff["id"]}/export')
    assert data.status_code == 200 and data.json()["schema_version"] == "1.4"
    audit = client.get(f'/api/v1/admin/audit?action=export&target_id={handoff["id"]}').json()
    assert audit["total"] == 1
    assert client.get(f'/api/v1/admin/handoffs/{handoff["id"]}').json()["status"] == "approved"


def test_reject_revision_cas_history_and_restore_gated(client, monkeypatch):
    handoff, _, body = approve(client)
    occurrence_id = body["expected_occurrence_ids"][0]
    url = f"/api/v1/admin/occurrences/{occurrence_id}"
    assert client.post(url + "/reject", json={"note": "误提炼", "expected_revision": 99}).status_code == 409
    assert client.post(url + "/reject", json={"note": "误提炼", "expected_revision": 1}).json()["revision"] == 2
    assert client.get(f'/api/v1/admin/handoffs/{handoff["id"]}').json()["needs_review"] is True
    assert client.post(url + "/restore", json={"note": "重新核对", "expected_revision": 2}).status_code == 409
    monkeypatch.setenv("STYLING_DEMAND_D3_ENABLED", "1")
    restored = client.post(url + "/restore", json={"note": "重新核对", "expected_revision": 2})
    assert restored.status_code == 200 and restored.json()["revision"] == 3
    assert client.get("/api/v1/admin/overview").json()["counts"]["occurrences"] == 1
    assert client.get(f'/api/v1/admin/handoffs/{handoff["id"]}').json()["needs_review"] is True
    with SessionLocal() as db:
        assert [r.revision for r in db.query(DemandOccurrenceRevision).order_by(DemandOccurrenceRevision.revision)] == [1, 2, 3]


def test_send_attempts_errors_retry_same_id_and_revision(client, monkeypatch):
    handoff, _, _ = approve(client)
    url = f'/api/v1/admin/handoffs/{handoff["id"]}/send'
    assert client.post(url).status_code == 503
    receipts = iter([
        {"handoff_id": handoff["id"], "status": "received", "revision": 99},
        {"handoff_id": handoff["id"], "status": "received", "revision": 1},
    ])
    calls = receiver(monkeypatch, lambda _: next(receipts))
    assert client.post(url).status_code == 502
    assert client.post(url).json()["status"] == "received"
    assert client.post(url).json()["status"] == "received"
    assert len(calls) == 2
    assert {call["headers"]["Idempotency-Key"] for call in calls} == {handoff["id"]}
    attempts = client.get(f'/api/v1/admin/handoffs/{handoff["id"]}').json()["send_attempts"]
    assert len({a["id"] for a in attempts}) == 2
    assert [a["error_code"] for a in attempts] == ["receipt_revision_mismatch", ""]
    assert all(a["finished_at"] and a["attempted_at"] for a in attempts)


def test_extended_receipts_only_when_declared_and_scrub_partner_fields(client, monkeypatch):
    handoff, _, _ = approve(client)
    url = f'/api/v1/admin/handoffs/{handoff["id"]}/send'
    receiver(monkeypatch, {"handoff_id": handoff["id"], "status": "received", "private_data": "never persist"})
    monkeypatch.setenv("STYLING_DEMAND_RECEIVER_RECEIPT_CAPABILITIES", "revision")
    assert client.post(url).status_code == 502
    monkeypatch.delenv("STYLING_DEMAND_RECEIVER_RECEIPT_CAPABILITIES")
    assert client.post(url).json()["status"] == "received"
    detail = client.get(f'/api/v1/admin/handoffs/{handoff["id"]}').json()
    assert "never persist" not in json.dumps(detail)
    assert detail["send_attempts"][0]["error_code"] == "receipt_revision_missing"


def test_received_stays_received_after_evidence_exclusion(client, monkeypatch):
    handoff, _, body = approve(client)
    calls = receiver(monkeypatch, {"handoff_id": handoff["id"], "status": "received"})
    url = f'/api/v1/admin/handoffs/{handoff["id"]}/send'
    assert client.post(url).json()["status"] == "received"
    assert client.post(f'/api/v1/admin/occurrences/{body["expected_occurrence_ids"][0]}/reject', json={"note": "证据不成立"}).status_code == 200
    result = client.post(url).json()
    assert result["status"] == "received" and result["needs_review"] is True
    assert len(calls) == 1


def test_newer_approval_does_not_invalidate_old_frozen_version(client, monkeypatch):
    handoff, group, _ = approve(client)
    sample(session_id="new-session")
    rows = client.get(f'/api/v1/admin/groups/{group["key"]}').json()["evidence"]
    assert client.post(f'/api/v1/admin/groups/{group["key"]}/approve', json={"note": "第二版本核对",
        "expected_occurrence_ids": [r["id"] for r in rows]}).status_code == 200
    receiver(monkeypatch, {"handoff_id": handoff["id"], "status": "received"})
    assert client.post(f'/api/v1/admin/handoffs/{handoff["id"]}/send').json()["status"] == "received"


def test_tampered_frozen_payload_is_blocked(client, monkeypatch):
    handoff, _, _ = approve(client)
    with SessionLocal() as db:
        row = db.get(DemandHandoff, handoff["id"])
        payload = json.loads(row.payload_json)
        payload["demand"]["description"] = "tampered"
        row.payload_json = json.dumps(payload)
        db.commit()
    calls = receiver(monkeypatch, {"handoff_id": handoff["id"], "status": "received"})
    assert client.post(f'/api/v1/admin/handoffs/{handoff["id"]}/send').status_code == 409
    assert not calls


def test_late_matching_success_confirms_object_without_overwriting_new_attempt(client, monkeypatch):
    handoff, _, _ = approve(client)
    def later_attempt(_):
        with SessionLocal() as db:
            previous = db.query(DemandSendAttempt).filter_by(handoff_id=handoff["id"]).one()
            db.add(DemandSendAttempt(id="new-owner", handoff_id=handoff["id"], attempted_at=previous.attempted_at + timedelta(seconds=1)))
            db.commit()
        return {"handoff_id": handoff["id"], "status": "received"}
    receiver(monkeypatch, later_attempt)
    result = client.post(f'/api/v1/admin/handoffs/{handoff["id"]}/send').json()
    assert result["status"] == "received"
    with SessionLocal() as db:
        assert db.get(DemandSendAttempt, "new-owner").status == "sending"
        assert db.query(DemandSendAttempt).filter_by(handoff_id=handoff["id"], status="received").count() == 1


def test_late_failure_cannot_overwrite_newer_confirmed_receipt(client, monkeypatch):
    handoff, _, _ = approve(client)
    def later_attempt(_):
        with SessionLocal() as db:
            previous = db.query(DemandSendAttempt).filter_by(handoff_id=handoff["id"]).one()
            db.add(DemandSendAttempt(id="new-owner", handoff_id=handoff["id"], status="received",
                                    attempted_at=previous.attempted_at + timedelta(seconds=1)))
            db.get(DemandHandoff, handoff["id"]).status = "received"
            db.commit()
        return {"handoff_id": "wrong", "status": "received"}
    receiver(monkeypatch, later_attempt)
    assert client.post(f'/api/v1/admin/handoffs/{handoff["id"]}/send').status_code == 502
    assert client.get(f'/api/v1/admin/handoffs/{handoff["id"]}').json()["status"] == "received"


def test_recent_inflight_attempt_blocks_duplicate_network_call(client, monkeypatch):
    handoff, _, _ = approve(client)
    with SessionLocal() as db:
        db.add(DemandSendAttempt(id="in-flight", handoff_id=handoff["id"]))
        db.get(DemandHandoff, handoff["id"]).status = "sending"
        db.commit()
    calls = receiver(monkeypatch, {"handoff_id": handoff["id"], "status": "received"})
    detail = client.get(f'/api/v1/admin/handoffs/{handoff["id"]}').json()
    assert detail["send_eligible"] is False and detail["send_in_progress"] is True
    assert 0 < detail["retry_after_seconds"] <= 60
    assert client.post(f'/api/v1/admin/handoffs/{handoff["id"]}/send').status_code == 409
    assert not calls


def test_malformed_source_shape_is_conflict_not_server_error(client):
    turn = sample()
    login(client)
    with SessionLocal() as db:
        row = db.query(DemandOccurrence).filter_by(turn_id=turn).one()
        occurrence_id, key = row.id, row.group_key
        row.field_sources_json = json.dumps(["wrong-shape"])
        db.commit()
    response = client.post(f"/api/v1/admin/groups/{key}/approve", json={"note": "核对数据格式", "expected_occurrence_ids": [occurrence_id]})
    assert response.status_code == 409
