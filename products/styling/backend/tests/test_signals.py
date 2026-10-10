"""需求信号（PRD v1.3）mock 测试：映射、脱敏、草稿 upsert、上传幂等/重试、接口。"""
import json

import pytest

from app.core.config import settings
from app.services import signals
from app.services.signals import desensitize, scene_to_enum, season_of_today


# —— 纯函数：枚举映射 ——

def test_scene_to_enum():
    assert scene_to_enum("通勤") == "commute"
    assert scene_to_enum("出游") == "outing"
    assert scene_to_enum("约会聚会") == "dating_party"
    assert scene_to_enum("居家") == "home"
    assert scene_to_enum("运动") == "sport"
    assert scene_to_enum("") == "commute"
    assert scene_to_enum("周末出去玩") == "outing"


def test_season_of_today_valid():
    assert season_of_today() in {"春", "夏", "秋", "冬"}


# —— 纯函数：脱敏 ——

def test_desensitize_strips_pii():
    assert "13812345678" not in desensitize("电话13812345678联系我")
    assert "@" not in desensitize("邮箱abc@example.com谢谢")
    assert "110101199001011234" not in desensitize("身份证110101199001011234")
    assert "account" not in desensitize("账号 account:abcd1234 请查")
    assert desensitize("普通偏好描述") == "普通偏好描述"
    assert desensitize("") == ""


# —— 草稿生成/更新 ——

def test_generate_and_upsert_signal():
    profile = {"性别": "女", "年龄段": "25~30", "身高": "160cm", "体型": "梨形", "风格": "通勤", "预算": 500}
    sid1 = signals.generate_or_update_signal("s1", "通勤装", ["P001", "P007"], profile, "通勤")
    assert sid1.startswith("SIG-")

    db = signals.SessionLocal()
    try:
        from app.models.signal import SignalDraft
        row = db.get(SignalDraft, sid1)
        assert row is not None
        assert row.source_agent == "outfit"
        assert row.scene == "commute"
        assert row.season in {"春", "夏", "秋", "冬"}
        assert row.user_tag == "女-25~30-通勤"
        assert row.body_type_tag == "梨形-160cm"
        assert row.status == "draft"
        plan = json.loads(row.outfit_plan_json)
        cats = {i["product_id"]: i["category"] for i in plan["items"]}
        assert cats["P001"] == "上装"
        assert cats["P007"] == "下装"
    finally:
        db.close()

    # 同一 session 再生成 → 更新同一条（signal_id 不变）
    sid2 = signals.generate_or_update_signal("s1", "换成更利落的裤装", ["P001", "P008"], profile, "通勤")
    assert sid2 == sid1
    db = signals.SessionLocal()
    try:
        from app.models.signal import SignalDraft
        row = db.get(SignalDraft, sid1)
        assert row.change_reason == "换成更利落的裤装"
    finally:
        db.close()


def test_signal_skips_unknown_products():
    profile = {}
    sid = signals.generate_or_update_signal("s2", "来一套", ["P999", "P001"], profile, "通勤")
    db = signals.SessionLocal()
    try:
        from app.models.signal import SignalDraft
        row = db.get(SignalDraft, sid)
        plan = json.loads(row.outfit_plan_json)
        assert [i["product_id"] for i in plan["items"]] == ["P001"]
    finally:
        db.close()


# —— 上传 ——

class _FakeResp:
    def __init__(self, status_code, body):
        self.status_code = status_code
        self._body = body
        self.headers = {"content-type": "application/json"}

    def json(self):
        return self._body


def test_upload_without_cms_config():
    sid = signals.generate_or_update_signal("s3", "来一套", ["P001"], {}, "通勤")
    result = signals.upload_signal(sid, "intent")
    assert result["error"]["code"] == "CMS_NOT_CONFIGURED"


def test_upload_invalid_feedback_type():
    sid = signals.generate_or_update_signal("s4", "来一套", ["P001"], {}, "通勤")
    result = signals.upload_signal(sid, "bogus")
    assert result["error"]["code"] == "INVALID_FEEDBACK_TYPE"


