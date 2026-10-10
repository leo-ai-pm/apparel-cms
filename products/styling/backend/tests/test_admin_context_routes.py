"""SAC HTTP routes against fresh per-test databases and real signed cookies.

Only the styling application is used.  No running service, old database,
external receiver or paid model is contacted.  Context values stay in memory.
"""
import hashlib
import importlib
import json
import re
import sys
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from threading import Barrier

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from app.core import database
from app.core.admin_auth import COOKIE
from app.main import app
from app.models.chat import Base
from app.models.demand import (
    DemandAdminSession, DemandAudit, DemandHandoff, DemandOccurrence,
    DemandOccurrenceRevision, DemandSendAttempt, DemandTurn,
)
from app.models.styling_account import StylingAccountSession
from app.models.styling_delivery import StylingDirectAction, StylingDirectDelivery
from app.models.tryon import utcnow


PASSWORD = "isolated-sac-test-password"
ACTION_CONTRACT = "styling_admin_action_v1"
CONTEXT_CONTRACT = "styling_admin_context_v1"
META_FIELDS = {
    "operation_contract", "request_id", "actor_subject", "operation_kind",
    "context_binding", "operation_context_ref", "body_digest", "state",
    "outcome", "accepted_at", "completed_at", "result_ref",
}


@pytest.fixture
def sac(monkeypatch, tmp_path):
    """Do not rely on or reset the session-wide conftest database."""
    for module_name in (
        "app.api.admin", "app.api.styling_direct", "app.services.demand",
        "app.services.styling_evidence", "app.services.styling_delivery",
        "app.services.admin_context", "app.models.admin_context",
    ):
        importlib.import_module(module_name)
    old_factory, old_engine = database.SessionLocal, database.engine
    db_path = tmp_path / "sac-only.db"
    assert not db_path.exists()
    engine = create_engine(f"sqlite:///{db_path}", connect_args={"check_same_thread": False})
    factory = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    # Existing imported modules can retain direct aliases to the original maker.
    for name, module in list(sys.modules.items()):
        if name.startswith("app.") and module is not None:
            if getattr(module, "SessionLocal", None) is old_factory:
                monkeypatch.setattr(module, "SessionLocal", factory)
            if getattr(module, "engine", None) is old_engine:
                monkeypatch.setattr(module, "engine", engine)
    for key, value in {
        "STYLING_ADMIN_CONTEXT_ENABLED": "1", "STYLING_ADMIN_ENABLED": "1",
        "STYLING_ADMIN_PASSWORD": PASSWORD,
        "STYLING_ADMIN_SECRET": "isolated-sac-signing-secret-" * 3,
        "STYLING_ADMIN_COOKIE_SECURE": "0",
        "STYLING_ADMIN_SUBJECT": "sac-manager-A",
        "STYLING_ADMIN_SCOPE": "sac-isolated-scope",
        "STYLING_DIRECT_INSTANCE_ID": "sac-isolated-source",
        "STYLING_DIRECT_ENABLED": "1", "STYLING_DEMAND_D3_ENABLED": "0",
        "STYLING_ADMIN_PUBLIC_ORIGIN": "",
        "CMS_BASE_URL": "", "CMS_API_KEY": "",
    }.items():
        monkeypatch.setenv(key, value)
    private = tmp_path / "direct-private.json"
    private.write_text(json.dumps({"verifiers": [], "targets": []}))
    private.chmod(0o600)
    monkeypatch.setenv("STYLING_DIRECT_AUTH_FILE", str(private))
    Base.metadata.create_all(engine)
    with TestClient(app) as client:
        yield {"client": client, "factory": factory, "engine": engine,
               "monkeypatch": monkeypatch}
    engine.dispose()


def login(sac):
    client = sac["client"]
    client.cookies.clear()
    response = client.post("/api/v1/admin/login", json={"password": PASSWORD})
    assert response.status_code == 200
    cookie = client.cookies.get(COOKIE)
    me_response = client.get("/api/v1/admin/me")
    assert me_response.status_code == 200
    return cookie, me_response.json()


