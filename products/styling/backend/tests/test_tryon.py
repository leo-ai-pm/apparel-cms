"""VTO 试穿接口与图片校验的 mock 测试（无需真实图片模型 Key）。"""
import time
from pathlib import Path

import pytest

from app.services import tryon as tryon_svc
from app.services import tudou
from app.services.tudou import TudouError

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def _png():
    return PNG_MAGIC + b"fakepngcontent"


def _make_garment(product_id="P001"):
    d = tryon_svc.PRODUCT_IMAGE_DIR
    d.mkdir(parents=True, exist_ok=True)
    p = d / f"{product_id}.png"
    p.write_bytes(_png())
    return str(p)


@pytest.fixture(autouse=True)
def _clean_dirs():
    """每个测试前清空上传/商品图/结果目录，避免测试间互相影响。"""
    for d in (tryon_svc.UPLOAD_DIR, tryon_svc.PRODUCT_IMAGE_DIR, tryon_svc.RESULT_DIR):
        if d.exists():
            for f in d.iterdir():
                if f.is_file():
                    f.unlink()
    yield


# —— 纯函数：图片校验 ——

def test_sniff_image_types():
    assert tryon_svc.sniff_image_type(PNG_MAGIC + b"x") == "image/png"
    assert tryon_svc.sniff_image_type(b"\xff\xd8\xff" + b"x") == "image/jpeg"
    assert tryon_svc.sniff_image_type(b"RIFFxxxxWEBP") == "image/webp"
    assert tryon_svc.sniff_image_type(b"garbage") is None


def test_validate_photo():
    assert tryon_svc.validate_photo(b"")[0] == "EMPTY_FILE"
    assert tryon_svc.validate_photo(b"garbage")[0] == "INVALID_IMAGE"
    assert tryon_svc.validate_photo(PNG_MAGIC + b"0" * (5 * 1024 * 1024))[0] == "IMAGE_TOO_LARGE"
    assert tryon_svc.validate_photo(_png()) == (None, None)


def test_parse_product_ids():
    assert tryon_svc.parse_product_ids("P001,P007") == ["P001", "P007"]
    assert tryon_svc.parse_product_ids("P001，P007") == ["P001", "P007"]
    assert tryon_svc.parse_product_ids("  ") == []


def test_normalize_photo_pads_tall_image(tmp_path):
    from PIL import Image

    src = tmp_path / "tall.png"
    Image.new("RGB", (1290, 2796), (200, 180, 160)).save(src)
    dst = tmp_path / "norm.jpg"
    tryon_svc.normalize_photo(str(src), str(dst))
    img = Image.open(dst)
    assert abs(img.size[0] / img.size[1] - 0.75) < 0.01  # 填充到 3:4


def test_resolve_garment_top_priority():
    from app.core.database import SessionLocal

    db = SessionLocal()
    try:
        pid, path = tryon_svc.resolve_garment(["P007", "P001"], db)  # P001 是上装
        assert pid == "P001"
        assert path.endswith("P001.png")
    finally:
        db.close()


def test_resolve_garment_fallback_to_first():
    from app.core.database import SessionLocal

    db = SessionLocal()
    try:
        pid, _ = tryon_svc.resolve_garment(["P007"], db)  # 无上装 → 取第一个
        assert pid == "P007"
        assert tryon_svc.resolve_garment(["P999"], db) == (None, None)
        assert tryon_svc.resolve_garment([], db) == (None, None)
    finally:
        db.close()


# —— 接口：提交与查询 ——


def test_build_tryon_instruction():
    from app.core.database import SessionLocal

    db = SessionLocal()
    try:
        products = tryon_svc.resolve_outfit_products(["P001", "P007", "P011"], db)
        assert len(products) >= 2  # 上装 + 下装
        assert products[0].product_id == "P001"  # 优先上装
        p = tryon_svc.build_tryon_instruction(products, "通勤")
        assert "白色基础衬衫" in p
        assert "保持" in p  # 保持脸不变
        assert "图2" in p and "图3" in p  # 多张商品参考图
    finally:
        db.close()


def test_create_tryon_unknown_product(client):
    r = client.post("/api/v1/tryon",
                    files={"photo": ("a.png", _png(), "image/png")},
                    data={"product_ids": "P999"})
    assert r.status_code == 404


@pytest.fixture()
def tudou_mock(monkeypatch):
    """mock 掉 tudou.generate_tryon_image。"""
    state = {"calls": 0, "result": _png()}

    def fake_generate(photo_bytes, garment_images, instruction):
        state["calls"] += 1
        return state["result"]

    monkeypatch.setattr(tudou, "generate_tryon_image", fake_generate)
    return state


