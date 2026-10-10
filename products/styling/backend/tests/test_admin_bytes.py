"""HTTP byte seam checks; every receiver here is a local transport simulation.

The transport receives httpx's constructed Request, so these checks catch JSON
reserialization rather than comparing the Python objects passed to httpx.post.
"""
import hashlib
import json
import uuid

import httpx
import pytest

from app.api import admin
from app.core.database import SessionLocal
from app.models.demand import (
    DemandAdminSession, DemandAudit, DemandHandoff, DemandOccurrence,
    DemandOccurrenceRevision, DemandRequestAdmission, DemandSendAttempt, DemandTurn,
)
from app.services.demand import record_turn


@pytest.fixture(autouse=True)
def isolated_demands(monkeypatch):
    monkeypatch.setenv("STYLING_ADMIN_PASSWORD", "test-manager-password")
    monkeypatch.setenv("STYLING_ADMIN_SECRET", "test-signing-secret-" * 3)
    monkeypatch.setenv("STYLING_ADMIN_COOKIE_SECURE", "0")
    monkeypatch.setenv("STYLING_DEMAND_D3_ENABLED", "0")
    monkeypatch.setenv("STYLING_DEMAND_RECEIVER_URL", "https://receiver.invalid/receive")
    monkeypatch.setenv("STYLING_DEMAND_RECEIVER_KEY", "test-only-transport-key")
    monkeypatch.setenv("STYLING_DEMAND_RECEIVER_RECEIPT_CAPABILITIES", "revision,payload_digest")
    with SessionLocal() as db:
        for model in (DemandSendAttempt, DemandOccurrenceRevision, DemandAdminSession,
                      DemandRequestAdmission, DemandOccurrence, DemandTurn, DemandHandoff, DemandAudit):
            db.query(model).delete()
        db.commit()
    admin._attempts.clear()


def approved_snapshot(client):
    assert record_turn("synthetic-byte-session", uuid.uuid4().hex, "秋天通勤想要宽松阔腿裤")
    assert client.post("/api/v1/admin/login", json={"password": "test-manager-password"}).status_code == 200
    group = client.get("/api/v1/admin/overview").json()["groups"][0]
    evidence = client.get(f'/api/v1/admin/groups/{group["key"]}').json()["evidence"]
    response = client.post(f'/api/v1/admin/groups/{group["key"]}/approve', json={
        "note": "核对中文证据及冻结文件",
        "expected_occurrence_ids": [row["id"] for row in evidence],
        "expected_revisions": {row["id"]: row["revision"] for row in evidence},
    })
    assert response.status_code == 200, response.text
    return response.json()["id"]


def frozen_data(handoff_id):
    with SessionLocal() as db:
        row = db.get(DemandHandoff, handoff_id)
        return row.payload_json.encode("utf-8"), row.metadata_json


@pytest.fixture
def strict_receiver(monkeypatch):
    """Hash the body constructed by real httpx, without performing any network I/O."""
    clients = []

    def connect(receipt_override=None):
        captured = []

        def receive(request):
            body = request.read()
            digest = hashlib.sha256(body).hexdigest()
            payload = json.loads(body)
            captured.append({"body": body, "digest": digest, "headers": dict(request.headers)})
            receipt = {"handoff_id": payload["handoff_id"], "revision": payload["revision"],
                       "status": "received", "payload_digest": digest}
            if receipt_override:
                receipt.update(receipt_override)
            return httpx.Response(200, json=receipt)

        outbound = httpx.Client(transport=httpx.MockTransport(receive))
        clients.append(outbound)
        # Keep the HTTP request builder active; only replace its network boundary.
        monkeypatch.setattr(admin.httpx, "post", outbound.post)
        return captured

    yield connect
    for outbound in clients:
        outbound.close()