def cookie_as(sac, value):
    sac["client"].cookies.clear()
    sac["client"].cookies.set(COOKIE, value)


def action(me, **business):
    context = me["authorization_context"]
    return {"admin_action_contract": ACTION_CONTRACT, "request_id": str(uuid.uuid4()),
            "expected_admin_context": {"context_contract": CONTEXT_CONTRACT,
                                       "context_id": context["context_id"]}, **business}


def assert_error(response, status, code):
    # No private response/context values may enter a failure log.
    assert response.status_code == status
    payload = response.json()
    assert set(payload) == {"error"}
    assert set(payload["error"]) == {"code", "message", "retryable"}
    assert payload["error"]["code"] == code
    assert type(payload["error"]["retryable"]) is bool
    assert response.headers.get("cache-control") == "no-store"


def business_snapshot(sac):
    """All non-auth tables, canonical safe hashes; no raw body output."""
    excluded = {"demand_admin_sessions", "styling_admin_account_sessions",
                "styling_admin_authorization_contexts", "styling_admin_authorization_generations"}
    with sac["engine"].connect() as conn:
        result = {}
        for table in Base.metadata.sorted_tables:
            if table.name in excluded or table.name.startswith("styling_admin_context"):
                continue
            rows = [tuple(str(value) for value in row) for row in conn.execute(select(table))]
            digest = hashlib.sha256(json.dumps(sorted(rows), ensure_ascii=False).encode()).hexdigest()
            result[table.name] = (len(rows), digest)
        return result


def new_demand(sac, *, failed=False):
    from app.services.demand import record_turn
    request_id = str(uuid.uuid4())
    assert record_turn("sac-synthetic-" + uuid.uuid4().hex, request_id, "希望秋季通勤穿宽松长裤")
    with sac["factory"]() as db:
        turn = db.query(DemandTurn).filter_by(request_id=request_id).one()
        occurrence = db.query(DemandOccurrence).filter_by(turn_id=turn.id).one()
        if failed:
            turn.status = "failed"
            turn.error_code = "TECHNICAL_FIXTURE"
            db.commit()
        return turn.id, occurrence.id, occurrence.group_key


def approve(sac, me, key):
    client = sac["client"]
    base = client.get(f"/api/v1/admin/groups/{key}/approval-set")
    assert base.status_code == 200
    baseline = base.json()
    body = action(me, note="合成技术验收，不代表真实企业审批", days=7,
                  expected_occurrence_ids=baseline["expected_occurrence_ids"],
                  expected_revisions=baseline["expected_revisions"],
                  expected_evidence_digest=baseline["evidence_digest"],
                  window_start=baseline["window_start"], window_end=baseline["window_end"])
    response = client.post(f"/api/v1/admin/groups/{key}/approve", json=body)
    assert response.status_code == 200, response.text
    return response, body