def test_upload_success_and_idempotent(monkeypatch):
    monkeypatch.setattr(settings, "cms_base_url", "http://cms.test")
    monkeypatch.setattr(settings, "cms_api_key", "outfit-key")
    sent = {}

    def fake_post(url, json=None, headers=None, timeout=None):
        sent["url"] = url
        sent["headers"] = headers
        sent["payload"] = json
        return _FakeResp(201, {"signal_id": json["signal_id"], "status": "uploaded"})

    monkeypatch.setattr(signals.httpx, "post", fake_post)

    sid = signals.generate_or_update_signal("s5", "通勤装", ["P001", "P007"], {"性别": "女"}, "通勤")
    result = signals.upload_signal(sid, "intent")
    assert "error" not in result
    assert result["idempotent"] is False
    assert result["signal"]["status"] == "uploaded"
    assert result["signal"]["feedback_type"] == "intent"

    # 断言发往 CMS 的 payload 结构正确且脱敏
    payload = sent["payload"]
    assert sent["url"] == "http://cms.test/api/signals"
    assert sent["headers"]["X-API-Key"] == "outfit-key"
    assert payload["source_agent"] == "outfit"
    assert payload["scene"] == "commute"
    assert payload["feedback_type"] == "intent"
    assert payload["outfit_plan"]["items"][0]["category"] == "上装"
    assert payload["user_tag"] == "女-未标-通勤"

    # 重复上传 → 幂等，不再发请求
    sent.clear()
    result2 = signals.upload_signal(sid, "intent")
    assert result2["idempotent"] is True
    assert not sent


def test_upload_payload_desensitizes_change_reason(monkeypatch):
    """上传离开穿搭 Agent 前，free-text 字段（change_reason 等）必须脱敏。"""
    monkeypatch.setattr(settings, "cms_base_url", "http://cms.test")
    monkeypatch.setattr(settings, "cms_api_key", "outfit-key")
    captured = {}

    def fake_post(url, json=None, headers=None, timeout=None):
        captured["payload"] = json
        return _FakeResp(201, {"signal_id": json["signal_id"], "status": "uploaded"})

    monkeypatch.setattr(signals.httpx, "post", fake_post)

    # 同会话两轮：调整轮 change_reason = 含手机号的用户消息
    sid = signals.generate_or_update_signal("s6a", "通勤装", ["P001"], {}, "通勤")
    signals.generate_or_update_signal("s6a", "换裤子，打我电话13812345678", ["P001", "P008"], {}, "通勤")
    result = signals.upload_signal(sid, "intent")
    assert "error" not in result
    payload = captured["payload"]
    assert "13812345678" not in payload["change_reason"]
    assert "[已脱敏]" in payload["change_reason"]


def test_upload_retries_then_fails(monkeypatch):
    monkeypatch.setattr(settings, "cms_base_url", "http://cms.test")
    monkeypatch.setattr(settings, "cms_api_key", "outfit-key")
    calls = {"n": 0}

    def fake_post(url, json=None, headers=None, timeout=None):
        calls["n"] += 1
        return _FakeResp(500, {"error": {"code": "CMS_ERROR", "message": "boom"}})

    monkeypatch.setattr(signals.httpx, "post", fake_post)

    sid = signals.generate_or_update_signal("s6", "通勤装", ["P001"], {}, "通勤")
    result = signals.upload_signal(sid, "intent")
    assert result["error"]["code"] == "CMS_ERROR"
    assert calls["n"] == settings.cms_signal_retries + 1  # 首次 + 3 次重试
    # 失败后仍保持 draft，可重试
    db = signals.SessionLocal()
    try:
        from app.models.signal import SignalDraft
        assert db.get(SignalDraft, sid).status == "draft"
    finally:
        db.close()


# —— 接口 ——

def test_list_signals_api(client, monkeypatch):
    monkeypatch.setenv("STYLING_ADMIN_PASSWORD", "test-manager-password")
    monkeypatch.setenv("STYLING_ADMIN_SECRET", "test-signing-secret-" * 3)
    monkeypatch.setenv("STYLING_ADMIN_COOKIE_SECURE", "0")
    assert client.post("/api/v1/admin/login", json={"password": "test-manager-password"}).status_code == 200
    signals.generate_or_update_signal("s7", "通勤装", ["P001"], {}, "通勤")
    resp = client.get("/api/v1/signals", params={"session_id": "s7"})
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["signals"]) == 1
    assert data["signals"][0]["scene"] == "commute"


def test_upload_api_invalid_feedback(client, monkeypatch):
    monkeypatch.setenv("STYLING_ADMIN_PASSWORD", "test-manager-password")
    monkeypatch.setenv("STYLING_ADMIN_SECRET", "test-signing-secret-" * 3)
    monkeypatch.setenv("STYLING_ADMIN_COOKIE_SECURE", "0")
    assert client.post("/api/v1/admin/login", json={"password": "test-manager-password"}).status_code == 200
    sid = signals.generate_or_update_signal("s8", "通勤装", ["P001"], {}, "通勤")
    resp = client.post(f"/api/v1/signals/{sid}/upload", json={"feedback_type": "bogus"})
    assert resp.status_code == 400
    assert resp.json()["error"]["code"] == "INVALID_FEEDBACK_TYPE"
