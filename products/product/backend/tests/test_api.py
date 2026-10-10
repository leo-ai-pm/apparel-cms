from fastapi.testclient import TestClient

from app.main import app


def test_health(db):
    with TestClient(app) as c:
        r = c.get("/health")
        assert r.status_code == 200
        assert r.json() == {"status": "ok"}


def test_validation_error_format(db):
    with TestClient(app) as c:
        r = c.post("/api/drafts/1/publish", json={})
        assert r.status_code == 422
        body = r.json()
        assert body["error"]["code"] == "INVALID_INPUT"
        assert "message" in body["error"]


def test_not_found_format(db):
    with TestClient(app) as c:
        r = c.get("/api/drafts/999")
        assert r.status_code == 404
        assert r.json() == {"error": {"code": "DRAFT_NOT_FOUND", "message": "草稿不存在或已回传"}}


def test_static_index_served(db):
    with TestClient(app) as c:
        r = c.get("/")
        assert r.status_code == 200
        assert "产品需求 Agent" in r.text


def test_save_draft_persists_without_publishing(db, make_signal):
    from app.services import store
    from app.services.aggregate import aggregate

    draft_id = store.create_draft(aggregate([make_signal("SIG-SAVE", "intent")]))
    with TestClient(app) as c:
        response = c.patch(f"/api/drafts/{draft_id}", json={
            "requirement_desc": " 保存后继续整理 ",
            "constraints": ["预算500以内"], "style_demand": True,
        })
        assert response.status_code == 200
        assert response.json()["package_id"] is None
    # 新应用生命周期 / 新数据库连接仍能恢复人工编辑。
    with TestClient(app) as c:
        saved = c.get(f"/api/drafts/{draft_id}").json()
        assert saved["requirement_desc"] == "保存后继续整理"
        assert saved["attribution"]["style_demand"] is True
        assert saved["dedup_key"].endswith("真实需求")
        assert saved["constraints"] == ["预算500以内"]
        assert c.get("/api/packages").json() == {"packages": []}
    assert store.get_processed_signal_ids() == set()


def test_save_missing_draft_is_not_recreated(db):
    with TestClient(app) as c:
        response = c.patch("/api/drafts/999", json={"requirement_desc": "test"})
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "DRAFT_NOT_FOUND"
