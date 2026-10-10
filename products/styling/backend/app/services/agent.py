"""Agent 循环：需求拆解 → 工具调用 → 输出方案 → 安全钩子 → 持久化。

以 async generator 形式产出事件（status / text / done），供 SSE 端点转发。
"""
import asyncio
import json
import re
import threading
import uuid
from datetime import date
from typing import AsyncIterator

from app.core.config import settings
from app.core.database import SessionLocal
from app.models.chat import ChatMessage, ChatSession
from app.services import catalog, hooks, llm, permissions, signals, tools
from app.services.prompts.system import SYSTEM_PROMPT


# —— 会话持久化 ——

def load_history(session_id: str) -> list[dict]:
    db = SessionLocal()
    try:
        rows = db.query(ChatMessage).filter_by(session_id=session_id).order_by(ChatMessage.id).all()
        return [{"role": r.role, "content": r.content} for r in rows]
    finally:
        db.close()


def save_history(session_id: str, user_message: str, assistant_message: str) -> None:
    db = SessionLocal()
    try:
        if db.get(ChatSession, session_id) is None:
            db.add(ChatSession(id=session_id))
        db.add(ChatMessage(session_id=session_id, role="user", content=user_message))
        db.add(ChatMessage(session_id=session_id, role="assistant", content=assistant_message))
        db.commit()
    finally:
        db.close()


def ensure_session(session_id: str) -> None:
    db = SessionLocal()
    try:
        if db.get(ChatSession, session_id) is None:
            db.add(ChatSession(id=session_id))
            db.commit()
    finally:
        db.close()


# —— 画像提取（仅当前会话，从对话文本提取，不单独落库） ——

def _extract_profile(texts: list[str]) -> dict:
    joined = " ".join(texts)
    profile: dict = {}
    m = re.search(r"(\d{2,3})\s*(?:cm|厘米)", joined)
    if m:
        profile["身高"] = m.group(1) + "cm"
    else:
        m = re.search(r"身高\s*(\d{2,3})", joined)
        if m:
            profile["身高"] = m.group(1) + "cm"
    m = re.search(r"(\d{2,3})\s*(?:kg|公斤)", joined)
    if m:
        profile["体重"] = m.group(1) + "kg"
    else:
        m = re.search(r"体重\s*(\d{2,3})", joined)
        if m:
            profile["体重"] = m.group(1) + "kg"
    for kw in ["梨形", "苹果形", "沙漏形", "小个子", "高个子"]:
        if kw in joined:
            profile["体型"] = kw
    # 性别/年龄段（PRD v1.3 首轮追问；确定性提取，年龄段需带"岁"避免与身高混淆）
    if "女" in joined:
        profile["性别"] = "女"
    elif "男" in joined:
        profile["性别"] = "男"
    m = re.search(r"(\d{2})\s*[-~到至]\s*(\d{2})\s*岁", joined)
    if m:
        profile["年龄段"] = f"{m.group(1)}~{m.group(2)}"
    else:
        m = re.search(r"(\d{2})\s*岁", joined)
        if m:
            profile["年龄段"] = f"{m.group(1)}岁"
    for kw in ["通勤", "休闲", "优雅", "运动", "甜美", "街头", "极简"]:
        if kw in joined:
            profile["风格"] = kw
    for kw in ["约会", "面试", "婚礼", "出游", "日常", "上班"]:
        if kw in joined:
            profile["场景"] = kw
    m = re.search(r"预算\s*(\d+)", joined)
    if m:
        profile["预算"] = int(m.group(1))
    return profile


def _split_text(text: str, size: int = 120) -> list[str]:
    """把长文本按句切块，模拟流式推送（MVP 简化，token 级流式留二期）。"""
    parts = re.split(r"(?<=[。！？\n])", text)
    chunks, buf = [], ""
    for p in parts:
        if len(buf) + len(p) > size and buf:
            chunks.append(buf)
            buf = p
        else:
            buf += p
    if buf:
        chunks.append(buf)
    return chunks or [text]


def _extract_product_ids_from_text(text: str) -> list[str]:
    """从方案文本提取「商品名」并映射为商品 ID（确定性，不依赖模型是否调用核查工具）。"""
    names = re.findall(r"「([^」]+)」(?=｜)", text)
    name_to_id = {p["name"]: p["id"] for p in catalog.PRODUCTS}
    return [name_to_id[n] for n in names if n in name_to_id]


def _season_of(d: date) -> str:
    m = d.month
    if m in (3, 4, 5):
        return "春季"
    if m in (6, 7, 8):
        return "夏季"
    if m in (9, 10, 11):
        return "秋季"
    return "冬季"


def build_system_prompt(budget: str = "") -> str:
    today = date.today()
    season = _season_of(today)
    prompt = SYSTEM_PROMPT + (
        f"\n\n（环境信息：今天是 {today.year} 年 {today.month} 月 {today.day} 日，当前季节约 {season}。"
        "用户未说明季节时，默认按当前季节推荐，无需追问季节。）"
    )
    if budget:
        prompt += (
            f"\n\n（用户已在界面选择了预算：整套 {budget} 元以内。这是硬性约束，必须严格遵守、不能超预算，"
            "并且绝对不能再向用户追问预算，直接按此预算出方案。）"
        )
    return prompt