def test_me_is_strict_stable_private_and_does_not_extend_session(sac):
    client = sac["client"]
    before_auth = client.get("/api/v1/admin/me")
    assert_error(before_auth, 401, "ADMIN_AUTH_REQUIRED")
    cookie, me = login(sac)
    expected_fields = {"identity_contract", "subject", "role", "audience", "scope",
                       "source_instance_id", "auth_method", "approval_identity_kind",
                       "expires_at", "authorization_context"}
    assert set(me) == expected_fields
    assert me["identity_contract"] == "styling_admin_identity_v1"
    assert me["subject"] == "sac-manager-A"
    assert me["role"] == "styling-manager"
    assert me["audience"] == "personal_styling"
    context = me["authorization_context"]
    assert set(context) == {"context_contract", "context_id", "expires_at"}
    assert context["context_contract"] == CONTEXT_CONTRACT
    assert re.fullmatch(r"[A-Za-z0-9_-]{43}", context["context_id"])
    assert context["expires_at"] == me["expires_at"]
    assert me["expires_at"].endswith("Z")
    response = client.get("/api/v1/admin/me")
    assert response.headers["cache-control"] == "no-store"
    assert hashlib.sha256(response.content).hexdigest() == hashlib.sha256(
        json.dumps(me, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()
    forbidden_keys = {"session_id", "password", "token", "cookie"}
    assert not forbidden_keys.intersection(me)
    assert not forbidden_keys.intersection(context)
    client.cookies.clear()
    assert_error(client.get("/api/v1/admin/me", headers={"X-Admin-Context": context["context_id"]}),
                 401, "ADMIN_AUTH_REQUIRED")
    cookie_as(sac, cookie)
    assert client.get("/api/v1/admin/me").status_code == 200


@pytest.mark.parametrize("path,business", [
    ("/groups/not-existing/approve", {"note": "技术批准说明", "days": 7}),
    ("/occurrences/not-existing/reject", {"note": "技术排除说明"}),
    ("/turns/not-existing/retry", {}), ("/logout", {}),
    ("/handoffs/not-existing/evidence-export", {"expected_revision": 1}),
    ("/handoffs/not-existing/direct-send", {"expected_revision": 1, "include_supplement": True}),
    ("/handoffs/not-existing/direct-reconcile", {"expected_revision": 1}),
    ("/handoffs/not-existing/direct-supplement", {"expected_revision": 1}),
])
def test_every_open_mutation_rejects_silently_switched_cookie_before_business(sac, path, business):
    cookie1, me1 = login(sac)
    cookie2, me2 = login(sac)
    assert cookie1 != cookie2
    assert hashlib.sha256(me1["authorization_context"]["context_id"].encode()).hexdigest() != hashlib.sha256(
        me2["authorization_context"]["context_id"].encode()).hexdigest()
    before = business_snapshot(sac)
    response = sac["client"].post("/api/v1/admin" + path, json=action(me1, **business))
    assert_error(response, 409, "ADMIN_AUTH_CONTEXT_CHANGED")
    assert business_snapshot(sac) == before
    # An old logout intent must not revoke the new valid session.
    assert sac["client"].get("/api/v1/admin/me").status_code == 200


@pytest.mark.parametrize("case,expected_code", [
    ("missing_context", "ADMIN_CONTEXT_REQUIRED"),
    ("bad_contract", "ADMIN_CONTEXT_INVALID"),
    ("context_extra", "ADMIN_CONTEXT_INVALID"),
    ("bad_id", "ADMIN_ACTION_INVALID"),
    ("extra", "ADMIN_ACTION_INVALID"),
    ("bool_revision", "ADMIN_ACTION_INVALID"),
])
def test_new_mutation_strict_schema_never_downgrades(sac, case, expected_code):
    _, me = login(sac)
    body = action(me, note="技术排除说明", expected_revision=1)
    if case == "missing_context":
        body.pop("expected_admin_context")
    elif case == "bad_contract":
        body["expected_admin_context"]["context_contract"] = "styling_admin_context_old"
    elif case == "context_extra":
        body["expected_admin_context"]["actor_subject"] = "forged-subject"
    elif case == "bad_id":
        body["request_id"] = uuid.uuid4().hex
    elif case == "extra":
        body["actor_subject"] = "forged-subject"
    else:
        body["expected_revision"] = True
    before = business_snapshot(sac)
    response = sac["client"].post("/api/v1/admin/occurrences/missing/reject", json=body)
    assert_error(response, 422, expected_code)
    assert business_snapshot(sac) == before


def test_duplicate_json_keys_are_rejected_before_action_registration(sac):
    _, me = login(sac)
    body = action(me)
    raw = json.dumps(body)[:-1] + ',"request_id":"' + str(uuid.uuid4()) + '"}'
    before = business_snapshot(sac)
    response = sac["client"].post("/api/v1/admin/logout", content=raw,
                                  headers={"Content-Type": "application/json"})
    assert_error(response, 422, "ADMIN_ACTION_INVALID")
    assert business_snapshot(sac) == before
    assert sac["client"].get("/api/v1/admin/me").status_code == 200


def test_logout_commits_once_and_old_cookie_cannot_replay_but_new_session_reads_metadata(sac):
    cookie1, me1 = login(sac)
    body = action(me1)
    response = sac["client"].post("/api/v1/admin/logout", json=body)
    assert response.status_code == 200
    assert response.json()["status"] == "logged_out"
    assert response.headers["x-styling-admin-action-contract"] == ACTION_CONTRACT
    assert response.headers["x-styling-admin-request-id"] == body["request_id"]
    cookie_as(sac, cookie1)
    assert_error(sac["client"].post("/api/v1/admin/logout", json=body), 401, "ADMIN_SESSION_REVOKED")
    _, me2 = login(sac)
    before = business_snapshot(sac)
    metadata = sac["client"].get("/api/v1/admin/operations/" + body["request_id"])
    assert metadata.status_code == 200
    value = metadata.json()
    assert set(value) == META_FIELDS
    assert value["state"] == "completed" and value["outcome"] == "completed"
    assert value["operation_kind"] == "logout" and value["result_ref"] is None
    assert value["context_binding"] == "bound"
    assert re.fullmatch(r"[a-f0-9]{64}", value["operation_context_ref"])
    assert re.fullmatch(r"[a-f0-9]{64}", value["body_digest"])
    assert value["actor_subject"] == me1["subject"] == me2["subject"]
    assert value["completed_at"].endswith("Z")
    assert business_snapshot(sac) == before
    assert_error(sac["client"].post("/api/v1/admin/logout", json=body),
                 409, "ADMIN_AUTH_CONTEXT_CHANGED")


def test_approval_replay_conflicts_and_business_fingerprint_preserve_frozen_actor(sac):
    cookie1, me1 = login(sac)
    _, _, key = new_demand(sac)
    first, body = approve(sac, me1, key)
    handoff_id = first.json()["id"]
    url = f"/api/v1/admin/groups/{key}/approve"
    after_first = business_snapshot(sac)
    replay = sac["client"].post(url, json=body)
    assert replay.status_code == 200
    assert replay.json() == first.json()
    assert business_snapshot(sac) == after_first
    assert_error(sac["client"].post(url, json={**body, "note": "不同技术说明"}),
                 409, "ADMIN_ACTION_BODY_CONFLICT")
    assert_error(sac["client"].post("/api/v1/admin/groups/different/approve", json=body),
                 409, "ADMIN_ACTION_BODY_CONFLICT")
    _, me2 = login(sac)
    new_body = {**body, **action(me2), "request_id": body["request_id"]}
    assert_error(sac["client"].post(url, json=new_body), 409, "ADMIN_ACTION_CONTEXT_CONFLICT")
    operation = sac["client"].get("/api/v1/admin/operations/" + body["request_id"])
    assert operation.status_code == 200
    original_meta = operation.json()
    assert original_meta["outcome"] == "created"
    assert original_meta["result_ref"] == {"kind": "handoff", "id": handoff_id, "revision": 1}
    with sac["factory"]() as db:
        frozen_before = (db.get(DemandHandoff, handoff_id).payload_json,
                         db.get(DemandHandoff, handoff_id).metadata_json)
        audit_before = db.query(DemandAudit).filter_by(action="approve").count()
    # Same frozen baseline/note/window, distinct original page intent.
    second_body = {**body, **action(me2)}
    second = sac["client"].post(url, json=second_body)
    assert second.status_code == 200
    assert second.json()["id"] == handoff_id
    metadata2 = sac["client"].get("/api/v1/admin/operations/" + second_body["request_id"]).json()
    assert metadata2["outcome"] == "reused_frozen"
    with sac["factory"]() as db:
        assert (db.get(DemandHandoff, handoff_id).payload_json,
                db.get(DemandHandoff, handoff_id).metadata_json) == frozen_before
        assert db.query(DemandHandoff).count() == 1
        assert db.query(DemandAudit).filter_by(action="approve").count() == audit_before
    cookie_as(sac, cookie1)
    assert sac["client"].get("/api/v1/admin/me").status_code == 200


def test_operation_not_found_is_same_for_unknown_and_new_scope(sac):
    _, me = login(sac)
    _, occurrence_id, _ = new_demand(sac)
    body = action(me, note="合成技术排除说明")
    response = sac["client"].post(f"/api/v1/admin/occurrences/{occurrence_id}/reject", json=body)
    assert response.status_code == 200
    assert sac["client"].get("/api/v1/admin/operations/" + body["request_id"]).status_code == 200
    unknown = sac["client"].get("/api/v1/admin/operations/" + str(uuid.uuid4()))
    assert_error(unknown, 404, "ADMIN_OPERATION_NOT_FOUND")
    sac["monkeypatch"].setenv("STYLING_ADMIN_SCOPE", "sac-second-scope")
    login(sac)
    cross_scope = sac["client"].get("/api/v1/admin/operations/" + body["request_id"])
    assert_error(cross_scope, 404, "ADMIN_OPERATION_NOT_FOUND")
    assert cross_scope.json() == unknown.json()


def test_temporary_second_subject_cannot_claim_global_action_id(sac):
    _, me_a = login(sac)
    _, occurrence_id, _ = new_demand(sac)
    body_a = action(me_a, note="合成技术排除说明")
    url = f"/api/v1/admin/occurrences/{occurrence_id}/reject"
    assert sac["client"].post(url, json=body_a).status_code == 200
    sac["monkeypatch"].setenv("STYLING_ADMIN_SUBJECT", "sac-manager-B")
    _, me_b = login(sac)
    body_b = {**body_a, **action(me_b), "request_id": body_a["request_id"]}
    before = business_snapshot(sac)
    assert_error(sac["client"].post(url, json=body_b), 404, "ADMIN_OPERATION_NOT_FOUND")
    assert_error(sac["client"].get("/api/v1/admin/operations/" + body_a["request_id"]),
                 404, "ADMIN_OPERATION_NOT_FOUND")
    assert business_snapshot(sac) == before


def test_export_is_pure_and_legacy_send_restore_and_uncovered_routes_closed(sac):
    _, me = login(sac)
    _, occurrence_id, key = new_demand(sac)
    first, _ = approve(sac, me, key)
    handoff_id = first.json()["id"]
    before = business_snapshot(sac)
    response = sac["client"].get(f"/api/v1/admin/handoffs/{handoff_id}/export")
    assert response.status_code == 200
    with sac["factory"]() as db:
        frozen = db.get(DemandHandoff, handoff_id)
        expected_digest = json.loads(frozen.metadata_json)["payload_digest"]
        assert response.content == frozen.payload_json.encode("utf-8")
    assert hashlib.sha256(response.content).hexdigest() == expected_digest
    assert business_snapshot(sac) == before
    assert_error(sac["client"].post(f"/api/v1/admin/handoffs/{handoff_id}/send", json=action(me)),
                 409, "ADMIN_LEGACY_MUTATION_DISABLED")
    assert_error(sac["client"].post(f"/api/v1/admin/occurrences/{occurrence_id}/restore",
                                   json=action(me, note="合成技术恢复说明", expected_revision=1)),
                 409, "ADMIN_FEATURE_DISABLED")
    assert_error(sac["client"].post("/api/v1/admin/not-covered-write", json=action(me)),
                 409, "ADMIN_FEATURE_DISABLED")
    assert business_snapshot(sac) == before


def test_real_expiry_is_auth_failure_before_original_success_replay(sac):
    cookie, me = login(sac)
    _, occurrence_id, _ = new_demand(sac)
    body = action(me, note="合成技术排除说明")
    url = f"/api/v1/admin/occurrences/{occurrence_id}/reject"
    assert sac["client"].post(url, json=body).status_code == 200
    # The signed token is unchanged; persisted authority expiry is moved in this
    # new technical database to test the server's authoritative validity check.
    session_id = cookie.split(".")[1]
    with sac["factory"]() as db:
        db.get(DemandAdminSession, session_id).expires_at = utcnow() - timedelta(seconds=1)
        db.get(StylingAccountSession, session_id).expires_at = utcnow() - timedelta(seconds=1)
        db.commit()
    before = business_snapshot(sac)
    assert_error(sac["client"].post(url, json=body), 401, "ADMIN_SESSION_EXPIRED")
    assert business_snapshot(sac) == before


def test_registered_evidence_is_idempotent_strict_and_read_only(sac):
    _, me = login(sac)
    _, _, key = new_demand(sac)
    approval, _ = approve(sac, me, key)
    handoff_id = approval.json()["id"]
    url = f"/api/v1/admin/handoffs/{handoff_id}/evidence-export"
    body = action(me, expected_revision=1)
    first = sac["client"].post(url, json=body)
    assert first.status_code == 200, first.text
    before = business_snapshot(sac)
    assert sac["client"].post(url, json=body).json() == first.json()
    read = sac["client"].get(url)
    assert read.status_code == 200
    assert hashlib.sha256(read.content).hexdigest() == read.headers["x-content-sha256"]
    metadata = sac["client"].get("/api/v1/admin/operations/" + body["request_id"])
    assert metadata.status_code == 200
    assert metadata.json()["operation_kind"] == "evidence_export"
    assert metadata.json()["result_ref"]["kind"] == "frozen_evidence"
    assert business_snapshot(sac) == before


def test_synthetic_legacy_action_is_readable_but_cannot_gain_new_binding(sac):
    """New fixture only: deliberately old-schema rows, no claimed transmission."""
    _, me = login(sac)
    request_id = str(uuid.uuid4())
    delivery_id = "technical-legacy-delivery"
    with sac["factory"]() as db:
        db.add(StylingDirectDelivery(
            id=delivery_id, handoff_id="technical-legacy-handoff", revision=1,
            scope=me["scope"], source_instance_id=me["source_instance_id"],
            target_instance_id="technical-local-mock-only", approval_record_id="technical-approval",
            actor_subject=me["subject"], envelope_json="{}", envelope_digest="a" * 64,
            payload_digest="b" * 64, status="unconfirmed"))
        db.add(StylingDirectAction(
            id="technical-legacy-action", delivery_id=delivery_id, scope=me["scope"],
            actor_subject=me["subject"], request_id=request_id, operation="send",
            request_digest="c" * 64, response_json=json.dumps({"status": "unconfirmed"}),
            finished_at=utcnow()))
        db.commit()
    before = business_snapshot(sac)
    metadata = sac["client"].get("/api/v1/admin/operations/" + request_id)
    assert metadata.status_code == 200
    value = metadata.json()
    assert set(value) == META_FIELDS
    assert value["context_binding"] == "legacy_unbound"
    assert value["operation_context_ref"] is None and value["body_digest"] is None
    assert value["actor_subject"] == me["subject"]
    body = {**action(me, expected_revision=1), "request_id": request_id}
    response = sac["client"].post("/api/v1/admin/handoffs/technical-legacy-handoff/direct-send", json=body)
    assert_error(response, 409, "ADMIN_ACTION_LEGACY_UNBOUND")
    assert business_snapshot(sac) == before
    sac["monkeypatch"].setenv("STYLING_ADMIN_SUBJECT", "sac-manager-B")
    _, me_b = login(sac)
    body_b = {**action(me_b, expected_revision=1), "request_id": request_id}
    before_b = business_snapshot(sac)
    assert_error(sac["client"].post("/api/v1/admin/handoffs/technical-legacy-handoff/direct-send", json=body_b),
                 404, "ADMIN_OPERATION_NOT_FOUND")
    assert_error(sac["client"].get("/api/v1/admin/operations/" + request_id),
                 404, "ADMIN_OPERATION_NOT_FOUND")
    assert business_snapshot(sac) == before_b


@pytest.mark.parametrize("method", ["post", "put", "patch", "delete"])
def test_uncovered_management_mutation_methods_fail_closed(sac, method):
    _, me = login(sac)
    before = business_snapshot(sac)
    response = sac["client"].request(method.upper(), "/api/v1/admin/not-covered-write", json=action(me))
    assert_error(response, 409, "ADMIN_FEATURE_DISABLED")
    assert business_snapshot(sac) == before


def test_unreadable_authority_account_table_fails_closed(sac):
    login(sac)
    # Deliberate physical table loss in this test's new private file only.
    StylingAccountSession.__table__.drop(sac["engine"])
    response = sac["client"].get("/api/v1/admin/me")
    assert_error(response, 503, "ADMIN_AUTH_UNAVAILABLE")


def test_unreadable_operation_ledger_fails_closed_without_business_reexecution(sac):
    from app.models.admin_context import AdminOperation
    _, me = login(sac)
    _, occurrence_id, _ = new_demand(sac)
    body = action(me, note="合成技术排除说明")
    url = f"/api/v1/admin/occurrences/{occurrence_id}/reject"
    assert sac["client"].post(url, json=body).status_code == 200
    AdminOperation.__table__.drop(sac["engine"])
    response = sac["client"].get("/api/v1/admin/operations/" + body["request_id"])
    assert_error(response, 503, "ADMIN_OPERATION_STORAGE_UNAVAILABLE")
    with sac["factory"]() as db:
        assert db.get(DemandOccurrence, occurrence_id).revision == 2
        assert db.query(DemandAudit).filter_by(action="reject").count() == 1


def test_unreadable_private_response_blocks_replay_but_does_not_hide_metadata(sac):
    from app.models.admin_context import AdminOperationResponse
    _, me = login(sac)
    _, occurrence_id, _ = new_demand(sac)
    body = action(me, note="合成技术排除说明")
    url = f"/api/v1/admin/occurrences/{occurrence_id}/reject"
    assert sac["client"].post(url, json=body).status_code == 200
    AdminOperationResponse.__table__.drop(sac["engine"])
    metadata = sac["client"].get("/api/v1/admin/operations/" + body["request_id"])
    assert metadata.status_code == 200
    assert metadata.json()["state"] == "completed"
    assert_error(sac["client"].post(url, json=body), 503, "ADMIN_OPERATION_STORAGE_UNAVAILABLE")
    with sac["factory"]() as db:
        assert db.get(DemandOccurrence, occurrence_id).revision == 2
        assert db.query(DemandAudit).filter_by(action="reject").count() == 1


def test_real_concurrent_same_context_same_body_approval_creates_one_freeze(sac):
    _, me = login(sac)
    _, _, key = new_demand(sac)
    baseline = sac["client"].get(f"/api/v1/admin/groups/{key}/approval-set").json()
    body = action(me, note="合成技术并发批准，不代表真实企业审批", days=7,
                  expected_occurrence_ids=baseline["expected_occurrence_ids"],
                  expected_revisions=baseline["expected_revisions"],
                  expected_evidence_digest=baseline["evidence_digest"],
                  window_start=baseline["window_start"], window_end=baseline["window_end"])
    start = Barrier(2)
    def request():
        start.wait(timeout=5)
        return sac["client"].post(f"/api/v1/admin/groups/{key}/approve", json=body)
    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(request), executor.submit(request)]
        responses = [future.result(timeout=15) for future in futures]
    assert [response.status_code for response in responses] == [200, 200]
    assert responses[0].json() == responses[1].json()
    with sac["factory"]() as db:
        from app.models.admin_context import AdminOperation
        assert db.query(DemandHandoff).count() == 1
        assert db.query(DemandAudit).filter_by(action="approve").count() == 1
        assert db.query(AdminOperation).filter_by(request_id=body["request_id"]).count() == 1


def test_retry_is_real_finite_and_idempotent_and_stale_context_never_executes(sac):
    import app.services.demand as demand
    cookie1, me1 = login(sac)
    turn_id = uuid.uuid4().hex
    with sac["factory"]() as db:
        db.add(DemandTurn(id=turn_id, request_id=str(uuid.uuid4()),
                         session_id="sac-retry-synthetic", text="希望秋季通勤穿宽松长裤",
                         status="extraction_failed", error_code="TECHNICAL_FIXTURE",
                         extraction_attempts=0, data_origin="synthetic"))
        db.commit()
    old_body = action(me1)
    _, me2 = login(sac)
    calls = []
    real_process = demand._process_turn
    def tracked_process(*args, **kwargs):
        calls.append("actual-rule-execution")
        return real_process(*args, **kwargs)
    sac["monkeypatch"].setattr(demand, "_process_turn", tracked_process)
    before = business_snapshot(sac)
    url = f"/api/v1/admin/turns/{turn_id}/retry"
    assert_error(sac["client"].post(url, json=old_body), 409, "ADMIN_AUTH_CONTEXT_CHANGED")
    assert len(calls) == 0
    assert business_snapshot(sac) == before
    current_body = action(me2)
    response = sac["client"].post(url, json=current_body)
    assert response.status_code == 200
    assert response.json()["status"] == "extracted"
    assert len(calls) == 1
    after = business_snapshot(sac)
    replay = sac["client"].post(url, json=current_body)
    assert replay.status_code == 200 and replay.json() == response.json()
    assert len(calls) == 1
    assert business_snapshot(sac) == after
    with sac["factory"]() as db:
        assert db.get(DemandTurn, turn_id).extraction_attempts <= demand.MAX_TOTAL_ATTEMPTS
        assert db.query(DemandOccurrence).filter_by(turn_id=turn_id).count() == 1
        assert db.query(DemandAudit).filter_by(action="extraction_retry", actor=me2["subject"]).count() == 1


def test_real_non_uuid_legacy_id_has_ownership_gate_and_cannot_create_new_action(sac):
    _, me_a = login(sac)
    request_id = "legacy.technical:01"
    with sac["factory"]() as db:
        db.add(StylingDirectDelivery(
            id="technical-nonuuid-delivery", handoff_id="technical-nonuuid-handoff", revision=1,
            scope=me_a["scope"], source_instance_id=me_a["source_instance_id"],
            target_instance_id="technical-local-mock-only", approval_record_id="technical-approval",
            actor_subject=me_a["subject"], envelope_json="{}", envelope_digest="a" * 64,
            payload_digest="b" * 64, status="unconfirmed"))
        db.add(StylingDirectAction(
            id="technical-nonuuid-action", delivery_id="technical-nonuuid-delivery",
            scope=me_a["scope"], actor_subject=me_a["subject"], request_id=request_id,
            operation="send", request_digest="c" * 64,
            response_json=json.dumps({"status": "unconfirmed"}), finished_at=utcnow()))
        db.commit()
    body_a = {**action(me_a, expected_revision=1), "request_id": request_id}
    url = "/api/v1/admin/handoffs/technical-nonuuid-handoff/direct-send"
    before = business_snapshot(sac)
    assert_error(sac["client"].post(url, json=body_a), 409, "ADMIN_ACTION_LEGACY_UNBOUND")
    assert business_snapshot(sac) == before
    sac["monkeypatch"].setenv("STYLING_ADMIN_SUBJECT", "sac-manager-B")
    _, me_b = login(sac)
    body_b = {**action(me_b, expected_revision=1), "request_id": request_id}
    before_b = business_snapshot(sac)
    assert_error(sac["client"].post(url, json=body_b), 404, "ADMIN_OPERATION_NOT_FOUND")
    unknown = {**body_b, "request_id": "legacy.unknown:01"}
    assert_error(sac["client"].post(url, json=unknown), 422, "ADMIN_ACTION_INVALID")
    assert business_snapshot(sac) == before_b


@pytest.mark.parametrize("shape", ["no_body", "empty_object", "revision_only"])
def test_direct_missing_body_or_context_is_required_before_any_business(sac, shape):
    login(sac)
    before = business_snapshot(sac)
    url = "/api/v1/admin/handoffs/not-existing/direct-send"
    if shape == "no_body":
        response = sac["client"].post(url)
    elif shape == "empty_object":
        response = sac["client"].post(url, json={})
    else:
        response = sac["client"].post(url, json={"expected_revision": 1})
    assert_error(response, 422, "ADMIN_CONTEXT_REQUIRED")
    assert business_snapshot(sac) == before