def test_export_matches_new_frozen_utf8_bytes_and_metadata_digest(client):
    handoff_id = approved_snapshot(client)
    frozen, metadata_json = frozen_data(handoff_id)
    response = client.get(f"/api/v1/admin/handoffs/{handoff_id}/export")
    assert response.status_code == 200
    assert response.content == frozen
    assert int(response.headers["content-length"]) == len(frozen)
    assert response.headers["content-type"].startswith("application/json")
    assert hashlib.sha256(response.content).hexdigest() == json.loads(metadata_json)["payload_digest"]
    assert frozen_data(handoff_id) == (frozen, metadata_json)


def test_strict_receipt_confirms_same_frozen_export_send_body_and_sha_header(client, strict_receiver):
    handoff_id = approved_snapshot(client)
    frozen, metadata_json = frozen_data(handoff_id)
    captured = strict_receiver()
    response = client.post(f"/api/v1/admin/handoffs/{handoff_id}/send")
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "received"
    assert len(captured) == 1
    sent = captured[0]
    exported = client.get(f"/api/v1/admin/handoffs/{handoff_id}/export")
    assert sent["body"] == exported.content == frozen
    expected_digest = hashlib.sha256(frozen).hexdigest()
    assert sent["digest"] == sent["headers"]["x-handoff-content-sha256"] == expected_digest
    assert json.loads(metadata_json)["payload_digest"] == expected_digest
    assert sent["headers"]["content-type"].startswith("application/json")
    assert sent["headers"]["idempotency-key"] == handoff_id
    assert frozen_data(handoff_id) == (frozen, metadata_json)


@pytest.mark.parametrize("ensure_ascii", [False, True], ids=["unicode-spaced", "escaped-unicode-spaced"])
def test_legacy_schema14_formatted_payload_preserved_on_export_send_and_reexport(client, strict_receiver, ensure_ascii):
    handoff_id = approved_snapshot(client)
    with SessionLocal() as db:
        row = db.get(DemandHandoff, handoff_id)
        legacy = json.loads(row.payload_json)
        assert legacy["schema_version"] == "1.4"
        # Model an existing immutable schema 1.4 row whose original serializer
        # used whitespace/Unicode escaping and predated local snapshot metadata.
        row.payload_json = json.dumps(legacy, ensure_ascii=ensure_ascii, indent=2) + "\n"
        row.metadata_json = "{}"
        db.commit()
    frozen, metadata_json = frozen_data(handoff_id)
    first_export = client.get(f"/api/v1/admin/handoffs/{handoff_id}/export")
    assert first_export.content == frozen
    captured = strict_receiver()
    sent = client.post(f"/api/v1/admin/handoffs/{handoff_id}/send")
    assert sent.status_code == 200, sent.text
    assert sent.json()["status"] == "received"
    assert captured[0]["body"] == frozen
    assert captured[0]["headers"]["x-handoff-content-sha256"] == hashlib.sha256(frozen).hexdigest()
    assert client.get(f"/api/v1/admin/handoffs/{handoff_id}/export").content == frozen
    assert frozen_data(handoff_id) == (frozen, metadata_json)


@pytest.mark.parametrize("override,error_code", [
    ({"payload_digest": "0" * 64}, "receipt_digest_mismatch"),
    ({"revision": 999}, "receipt_revision_mismatch"),
])
def test_raw_body_receiver_wrong_digest_or_revision_is_genuine_failed_attempt(client, strict_receiver, override, error_code):
    handoff_id = approved_snapshot(client)
    frozen, metadata_json = frozen_data(handoff_id)
    captured = strict_receiver({**override, "private_data": "do-not-save-synthetic-partner-data"})
    response = client.post(f"/api/v1/admin/handoffs/{handoff_id}/send")
    assert response.status_code == 502
    assert response.json()["error"]["code"] == "RECEIVER_UNCONFIRMED"
    assert len(captured) == 1
    detail = client.get(f"/api/v1/admin/handoffs/{handoff_id}").json()
    assert detail["status"] == "failed"
    assert detail["received_at"] is None
    assert len(detail["send_attempts"]) == 1
    assert detail["send_attempts"][0]["status"] == "failed"
    assert detail["send_attempts"][0]["error_code"] == error_code
    assert "do-not-save-synthetic-partner-data" not in json.dumps(detail)
    assert frozen_data(handoff_id) == (frozen, metadata_json)
