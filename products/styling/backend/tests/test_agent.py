import asyncio

from app.services import agent, llm


def _collect(session_id: str, message: str) -> list[dict]:
    async def _run():
        return [e async for e in agent.run_agent_events(session_id, message)]

    return asyncio.run(_run())


def test_write_request_refused_without_model(monkeypatch):
    calls = []

    def fake_stream(*a, **k):
        calls.append(1)
        yield ("text", "不应调用")

    monkeypatch.setattr(llm, "stream_chat", fake_stream)
    events = _collect("s-write", "帮我下单这件衣服")
    assert calls == []  # 确定性拒绝，不调用模型
    done = [e for e in events if e["type"] == "done"][0]
    assert "未被授权" in done["content"]


def test_agent_loop_calls_tool_then_outputs(monkeypatch):
    calls = {"n": 0}

    def fake_stream(messages, tools):
        calls["n"] += 1
        if calls["n"] == 1:
            yield ("tool_calls", [
                {"id": "t1", "type": "function",
                 "function": {"name": "query_style_knowledge", "arguments": '{"scene": "通勤", "body_type": "梨形"}'}}
            ])
        else:
            yield ("text", "## 推荐方案\n推荐「A字半身裙」｜下装｜¥219｜适合通勤。")

    monkeypatch.setattr(llm, "stream_chat", fake_stream)
    events = _collect("s-loop", "通勤穿搭，梨形身材，预算500")
    statuses = [e for e in events if e["type"] == "status"]
    assert any("正在为你搭配" in s["message"] for s in statuses)
    assert not any("query_style_knowledge" in s["message"] for s in statuses)  # 不向用户暴露内部工具名
    done = [e for e in events if e["type"] == "done"][0]
    assert "A字半身裙" in done["content"]


def test_history_persisted_after_turn(monkeypatch):
    def fake_stream(messages, tools):
        yield ("text", "请告诉我场景和体型。")

    monkeypatch.setattr(llm, "stream_chat", fake_stream)
    _collect("s-hist", "你好")
    history = agent.load_history("s-hist")
    assert len(history) == 2
    assert history[0]["role"] == "user"
    assert history[1]["role"] == "assistant"


def test_profile_extraction():
    profile = agent._extract_profile(["我身高160cm，体重52kg，梨形身材，通勤场景，预算500"])
    assert profile.get("身高") == "160cm"
    assert profile.get("体重") == "52kg"
    assert profile.get("体型") == "梨形"
    assert profile.get("预算") == 500


def test_profile_extraction_gender_age_and_height_fallback():
    # 性别/年龄段 + 无单位身高体重（“身高160”）
    p = agent._extract_profile(["女，25~30岁，身高160体重50，梨形身材"])
    assert p.get("性别") == "女"
    assert p.get("年龄段") == "25~30"
    assert p.get("身高") == "160cm"
    assert p.get("体重") == "50kg"
    # 年龄段需带“岁”，避免把身高区间误判
    p2 = agent._extract_profile(["我 160-165cm"])
    assert p2.get("年龄段") is None


def test_extract_product_ids_from_text():
    text = "推荐「白色基础衬衫」｜上装｜¥159 和「A字半身裙」｜下装｜¥219"
    ids = agent._extract_product_ids_from_text(text)
    assert "P001" in ids and "P007" in ids


def test_internal_step_text_not_shown(monkeypatch):
    calls = {"n": 0}

    def fake_stream(messages, tools):
        calls["n"] += 1
        if calls["n"] == 1:
            yield ("text", "我先查一下商品库。")
            yield ("tool_calls", [
                {"id": "t1", "type": "function",
                 "function": {"name": "query_style_knowledge", "arguments": '{"scene": "通勤"}'}}
            ])
        else:
            yield ("text", "## 推荐方案\n推荐「白色基础衬衫」｜上装｜¥159。")

    monkeypatch.setattr(llm, "stream_chat", fake_stream)
    events = _collect("s-internal", "通勤穿搭")
    shown = "".join(e["content"] for e in events if e["type"] == "text")
    assert "先查一下" not in shown  # 内部步骤话术不展示
    assert "白色基础衬衫" in shown
    done = [e for e in events if e["type"] == "done"][0]
    assert "P001" in done["product_ids"]
