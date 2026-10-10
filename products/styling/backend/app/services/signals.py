"""需求信号服务（PRD v1.3 第 12 节 + P0《数据契约》2.1/3 节）。

职责：
1. 方案生成后，确定性组装一条「需求信号草稿」落 SQLite（同 session 只保留一条 draft，每轮 upsert）。
2. 运营上传时：脱敏 → POST CMS /api/signals（重试 3 次）→ 标记 uploaded。

信号字段全部由确定性代码组装，不调用模型（避免模型自由发挥产生脏字段）。
"""
import json
import re
import time
from datetime import datetime

import httpx

from app.core.config import settings
from app.core.database import SessionLocal
from app.models.signal import STATUS_DRAFT, STATUS_UPLOADED, SignalDraft
from app.models.tryon import utcnow
from app.schemas.signal import FEEDBACK_TYPES

# —— 脱敏（确定性正则清洗，与 CMS 侧兜底规则一致）——
_MOBILE_RE = re.compile(r"1[3-9]\d{9}")
_ID_CARD_RE = re.compile(r"\d{17}[\dXx]|\d{15}")
_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
_ACCOUNT_RE = re.compile(
    r"(?:账号|帐号|account|user_?id|uid)\s*[:：=]?\s*[A-Za-z0-9_-]{4,}",
    re.IGNORECASE,
)


def desensitize(text: str) -> str:
    """把疑似身份字段替换为 [已脱敏]，确保离开穿搭 Agent 前不泄露 PII。"""
    if not text:
        return ""
    t = _MOBILE_RE.sub("[已脱敏]", text)
    t = _ID_CARD_RE.sub("[已脱敏]", t)
    t = _EMAIL_RE.sub("[已脱敏]", t)
    t = _ACCOUNT_RE.sub("[已脱敏]", t)
    return t


# —— 枚举映射（穿搭侧中文场景 → P0 英文枚举）——
def scene_to_enum(scene_cn: str) -> str:
    s = scene_cn or ""
    if any(k in s for k in ["出游", "旅行", "旅游", "玩"]):
        return "outing"
    if any(k in s for k in ["约会", "聚会"]):
        return "dating_party"
    if any(k in s for k in ["居家", "在家"]):
        return "home"
    if "运动" in s:
        return "sport"
    return "commute"  # 通勤/上班/面试/日常/工作 → commute


def season_of_today() -> str:
    m = datetime.now().month
    if m in (3, 4, 5):
        return "春"
    if m in (6, 7, 8):
        return "夏"
    if m in (9, 10, 11):
        return "秋"
    return "冬"


# —— 字段组装 ——
def _build_preference(profile: dict) -> str:
    parts = []
    if profile.get("风格"):
        parts.append(profile["风格"])
    if profile.get("场景"):
        parts.append(profile["场景"])
    if profile.get("预算"):
        parts.append(f"预算{profile['预算']}元以内")
    return "、".join(parts) if parts else "未明确偏好"


def _build_body_type_tag(profile: dict) -> str:
    shape = profile.get("体型", "")
    height = profile.get("身高", "")
    if shape and height:
        return f"{shape}-{height}"
    return shape or height or ""


def _build_user_tag(profile: dict, scene_cn: str) -> str:
    gender = profile.get("性别") or "未标"
    age = profile.get("年龄段") or "未标"
    scene = scene_cn or "通勤"
    return f"{gender}-{age}-{scene}"


def _build_items(db, product_ids: list[str]) -> list[dict]:
    from app.models.product import Product

    items: list[dict] = []
    seen: set[str] = set()
    for pid in product_ids:
        if not pid or pid in seen:
            continue
        p = db.get(Product, pid)
        if p is None:
            continue
        seen.add(pid)
        items.append({"product_id": p.product_id, "name": p.name, "category": p.category})
    return items


def _next_signal_id(db) -> str:
    today = datetime.now().strftime("%Y%m%d")
    prefix = f"SIG-{today}-"
    count = db.query(SignalDraft).filter(SignalDraft.signal_id.like(prefix + "%")).count()
    return f"{prefix}{count + 1:04d}"