def _stream_worker(messages, tools, q, loop):
    try:
        for kind, payload in llm.stream_chat(messages, tools):
            loop.call_soon_threadsafe(q.put_nowait, (kind, payload))
    except llm.LLMError as e:
        loop.call_soon_threadsafe(q.put_nowait, ("__error__", e))
    except Exception:
        loop.call_soon_threadsafe(q.put_nowait, ("__error__", llm.LLMError("LLM_INTERNAL", "模型调用内部错误")))
    finally:
        loop.call_soon_threadsafe(q.put_nowait, ("__end__", None))


async def _run_turn(messages, tools) -> tuple[str, list | None]:
    """执行一轮模型调用：缓冲收集完整输出，成功才返回 (文本, 工具调用)；失败静默重试。

    绝不把半截内容或错误展示给用户：每次尝试先缓冲，完整成功后才返回。
    """
    loop = asyncio.get_running_loop()
    last_err: llm.LLMError | None = None
    for attempt in range(settings.llm_retries + 1):
        q = asyncio.Queue()
        threading.Thread(target=_stream_worker, args=(messages, tools, q, loop), daemon=True).start()
        text_parts: list[str] = []
        tool_calls = None
        err = None
        while True:
            kind, payload = await q.get()
            if kind == "__error__":
                err = payload
                break
            if kind == "__end__":
                break
            if kind == "text":
                text_parts.append(payload)
            elif kind == "tool_calls":
                tool_calls = payload
        if err is None:
            return "".join(text_parts), tool_calls
        last_err = err
        if attempt < settings.llm_retries:
            await asyncio.sleep(0.5 * (attempt + 1))
    raise last_err  # type: ignore[misc]


async def run_agent_events(session_id: str, user_message: str, budget: str = "", scene: str = "") -> AsyncIterator[dict]:
    # 1. 写入类动作：确定性拒绝，不交给模型（强制底线 5）
    if permissions.detect_write_request(user_message):
        for chunk in _split_text(permissions.REFUSAL_TEXT):
            yield {"type": "text", "content": chunk}
        save_history(session_id, user_message, permissions.REFUSAL_TEXT)
        yield {"type": "done", "session_id": session_id, "content": permissions.REFUSAL_TEXT,
               "outcome": "refusal"}
        return

    # 2. 组装上下文（画像只从用户消息提取，避免助手自己的追问文本污染体型/性别等字段）
    history = await asyncio.to_thread(load_history, session_id)
    profile = _extract_profile([m["content"] for m in history if m["role"] == "user"] + [user_message])
    messages: list[dict] = [{"role": "system", "content": build_system_prompt(budget)}]
    messages.extend(history)
    messages.append({"role": "user", "content": user_message})

    # 3. Agent 循环（内部含工具调用的步骤不下发文本，只下发最终方案）
    final_text: str | None = None
    recommended_ids: list[str] = []  # 方案最终引用的商品 ID（供 VTO 试穿使用）
    yield {"type": "status", "message": "正在为你搭配…"}
    for step in range(settings.max_agent_steps):
        step_text, tool_calls = await _run_turn(messages, tools.TOOLS)

        if tool_calls:
            messages.append({
                "role": "assistant",
                "content": step_text,
                "tool_calls": tool_calls,
            })
            for tc in tool_calls:
                name = tc["function"]["name"]
                perm = permissions.check_tool_permission(name)
                if perm != "allow":
                    tool_result = {"error": {"code": "PERMISSION_DENIED", "message": "该操作未被授权"}}
                else:
                    try:
                        args = json.loads(tc["function"]["arguments"] or "{}")
                    except json.JSONDecodeError:
                        args = {}
                    tool_result = await asyncio.to_thread(
                        tools.execute_tool, name, args, {"profile": profile}
                    )
                    if name == "validate_product_references" and isinstance(tool_result, dict):
                        valid = tool_result.get("valid") or []
                        if valid:
                            recommended_ids = valid
                messages.append({
                    "role": "tool",
                    "tool_call_id": tc["id"],
                    "content": json.dumps(tool_result, ensure_ascii=False),
                })
            continue

        final_text = step_text
        break

    if final_text is None:
        raise llm.LLMError("AGENT_STEP_LIMIT", "本次搭配未能完成，请查看请求状态后再试")
    if not final_text.strip():
        raise llm.LLMError("EMPTY_LLM_RESULT", "模型没有返回可用内容，请稍后重试")

    # 4. 安全钩子（承诺试穿拦截 + 编造商品核查）
    final_text = hooks.apply_all(final_text)

    # 从最终方案文本提取推荐商品 ID（确定性，供 VTO 试穿使用；工具核查结果为空时兜底）
    if not recommended_ids:
        recommended_ids = _extract_product_ids_from_text(final_text)

    # 最终文本在此统一下发（分块保持流式观感）；内部含工具调用的步骤不下发，避免把中间话术展示给用户
    for chunk in _split_text(final_text, 60):
        yield {"type": "text", "content": chunk}

    # 5. 生成需求信号草稿（PRD v1.3：方案/调整后自动生成，供运营人工上传；有商品引用才生成）
    signal_id = None
    if recommended_ids:
        signal_id = await asyncio.to_thread(
            signals.generate_or_update_signal,
            session_id, user_message, recommended_ids, profile, scene,
        )

    # 6. 持久化
    await asyncio.to_thread(save_history, session_id, user_message, final_text)
    yield {"type": "done", "session_id": session_id, "content": final_text,
           "product_ids": recommended_ids, "signal_id": signal_id,
           "outcome": "recommendation" if recommended_ids else "clarification"}
