from tests.conftest import collect_sse


def test_health(client):
    r = client.get("/api/v1/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["has_key"] is False


def test_chat_no_key_returns_error_event(client):
    r = client.post("/api/v1/chat", json={"session_id": "s-nokey", "message": "帮我搭一套通勤装"})
    assert r.status_code == 200
    events = collect_sse(r)
    assert events[-1][0] == "error"
    assert events[-1][1]["error"]["code"] == "NO_API_KEY"


def test_chat_write_request_refused_without_model(client):
    r = client.post("/api/v1/chat", json={"session_id": "s-write", "message": "帮我下单"})
    events = collect_sse(r)
    assert events[-1][0] == "done"
    assert "未被授权" in events[-1][1]["content"]


def test_history_endpoint(client):
    client.post("/api/v1/chat", json={"session_id": "s-hist2", "message": "帮我下单"})
    r = client.get("/api/v1/sessions/s-hist2/messages")
    assert r.status_code == 200
    msgs = r.json()["messages"]
    assert len(msgs) == 2
    assert msgs[0]["role"] == "user"