def generate_or_update_signal(
    session_id: str,
    user_message: str,
    recommended_ids: list[str],
    profile: dict,
    scene_cn: str,
) -> str | None:
    """方案生成后生成/更新草稿信号，返回 signal_id。"""
    db = SessionLocal()
    try:
        existing = (
            db.query(SignalDraft)
            .filter_by(session_id=session_id, status=STATUS_DRAFT)
            .order_by(SignalDraft.created_at.desc())
            .first()
        )
        items = _build_items(db, recommended_ids)
        outfit_plan = {"items": items, "note": f"{scene_cn or '通勤'}场景搭配"}
        now_iso = datetime.now().astimezone().isoformat(timespec="seconds")
        scene_enum = scene_to_enum(scene_cn)
        preference = _build_preference(profile)
        body_type_tag = _build_body_type_tag(profile)
        user_tag = _build_user_tag(profile, scene_cn)

        if existing is not None:
            existing.timestamp = now_iso
            existing.scene = scene_enum
            existing.season = season_of_today()
            existing.preference = preference
            existing.body_type_tag = body_type_tag
            existing.change_reason = user_message  # 调整轮：最近一条用户消息即换搭理由
            existing.outfit_plan_json = json.dumps(outfit_plan, ensure_ascii=False)
            existing.user_tag = user_tag
            db.commit()
            refresh_draft_cart(session_id)
            return existing.signal_id

        signal_id = _next_signal_id(db)
        draft = SignalDraft(
            signal_id=signal_id,
            session_id=session_id,
            source_agent="outfit",
            timestamp=now_iso,
            scene=scene_enum,
            season=season_of_today(),
            preference=preference,
            body_type_tag=body_type_tag,
            change_reason="",  # 首轮方案无换搭理由
            outfit_plan_json=json.dumps(outfit_plan, ensure_ascii=False),
            feedback_type="",
            user_tag=user_tag,
            status=STATUS_DRAFT,
        )
        db.add(draft)
        db.commit()
        refresh_draft_cart(session_id)
        return signal_id
    finally:
        db.close()


def refresh_draft_cart(session_id: str) -> None:
    """根据当前加购项，同步草稿信号的 note（用户加购：XX）与 feedback_type（有加购→simulated_cart）。"""
    from app.models.cart import CartItem
    from app.models.product import Product

    db = SessionLocal()
    try:
        draft = (
            db.query(SignalDraft)
            .filter_by(session_id=session_id, status=STATUS_DRAFT)
            .order_by(SignalDraft.created_at.desc())
            .first()
        )
        if draft is None:
            return
        cart_ids = [r.product_id for r in db.query(CartItem).filter_by(session_id=session_id).order_by(CartItem.created_at.asc()).all()]
        names: list[str] = []
        for pid in cart_ids:
            p = db.get(Product, pid)
            if p is not None:
                names.append(p.name)
        plan = json.loads(draft.outfit_plan_json or "{}")
        # 去掉旧的"用户加购"后缀，避免重复追加
        note = re.sub(r"；?\s*用户加购[：:].*$", "", plan.get("note", "") or "").rstrip("；")
        if names:
            note = f"{note}；用户加购：{'、'.join(names)}".lstrip("；")
            draft.feedback_type = "simulated_cart"
        elif draft.feedback_type == "simulated_cart":
            draft.feedback_type = ""
        plan["note"] = note
        draft.outfit_plan_json = json.dumps(plan, ensure_ascii=False)
        db.commit()
    finally:
        db.close()


def to_dict(d: SignalDraft) -> dict:
    return {
        "signal_id": d.signal_id,
        "session_id": d.session_id,
        "source_agent": d.source_agent,
        "timestamp": d.timestamp,
        "scene": d.scene,
        "season": d.season,
        "preference": d.preference,
        "body_type_tag": d.body_type_tag,
        "change_reason": d.change_reason,
        "outfit_plan": json.loads(d.outfit_plan_json or "{}"),
        "feedback_type": d.feedback_type,
        "user_tag": d.user_tag,
        "status": d.status,
        "uploaded_at": d.uploaded_at.isoformat() if d.uploaded_at else None,
    }


