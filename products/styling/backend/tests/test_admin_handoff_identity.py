"""Historical list identity is supplied by the frozen snapshot, not current heat."""
import json

import pytest

from app.core.database import SessionLocal
from app.models.demand import DemandAdminSession, DemandAudit, DemandHandoff, DemandSendAttempt


@pytest.fixture(autouse=True)
def isolated_history(monkeypatch):
    monkeypatch.setenv("STYLING_ADMIN_PASSWORD", "test-manager-password")
    monkeypatch.setenv("STYLING_ADMIN_SECRET", "test-only-history-signing-secret-" * 2)
    monkeypatch.setenv("STYLING_ADMIN_COOKIE_SECURE", "0")
    with SessionLocal() as db:
        for model in (DemandHandoff, DemandAudit, DemandSendAttempt, DemandAdminSession):
            db.query(model).delete()
        for number, demand in enumerate([
            {"group_key": "frozen-pants", "title": "旧版裤子标题", "occurrences": 1},
            {"group_key": "frozen-shoes", "title": "旧版鞋履标题", "occurrences": 1},
            {"occurrences": 1},
        ]):
            db.add(DemandHandoff(id=f"history-{number}", group_key=f"storage-group-{number}",
                version=1, fingerprint=f"history-fingerprint-{number}", payload_json=json.dumps({
                    "schema_version": "1.4", "demand": demand, "evidence": []}, ensure_ascii=False)))
        db.commit()


def test_handoff_list_exposes_frozen_group_and_title_without_extra_detail_queries(client):
    assert client.post("/api/v1/admin/login", json={"password": "test-manager-password"}).status_code == 200
    with SessionLocal() as db:
        before = {h.id: h.payload_json for h in db.query(DemandHandoff)}
    response = client.get("/api/v1/admin/handoffs")
    assert response.status_code == 200
    items = {h["id"]: h for h in response.json()["items"]}
    assert items["history-0"]["group_key"] == "frozen-pants"
    assert items["history-0"]["title"] == "旧版裤子标题"
    assert items["history-1"]["group_key"] == "frozen-shoes"
    assert items["history-1"]["title"] == "旧版鞋履标题"
    assert items["history-2"]["group_key"] == "storage-group-2"
    assert items["history-2"]["title"] is None  # legacy missing metadata stays unknown
    detail = client.get("/api/v1/admin/handoffs/history-0").json()
    assert detail["group_key"] == items["history-0"]["group_key"]
    assert detail["title"] == items["history-0"]["title"]
    with SessionLocal() as db:
        assert {h.id: h.payload_json for h in db.query(DemandHandoff)} == before
