import httpx
import copy
from fastapi.testclient import TestClient

from app.main import app
from app.services import agent_tools, deepseek

SIGNAL = {
    "id": "REQ-018", "title": "小个子通勤西裤", "quote": "裤长偏长", "source": "穿搭信号",
    "category": "下装", "intent": 12, "cart": 5, "sales": 3,
}


def test_unconfigured_model_returns_clear_error(db, monkeypatch):
    monkeypatch.setattr(deepseek, "configuration", lambda: ("", "deepseek-flash"))
    with TestClient(app) as client:
        status = client.get("/api/agent/status").json()
        assert status["configured"] is False
        assert status["tools"]["search_knowledge_base"] is True
        response = client.post("/api/agent/chat", json={"signal": SIGNAL, "question": "有哪些反例？"})
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "DEEPSEEK_NOT_CONFIGURED"


def test_chat_sends_bounded_signal_and_returns_model_reply(db, monkeypatch):
    monkeypatch.setattr(deepseek, "configuration", lambda: ("test-key", "deepseek-flash"))
    captured = []

    def fake_post(payload, key):
        captured.append({"payload": copy.deepcopy(payload), "key": key})
        if "tools" in payload:
            return httpx.Response(200, json={"choices": [{"finish_reason": "tool_calls", "message": {"content": None, "tool_calls": [{"id": "call_1", "type": "function", "function": {"name": "search_internal_signals", "arguments": '{"query":"裤长"}'}}]}}]})
        return httpx.Response(200, json={"choices": [{"finish_reason": "stop", "message": {"content": "先核对已有 SKU。"}}]})

    monkeypatch.setattr(deepseek, "_post", fake_post)
    monkeypatch.setattr(agent_tools, "execute_tool", lambda name, args, allowed=None: ({"records": []}, {"tool": name, "title": "CMS", "status": "ok", "summary": "已查询", "sources": []}))
    with TestClient(app) as client:
        assert client.get("/api/agent/status").json()["configured"] is True
        response = client.post("/api/agent/chat", json={"signal": SIGNAL, "question": "是否做新款？", "history": []})
    assert response.status_code == 200
    assert response.json()["reply"] == "先核对已有 SKU。"
    assert response.json()["tool_trace"][0]["tool"] == "search_internal_signals"
    assert captured[0]["key"] == "test-key"
    assert captured[0]["payload"]["messages"][-1] == {"role": "user", "content": "是否做新款？"}
    assert '"intent": 12' in captured[0]["payload"]["messages"][0]["content"]


def test_analysis_validates_structured_response(db, monkeypatch):
    monkeypatch.setattr(deepseek, "configuration", lambda: ("test-key", "deepseek-flash"))

    def fake_post(payload, key):
        if "tools" in payload:
            return httpx.Response(200, json={"choices": [{"finish_reason": "tool_calls", "message": {"content": None, "tool_calls": [{"id": "call_1", "type": "function", "function": {"name": "search_knowledge_base", "arguments": '{"query":"审批"}'}}]}}]})
        assert payload["response_format"] == {"type": "json_object"}
        assert payload["thinking"] == {"type": "disabled"}
        return httpx.Response(200, json={"choices": [{"finish_reason": "stop", "message": {"content": '{"diagnosis":"尺码问题","grouping":"按裤长归并","counter":"库存未知","action":"核对库存","draft":"核对现售商品"}'}}]})

    monkeypatch.setattr(deepseek, "_post", fake_post)
    monkeypatch.setattr(agent_tools, "execute_tool", lambda name, args, allowed=None: ({"matches": []}, {"tool": name, "title": "文档", "status": "ok", "summary": "已查询", "sources": []}))
    with TestClient(app) as client:
        response = client.post("/api/agent/analyze", json={"signal": SIGNAL})
    assert response.status_code == 200
    assert response.json()["analysis"]["draft"] == "核对现售商品"


def test_upstream_error_does_not_expose_provider_body(db, monkeypatch):
    monkeypatch.setattr(deepseek, "configuration", lambda: ("test-key", "deepseek-flash"))
    monkeypatch.setattr(deepseek, "_post", lambda payload, key: httpx.Response(401, text="secret-provider-body"))
    with TestClient(app) as client:
        response = client.post("/api/agent/chat", json={"signal": SIGNAL, "question": "你好"})
    assert response.status_code == 502
    assert "secret-provider-body" not in response.text
    assert response.json()["error"]["code"] == "DEEPSEEK_INVALID_KEY"


def test_tool_selection_blocks_unselected_calls(db, monkeypatch):
    monkeypatch.setattr(deepseek, "configuration", lambda: ("test-key", "deepseek-flash"))
    executed = []

    def fake_post(payload, key):
        if "tools" in payload:
            assert [tool["function"]["name"] for tool in payload["tools"]] == ["search_knowledge_base"]
            return httpx.Response(200, json={"choices": [{"finish_reason": "tool_calls", "message": {"content": None, "tool_calls": [{"id": "call_1", "type": "function", "function": {"name": "search_public_sources", "arguments": '{"query":"竞品"}'}}]}}]})
        return httpx.Response(200, json={"choices": [{"finish_reason": "stop", "message": {"content": "公开资料未查询。"}}]})

    monkeypatch.setattr(deepseek, "_post", fake_post)
    original_execute = agent_tools.execute_tool
    def tracked_execute(name, args, allowed=None):
        executed.append(name)
        return original_execute(name, args, allowed)
    monkeypatch.setattr(agent_tools, "execute_tool", tracked_execute)
    with TestClient(app) as client:
        response = client.post("/api/agent/chat", json={"signal": SIGNAL, "question": "查证", "allowed_tools": ["search_knowledge_base"]})
    assert response.status_code == 200
    assert executed == ["search_public_sources"]
    assert response.json()["tool_trace"][0]["status"] == "forbidden"


def test_knowledge_search_returns_bounded_citations():
    result, trace = agent_tools.execute_tool("search_knowledge_base", {"query": "负责人"}, {"search_knowledge_base"})
    assert result["status"] == "ok"
    assert 0 < len(result["matches"]) <= 5
    assert all(":" in item["reference"] for item in result["matches"])
    assert trace["sources"]