def _wait_status(client, task_id, timeout=5.0):
    for _ in range(int(timeout * 20)):
        body = client.get(f"/api/v1/tryon/{task_id}").json()
        if body.get("status") != "processing":
            return body
        time.sleep(0.05)
    return client.get(f"/api/v1/tryon/{task_id}").json()


def test_create_tryon_success(client, tudou_mock):
    _make_garment("P001")
    _make_garment("P007")
    r = client.post("/api/v1/tryon",
                    files={"photo": ("a.png", _png(), "image/png")},
                    data={"product_ids": "P001,P007", "scene": "通勤", "session_id": "s1"})
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "processing"
    assert body["garment_product_id"] == "P001"
    assert body["task_id"]
    # 后台线程完成 → succeeded
    b2 = _wait_status(client, body["task_id"])
    assert b2["status"] == "succeeded"
    assert tudou_mock["calls"] == 1


def test_create_tryon_invalid_photo(client):
    r = client.post("/api/v1/tryon",
                    files={"photo": ("a.txt", b"garbage", "text/plain")},
                    data={"product_ids": "P001"})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "INVALID_IMAGE"


def test_get_tryon_not_found(client):
    r = client.get("/api/v1/tryon/nonexistent")
    assert r.status_code == 404


def test_get_tryon_success_and_photo_deleted(client, tudou_mock):
    _make_garment("P001")
    r = client.post("/api/v1/tryon",
                    files={"photo": ("a.png", _png(), "image/png")},
                    data={"product_ids": "P001", "scene": "出游"})
    task_id = r.json()["task_id"]
    body = _wait_status(client, task_id)
    assert body["status"] == "succeeded"
    assert body["result_url"] == f"/tryon-results/{task_id}.png"
    # 原始照片已删除（PRD 第 6 节）
    assert not any(tryon_svc.UPLOAD_DIR.iterdir())


def test_get_tryon_failed(client, monkeypatch):
    _make_garment("P001")

    def fake_generate_fail(photo_bytes, garment_images, instruction):
        raise TudouError("API_ERROR", "生成失败")

    monkeypatch.setattr(tudou, "generate_tryon_image", fake_generate_fail)
    r = client.post("/api/v1/tryon",
                    files={"photo": ("a.png", _png(), "image/png")},
                    data={"product_ids": "P001"})
    task_id = r.json()["task_id"]
    body = _wait_status(client, task_id)
    assert body["status"] == "failed"
    assert body["error"]["code"] == "API_ERROR"
    assert not any(tryon_svc.UPLOAD_DIR.iterdir())


def test_restart_reconciles_saved_image_without_calling_model(monkeypatch):
    from PIL import Image
    from app.api.tryon import recover_interrupted_generations
    from app.core.database import SessionLocal
    from app.models.tryon import TryonTask

    monkeypatch.setattr(tudou, "generate_tryon_image", lambda *a: pytest.fail("restart must not re-bill"))
    tryon_svc.ensure_dirs()
    Image.new("RGB", (10, 10), "white").save(tryon_svc.result_path_for("restart-saved"))
    photo = tryon_svc.UPLOAD_DIR / "restart-private.png"
    photo.write_bytes(_png())
    with SessionLocal() as db:
        db.add(TryonTask(id="restart-saved", status="processing", photo_path=str(photo)))
        db.add(TryonTask(id="restart-pending", status="processing", photo_path=str(photo)))
        db.commit()
    assert recover_interrupted_generations() >= 2
    with SessionLocal() as db:
        saved = db.get(TryonTask, "restart-saved")
        pending = db.get(TryonTask, "restart-pending")
        assert saved.status == "succeeded"
        assert saved.result_url == "/tryon-results/restart-saved.png"
        assert pending.status == "failed"
        assert pending.error_code == "GENERATION_INTERRUPTED"
        assert not pending.photo_path
    assert not photo.exists()
    assert recover_interrupted_generations() == 0


def test_restart_does_not_report_partial_image_as_success(monkeypatch):
    from app.api.tryon import recover_interrupted_generations
    from app.core.database import SessionLocal
    from app.models.tryon import TryonTask

    monkeypatch.setattr(tudou, "generate_tryon_image", lambda *a: pytest.fail("restart must not re-bill"))
    tryon_svc.ensure_dirs()
    Path(tryon_svc.result_path_for("restart-broken")).write_bytes(_png())
    partial = Path(tryon_svc.result_path_for("restart-broken") + ".partial")
    partial.write_bytes(b"incomplete")
    with SessionLocal() as db:
        db.add(TryonTask(id="restart-broken", status="processing"))
        db.commit()
    recover_interrupted_generations()
    with SessionLocal() as db:
        assert db.get(TryonTask, "restart-broken").status == "failed"
    assert not partial.exists()
