import json
import uuid
import httpx
import pytest
from app.api import admin
from app.core.database import SessionLocal, engine
from app.models.demand import (DemandAdminSession, DemandAudit, DemandHandoff, DemandOccurrence,
                               DemandOccurrenceRevision, DemandRequestAdmission, DemandSendAttempt, DemandTurn)
from app.services.demand import extract, record_turn


@pytest.fixture(autouse=True)
def setup(monkeypatch):
    monkeypatch.setenv("STYLING_ADMIN_PASSWORD", "test-manager-password")
    monkeypatch.setenv("STYLING_ADMIN_SECRET", "test-signing-secret-" * 3)
    monkeypatch.setenv("STYLING_ADMIN_COOKIE_SECURE", "0")
    monkeypatch.delenv("STYLING_DEMAND_RECEIVER_URL", raising=False)
    monkeypatch.delenv("STYLING_DEMAND_RECEIVER_KEY", raising=False)
    with SessionLocal() as db:
        for model in (DemandSendAttempt, DemandOccurrenceRevision, DemandAdminSession, DemandRequestAdmission,
                      DemandOccurrence, DemandTurn, DemandHandoff, DemandAudit):
            db.query(model).delete()
        db.commit()
    admin._attempts.clear()


def login(client):
    assert client.post("/api/v1/admin/login", json={"password": "test-manager-password"}).status_code == 200


def sample(session="session-1", request_id=None, text="我想要秋天通勤宽松阔腿裤"):
    return record_turn(session, request_id or uuid.uuid4().hex, text)


def package(client):
    sample()
    login(client)
    group = client.get("/api/v1/admin/overview").json()["groups"][0]
    evidence = client.get(f'/api/v1/admin/groups/{group["key"]}').json()["evidence"]
    body = {"note": "证据已核对", "days": 7, "expected_occurrence_ids": [e["id"] for e in evidence]}
    response = client.post(f'/api/v1/admin/groups/{group["key"]}/approve', json=body)
    assert response.status_code == 200, response.text
    return response.json(), group, body


def test_semantic_demands_negation_and_unknowns():
    result = extract("秋天通勤，不要紧身裤，想要宽松阔腿裤")
    assert result[0]["attributes"] == {"category": "裤子", "season": "秋", "scene": "通勤", "fit": "宽松", "silhouette": "阔腿"}
    assert extract("不要紧身裤") == []
    assert extract("谢谢") == []
    assert extract("给我看看图片") == []
    assert extract("想要宽腿裤")[0]["group_key"] == extract("想要阔腿裤")[0]["group_key"]
    assert extract("想要裤子")[0]["attributes"]["season"] is None
    assert extract("想要宽松上衣，还有修身裤子")[0]["attributes"]["fit"] == "修身"


def test_heat_five_above_two_dedup_and_durable(client):
    for i in range(5):
        assert sample(f"session-{i}", f"request-{i}")
    assert not sample("session-0", "request-0")
    for i in range(2):
        sample(f"session-b-{i}", text="我想要紧身裤")
    sample(text="谢谢，我的手机号13812345678")
    engine.dispose()  # Reopen connections from persisted database, not frontend memory.
    login(client)
    data = client.get("/api/v1/admin/overview").json()
    assert data["groups"][0]["count"] == 5
    assert data["groups"][0]["session_count"] == 5
    assert data["groups"][1]["count"] == 2
    assert data["counts"]["turns"] == 8
    assert "13812345678" not in json.dumps(data)


def test_each_round_is_retained_and_not_real_people(client):
    sample(); sample()
    login(client)
    data = client.get("/api/v1/admin/overview").json()
    assert data["groups"][0]["count"] == 2
    assert data["groups"][0]["session_count"] == 1
    assert data["scope"] == "当前服务空间"


def test_default_closed_wrong_expired_and_cross_origin(client, monkeypatch):
    assert client.get("/api/v1/admin/overview").status_code == 401
    assert client.post("/api/v1/signals/fake/upload", json={"feedback_type": "intent"}).status_code == 401
    assert client.get("/api/v1/signals?session_id=x").status_code == 401
    assert client.post("/api/v1/admin/login", json={"password": "wrong"}).status_code == 401
    client.cookies.set("styling_admin_v1", "1.bad-signature")
    assert client.get("/api/v1/admin/overview").status_code == 401
    # Remove the deliberately domainless forged cookie before testing a valid
    # browser login. Mixed duplicate identities have their own rejection tests.
    client.cookies.clear()
    login(client)
    assert client.post("/api/v1/admin/logout", headers={"Origin": "https://evil.example"}).status_code == 403
    assert client.post("/api/v1/admin/logout").status_code == 200
    assert client.get("/api/v1/admin/overview").status_code == 401
    monkeypatch.delenv("STYLING_ADMIN_PASSWORD")
    assert client.post("/api/v1/admin/login", json={"password": "test-manager-password"}).status_code == 503


