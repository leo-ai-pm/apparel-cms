"""Provider failures must never become successful assistant history."""
import asyncio

import pytest

from app.core.config import settings
from app.services import agent, llm


@pytest.mark.parametrize("code", ["LLM_TIMEOUT", "LLM_CONNECTION", "LLM_STATUS", "LLM_INTERNAL"])
def test_exhausted_provider_failure_has_no_done_or_history(monkeypatch, code):
    monkeypatch.setattr(settings, "llm_retries", 0)

    def broken_stream(*args, **kwargs):
        yield ("text", "未完成的半句")
        raise llm.LLMError(code, "模型调用未完成")

    monkeypatch.setattr(llm, "stream_chat", broken_stream)
    events = []

    async def run():
        async for event in agent.run_agent_events("failure-" + code, "帮我推荐通勤穿搭"):
            events.append(event)

    with pytest.raises(llm.LLMError) as error:
        asyncio.run(run())
    assert error.value.code == code
    assert not any(e["type"] in ("done", "text") for e in events)
    assert agent.load_history("failure-" + code) == []


def test_tool_step_limit_is_failure_not_success(monkeypatch):
    monkeypatch.setattr(settings, "max_agent_steps", 1)

    def endless_stream(*args, **kwargs):
        yield ("tool_calls", [{"id": "t1", "type": "function", "function": {
            "name": "query_style_knowledge", "arguments": "{}"}}])

    monkeypatch.setattr(llm, "stream_chat", endless_stream)

    async def run():
        return [e async for e in agent.run_agent_events("failure-step-limit", "帮我搭配")]

    with pytest.raises(llm.LLMError) as error:
        asyncio.run(run())
    assert error.value.code == "AGENT_STEP_LIMIT"
    assert agent.load_history("failure-step-limit") == []


def test_empty_provider_result_is_failure(monkeypatch):
    def empty_stream(*args, **kwargs):
        return iter([])

    monkeypatch.setattr(llm, "stream_chat", empty_stream)

    async def run():
        return [e async for e in agent.run_agent_events("failure-empty", "帮我搭配")]

    with pytest.raises(llm.LLMError) as error:
        asyncio.run(run())
    assert error.value.code == "EMPTY_LLM_RESULT"
    assert agent.load_history("failure-empty") == []
