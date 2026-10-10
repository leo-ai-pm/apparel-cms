"""模型调用层：DeepSeek（OpenAI 兼容接口）+ 超时/重试/兜底。"""
import time

from openai import APIConnectionError, APIError, APITimeoutError, APIStatusError, OpenAI

from app.core.config import settings


class LLMError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def _client() -> OpenAI:
    # SDK 初始化失败（如无 Key）发生在重试逻辑之外，直接抛统一错误
    if not settings.deepseek_api_key:
        raise LLMError("NO_API_KEY", "未配置模型 API Key，请先在 .env 中填写 DEEPSEEK_API_KEY")
    try:
        return OpenAI(
            api_key=settings.deepseek_api_key,
            base_url=settings.deepseek_base_url,
            timeout=settings.llm_timeout,
        )
    except Exception:
        raise LLMError("SDK_INIT_FAILED", "模型客户端初始化失败")


def chat(messages: list[dict], tools: list[dict] | None = None) -> dict:
    """返回 {"content": str, "tool_calls": [...]}，失败抛 LLMError。"""
    client = _client()
    last_err: LLMError | None = None
    for attempt in range(settings.llm_retries + 1):
        try:
            kwargs: dict = {"model": settings.deepseek_model, "messages": messages, "temperature": 0.7}
            if tools:
                kwargs["tools"] = tools
                kwargs["tool_choice"] = "auto"
            resp = client.chat.completions.create(**kwargs)
            msg = resp.choices[0].message
            result: dict = {"content": msg.content or ""}
            tool_calls = getattr(msg, "tool_calls", None)
            if tool_calls:
                result["tool_calls"] = [
                    {
                        "id": tc.id,
                        "type": tc.type,
                        "function": {"name": tc.function.name, "arguments": tc.function.arguments or "{}"},
                    }
                    for tc in tool_calls
                ]
            return result
        except APITimeoutError:
            last_err = LLMError("LLM_TIMEOUT", "模型调用超时，请稍后重试")
        except APIConnectionError:
            last_err = LLMError("LLM_CONNECTION", "无法连接模型服务，请检查网络")
        except APIStatusError as e:
            last_err = LLMError("LLM_STATUS", f"模型返回错误状态 {e.status_code}")
        except APIError:
            last_err = LLMError("LLM_API", "模型调用失败，请稍后重试")
        except Exception:
            last_err = LLMError("LLM_INTERNAL", "模型调用内部错误")
        if attempt < settings.llm_retries:
            time.sleep(0.5 * (attempt + 1))
    raise last_err  # type: ignore[misc]


def stream_chat(messages: list[dict], tools: list[dict] | None = None):
    """同步生成器：yield (kind, payload)。kind 为 "text"（增量文本）或 "tool_calls"（完整工具调用列表）。

    单次尝试，不做重试（流式期间重试需重新生成）；失败抛 LLMError。
    """
    client = _client()
    kwargs: dict = {"model": settings.deepseek_model, "messages": messages, "temperature": 0.7, "stream": True}
    if tools:
        kwargs["tools"] = tools
        kwargs["tool_choice"] = "auto"
    stream = client.chat.completions.create(**kwargs)
    tool_calls: dict[int, dict] = {}
    for chunk in stream:
        if not chunk.choices:
            continue
        delta = chunk.choices[0].delta
        if delta is None:
            continue
        if delta.content:
            yield ("text", delta.content)
        if delta.tool_calls:
            for tc in delta.tool_calls:
                idx = tc.index
                if idx not in tool_calls:
                    tool_calls[idx] = {"id": "", "type": "function", "function": {"name": "", "arguments": ""}}
                if tc.id:
                    tool_calls[idx]["id"] = tc.id
                if tc.function and tc.function.name:
                    tool_calls[idx]["function"]["name"] += tc.function.name
                if tc.function and tc.function.arguments:
                    tool_calls[idx]["function"]["arguments"] += tc.function.arguments
    if tool_calls:
        yield ("tool_calls", [tool_calls[i] for i in sorted(tool_calls)])