def test_approval_is_immutable_idempotent_and_stale_check(client):
    handoff, group, body = package(client)
    url = f'/api/v1/admin/groups/{group["key"]}/approve'
    assert client.post(url, json=body).json()["id"] == handoff["id"]
    export_url = f'/api/v1/admin/handoffs/{handoff["id"]}/export'
    original = client.get(export_url).json()
    sample("new-session")
    assert client.get(export_url).json() == original
    assert client.post(url, json=body).status_code == 409
    assert original["demand"]["material"] is None
    assert original["demand"]["craft"] is None
    assert original["demand"]["knowledge_status"] == "pending_database"
    assert "session_id" not in original["evidence"][0]


def test_reject_removes_heat_preserves_evidence_and_audit(client):
    handoff, group, body = package(client)
    occurrence_id = body["expected_occurrence_ids"][0]
    assert client.post(f"/api/v1/admin/occurrences/{occurrence_id}/reject", json={"note": "误提炼"}).status_code == 200
    assert client.get("/api/v1/admin/overview").json()["counts"]["occurrences"] == 0
    detail = client.get(f'/api/v1/admin/groups/{group["key"]}').json()
    assert detail["evidence"][0]["reason"] == "误提炼"
    assert client.get(f'/api/v1/admin/handoffs/{handoff["id"]}/export').status_code == 200
    with SessionLocal() as db:
        assert db.query(DemandAudit).count() == 3  # approve, reject, and v1.6 export audit


def test_upload_receipts_failed_retry_and_idempotence(client, monkeypatch):
    handoff, _, _ = package(client)
    url = f'/api/v1/admin/handoffs/{handoff["id"]}/send'
    assert client.post(url).status_code == 503
    monkeypatch.setenv("STYLING_DEMAND_RECEIVER_URL", "https://partner.example/v1/demand")
    monkeypatch.setenv("STYLING_DEMAND_RECEIVER_KEY", "test-only-key")
    sent = []
    def fake_post(endpoint, **kwargs):
        sent.append(json.loads(kwargs["content"])["handoff_id"])
        receipt = {"handoff_id": "wrong" if len(sent) == 1 else handoff["id"], "status": "received"}
        return httpx.Response(200, json=receipt, request=httpx.Request("POST", endpoint))
    monkeypatch.setattr(admin.httpx, "post", fake_post)
    assert client.post(url).status_code == 502
    assert client.post(url).json()["status"] == "received"
    assert client.post(url).json()["status"] == "received"
    assert sent == [handoff["id"], handoff["id"]]


def test_rejected_snapshot_cannot_send(client, monkeypatch):
    handoff, _, body = package(client)
    client.post(f'/api/v1/admin/occurrences/{body["expected_occurrence_ids"][0]}/reject', json={"note": "证据不成立"})
    monkeypatch.setenv("STYLING_DEMAND_RECEIVER_URL", "https://partner.example/v1/demand")
    monkeypatch.setenv("STYLING_DEMAND_RECEIVER_KEY", "test-only-key")
    assert client.post(f'/api/v1/admin/handoffs/{handoff["id"]}/send').status_code == 409


def test_chat_duplicate_is_rejected_before_model(client, monkeypatch):
    from app.services import agent
    calls = []
    async def fake_events(*args):
        calls.append(args)
        yield {"type": "done", "session_id": args[0], "content": "已收到"}
    monkeypatch.setattr(agent, "run_agent_events", fake_events)
    body = {"session_id": "s", "request_id": "request-fixed", "message": "我想要阔腿裤"}
    assert client.post("/api/v1/chat", json=body).status_code == 200
    assert client.post("/api/v1/chat", json=body).status_code == 409
    assert len(calls) == 1
    login(client)
    assert client.get("/api/v1/admin/overview").json()["counts"]["turns"] == 1


def test_result_file_missing_and_unknown_cost_are_distinct(client, monkeypatch, tmp_path):
    from app.models.tryon import TryonTask
    monkeypatch.setattr(admin, "DATA_DIR", tmp_path)
    results = tmp_path / "tryon-results"
    results.mkdir()
    (results / "saved.png").write_bytes(b"test-result-file")
    with SessionLocal() as db:
        db.add(TryonTask(id="admin-image-saved", session_id="image-session", status="succeeded", scene="通勤",
                         product_ids="P001,P007", result_url="/tryon-results/saved.png"))
        db.add(TryonTask(id="admin-image-missing", session_id="image-session", status="succeeded",
                         result_url="/tryon-results/missing.png"))
        db.commit()
    login(client)
    images = {i["id"]: i for i in client.get("/api/v1/admin/overview").json()["images"]}
    assert images["admin-image-saved"]["bytes"] == 16
    assert images["admin-image-saved"]["product_ids"] == ["P001", "P007"]
    assert images["admin-image-saved"]["cost"] is None
    assert images["admin-image-saved"]["api_attempts"] is None
    assert images["admin-image-missing"]["status"] == "succeeded"
    assert images["admin-image-missing"]["file_exists"] is False
    assert images["admin-image-missing"]["result_url"] == ""
