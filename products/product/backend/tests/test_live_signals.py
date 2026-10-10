from fastapi.testclient import TestClient

from app.db import save_direct_signal
from app.main import app
from app.services import agent_tools


def signal(signal_id: str) -> dict:
    return {"signal_id": signal_id, "timestamp": "2026-10-09T12:00:00+08:00", "scene": "commute", "preference": "通勤", "feedback_type": "intent", "source_agent": "outfit", "outfit_plan": {"items": []}}


def test_local_signal_list_and_agent_search_exclude_demo(db):
    save_direct_signal(signal("SIG-DEMO-0001"))
    save_direct_signal(signal("SIG-20261009-0001"))
    with TestClient(app) as client:
        response = client.get("/api/agent/signals")
    assert response.status_code == 200
    assert [item["signal_id"] for item in response.json()["signals"]] == ["SIG-20261009-0001"]
    result, trace = agent_tools._search_signals(agent_tools.SearchArgs(query="commute"))
    assert [item["signal_id"] for item in result["records"]] == ["SIG-20261009-0001"]
    assert trace["status"] == "ok"


def test_direct_ingest_requires_key_and_is_idempotent(db, monkeypatch):
    monkeypatch.setenv("OUTFIT_SIGNAL_KEY", "x" * 40)
    with TestClient(app) as client:
        assert client.post("/api/agent/signals", json=signal("SIG-20261009-0002")).status_code == 401
        headers = {"X-Signal-Key": "x" * 40}
        first = client.post("/api/agent/signals", json=signal("SIG-20261009-0002"), headers=headers)
        assert first.status_code == 201 and first.json()["created"] is True
        second = client.post("/api/agent/signals", json=signal("SIG-20261009-0002"), headers=headers)
        assert second.status_code == 201 and second.json()["created"] is False
        changed = {**signal("SIG-20261009-0002"), "preference": "不同内容"}
        assert client.post("/api/agent/signals", json=changed, headers=headers).status_code == 409