def list_signals(session_id: str) -> list[dict]:
    db = SessionLocal()
    try:
        rows = (
            db.query(SignalDraft)
            .filter_by(session_id=session_id)
            .order_by(SignalDraft.created_at.desc())
            .all()
        )
        return [to_dict(r) for r in rows]
    finally:
        db.close()


def _build_payload(draft: SignalDraft, feedback_type: str) -> dict:
    plan = json.loads(draft.outfit_plan_json or "{}")
    note = desensitize(plan.get("note", ""))
    return {
        "signal_id": draft.signal_id,
        "source_agent": "outfit",
        "timestamp": draft.timestamp,
        "scene": draft.scene,
        "season": draft.season or None,
        "preference": desensitize(draft.preference),
        "body_type_tag": desensitize(draft.body_type_tag) or None,
        "change_reason": desensitize(draft.change_reason) or None,
        "outfit_plan": {
            "items": plan.get("items", []),
            "note": note or None,
        },
        "feedback_type": feedback_type,
        "user_tag": desensitize(draft.user_tag),
    }


def _post_to_cms(payload: dict) -> tuple[dict | None, dict | None]:
    """POST CMS /api/signals；返回 (响应体, None) 或 (None, 错误 dict)。"""
    if not settings.cms_base_url or not settings.cms_api_key:
        return None, {"code": "CMS_NOT_CONFIGURED", "message": "CMS 未配置，请先填写 CMS_BASE_URL 与 CMS_API_KEY"}
    url = settings.cms_base_url.rstrip("/") + "/api/signals"
    headers = {"X-API-Key": settings.cms_api_key, "Content-Type": "application/json"}
    last_err: dict | None = None
    for attempt in range(settings.cms_signal_retries + 1):
        try:
            resp = httpx.post(url, json=payload, headers=headers, timeout=settings.cms_timeout)
        except httpx.HTTPError:
            last_err = {"code": "CMS_UNREACHABLE", "message": "无法连接 CMS，请稍后重试"}
        else:
            if resp.status_code in (200, 201):
                try:
                    return resp.json(), None
                except json.JSONDecodeError:
                    return None, {"code": "CMS_BAD_RESPONSE", "message": "CMS 返回内容无法解析"}
            body = {}
            try:
                body = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
            except json.JSONDecodeError:
                body = {}
            err = body.get("error") or {}
            code = err.get("code", "CMS_ERROR")
            message = err.get("message", f"CMS 返回 {resp.status_code}")
            if resp.status_code in (401, 403, 422):
                # 鉴权/校验/脱敏拒绝，重试无意义
                return None, {"code": code, "message": message}
            last_err = {"code": code, "message": message}
        if attempt < settings.cms_signal_retries:
            time.sleep(0.5 * (attempt + 1))
    return None, last_err or {"code": "CMS_ERROR", "message": "上传 CMS 失败"}


def upload_signal(signal_id: str, feedback_type: str) -> dict:
    """上传草稿信号到 CMS。成功返回 {signal, idempotent}，失败返回 {error}。"""
    if feedback_type not in FEEDBACK_TYPES:
        return {"error": {"code": "INVALID_FEEDBACK_TYPE", "message": "需求类型枚举非法"}}
    db = SessionLocal()
    try:
        draft = db.get(SignalDraft, signal_id)
        if draft is None:
            return {"error": {"code": "NOT_FOUND", "message": "需求信号不存在"}}
        if draft.status == STATUS_UPLOADED:
            return {"signal": to_dict(draft), "idempotent": True}

        payload = _build_payload(draft, feedback_type)
        _, err = _post_to_cms(payload)
        if err is not None:
            return {"error": err}

        draft.feedback_type = feedback_type
        draft.status = STATUS_UPLOADED
        draft.uploaded_at = utcnow()
        db.commit()
        return {"signal": to_dict(draft), "idempotent": False}
    finally:
        db.close()
