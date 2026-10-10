"""模拟加购（PRD v1.3 feedback_type=simulated_cart）mock 测试。"""
import json

from app.services import cart, signals


def test_cart_add_get_remove():
    sid = "c1"
    assert cart.get_cart_ids(sid) == []
    assert cart.add(sid, "P001") == ["P001"]
    assert cart.add(sid, "P008") == ["P001", "P008"]
    # 幂等：重复加购不产生重复记录
    assert cart.add(sid, "P001") == ["P001", "P008"]
    assert cart.remove(sid, "P001") == ["P008"]
    assert cart.get_cart_ids(sid) == ["P008"]


def test_cart_refreshes_draft_note_and_feedback():
    sid = "c2"
    sig = signals.generate_or_update_signal(sid, "通勤装", ["P001", "P007"], {}, "通勤")
    cart.add(sid, "P001")
    db = signals.SessionLocal()
    try:
        from app.models.signal import SignalDraft
        row = db.get(SignalDraft, sig)
        plan = json.loads(row.outfit_plan_json)
        assert "用户加购" in plan["note"]
        assert "白色基础衬衫" in plan["note"]
        assert row.feedback_type == "simulated_cart"
    finally:
        db.close()


def test_cart_remove_last_clears_feedback():
    sid = "c3"
    sig = signals.generate_or_update_signal(sid, "通勤装", ["P001", "P007"], {}, "通勤")
    cart.add(sid, "P001")
    cart.remove(sid, "P001")
    db = signals.SessionLocal()
    try:
        from app.models.signal import SignalDraft
        row = db.get(SignalDraft, sig)
        plan = json.loads(row.outfit_plan_json)
        assert "用户加购" not in plan["note"]
        assert row.feedback_type in ("", "intent")
    finally:
        db.close()


def test_cart_api(client):
    sid = "c4"
    signals.generate_or_update_signal(sid, "通勤装", ["P001"], {}, "通勤")
    r = client.post("/api/v1/cart", json={"session_id": sid, "product_id": "P001"})
    assert r.status_code == 200
    assert r.json()["cart"] == ["P001"]
    r = client.get("/api/v1/cart", params={"session_id": sid})
    assert r.status_code == 200
    assert r.json()["cart"] == ["P001"]
    r = client.delete("/api/v1/cart/P001", params={"session_id": sid})
    assert r.status_code == 200
    assert r.json()["cart"] == []
