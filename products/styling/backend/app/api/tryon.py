"""VTO 试穿接口：上传照片 + 生成试穿效果图（Gemini 图像编辑，单模型一步出图）。

- POST /api/v1/tryon          上传照片 + 商品 ID → 后台调用 Gemini 换装，返回 task_id
- GET  /api/v1/tryon          按会话列出试穿任务
- GET  /api/v1/tryon/{task_id} 查询任务状态
"""
from __future__ import annotations

import os
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, File, Form, UploadFile

from app.core.database import SessionLocal
from app.models.tryon import (
    STATUS_FAILED,
    STATUS_PROCESSING,
    STATUS_SUCCEEDED,
    TryonTask,
    to_dict,
)
from app.services import tudou, tryon as tryon_svc

router = APIRouter(prefix="/api/v1", tags=["tryon"])


def _utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _error(code: str, message: str, status_code: int):
    from fastapi.responses import JSONResponse

    return JSONResponse(status_code=status_code, content={"error": {"code": code, "message": message}})


@router.post("/tryon")
def create_tryon(
    photo: UploadFile = File(...),
    product_ids: str = Form(...),
    scene: str = Form(tryon_svc.DEFAULT_SCENE),
    session_id: str = Form(""),
):
    tryon_svc.ensure_dirs()

    # 1. 读照片 + 校验（真实类型 / 大小 / 非空）
    try:
        data = photo.file.read()
    except Exception:
        return _error("READ_FAILED", "照片读取失败，请重新上传", 400)
    code, msg = tryon_svc.validate_photo(data)
    if code:
        return _error(code, msg, 400)

    # 2. 解析商品 ID + 选试穿单品（优先上装）
    ids = tryon_svc.parse_product_ids(product_ids)
    if not ids:
        return _error("BAD_REQUEST", "缺少商品 ID，无法生成试穿效果", 400)

    db = SessionLocal()
    try:
        products = tryon_svc.resolve_outfit_products(ids, db)
        if not products:
            return _error("NOT_FOUND", "方案中的商品不存在，无法生成试穿效果", 404)
        garment_id = products[0].product_id
        # 取每件商品的参考图路径（白底商品图，传给 Gemini 保证款式准确）
        garment_paths = [str(tryon_svc.PRODUCT_IMAGE_DIR / f"{p.product_id}.png") for p in products]

        # 3. 持久化任务 + 临时照片（强制底线 2：状态落库可恢复）
        task_id = uuid.uuid4().hex
        mime = tryon_svc.sniff_image_type(data) or "image/jpeg"
        photo_path = tryon_svc.photo_path_for(task_id, mime)
        with open(photo_path, "wb") as f:
            f.write(data)

        instruction = tryon_svc.build_tryon_instruction(products, scene)

        task = TryonTask(
            id=task_id,
            session_id=(session_id or "").strip(),
            status=STATUS_PROCESSING,
            stage="done",
            product_ids=",".join(ids),
            garment_product_id=garment_id,
            scene=scene or tryon_svc.DEFAULT_SCENE,
            photo_path=photo_path,
        )
        db.add(task)
        db.commit()
    finally:
        db.close()

    # 4. 后台线程调用 Gemini 换装（同步约 30~60 秒，前端轮询 GET 拿结果）
    threading.Thread(target=_run_generation, args=(task_id, photo_path, garment_paths, instruction), daemon=True).start()

    return {"task_id": task_id, "status": STATUS_PROCESSING,
            "garment_product_id": garment_id, "scene": scene}


def _run_generation(task_id: str, photo_path: str, garment_paths: list[str], instruction: str) -> None:
    """后台线程：读照片 + 商品参考图 → 调 Gemini 换装 → 保存结果 → 更新任务。"""
    db = SessionLocal()
    try:
        task = db.get(TryonTask, task_id)
        if task is None:
            return
        with open(photo_path, "rb") as f:
            photo_bytes = f.read()
        garment_images = []
        for gp in garment_paths:
            with open(gp, "rb") as f:
                garment_images.append(f.read())
        image = tudou.generate_tryon_image(photo_bytes, garment_images, instruction)
        result_path = tryon_svc.result_path_for(task_id)
        temporary_path = result_path + ".partial"
        with open(temporary_path, "wb") as f:
            f.write(image)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temporary_path, result_path)
        directory_fd = os.open(str(Path(result_path).parent), os.O_RDONLY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
        task.result_url = f"/tryon-results/{task_id}.png"
        task.status = STATUS_SUCCEEDED
        db.commit()
    except tudou.TudouError as e:
        task = db.get(TryonTask, task_id)
        if task:
            task.status = STATUS_FAILED
            task.error_code = e.code
            task.error_message = e.message
            db.commit()
    except Exception:
        task = db.get(TryonTask, task_id)
        if task:
            task.status = STATUS_FAILED
            task.error_code = "INTERNAL"
            task.error_message = "图片生成失败，请稍后重试"
            db.commit()
    finally:
        # 生成结束（成功或失败）→ 删除原始照片（PRD 第 6 节）
        tryon_svc.delete_file(photo_path)
        db.close()


@router.get("/tryon")
def list_tryons(session_id: str = ""):
    """列出试穿任务（按会话筛选），用于前端恢复试穿历史。"""
    db = SessionLocal()
    try:
        from app.models.tryon import TryonTask as T
        q = db.query(T)
        if session_id:
            q = q.filter(T.session_id == session_id)
        tasks = q.order_by(T.created_at.asc()).all()
        return {"tryons": [to_dict(t) for t in tasks]}
    finally:
        db.close()


@router.get("/tryon/{task_id}")
def get_tryon(task_id: str):
    db = SessionLocal()
    try:
        task = db.get(TryonTask, task_id)
        if task is None:
            return _error("NOT_FOUND", "试穿任务不存在", 404)
        return to_dict(task)
    finally:
        db.close()


def recover_interrupted_generations() -> int:
    """Reconcile one worker's saved tasks before accepting requests; never re-bill."""
    from PIL import Image

    tryon_svc.ensure_dirs()
    with SessionLocal() as db:
        tasks = db.query(TryonTask).filter(TryonTask.status == STATUS_PROCESSING).all()
        for task in tasks:
            result = Path(tryon_svc.result_path_for(task.id))
            valid = False
            if result.is_file():
                try:
                    with Image.open(result) as image:
                        image.verify()
                    valid = True
                except (OSError, ValueError, SyntaxError):
                    pass
            if valid:
                task.status = STATUS_SUCCEEDED
                task.result_url = f"/tryon-results/{task.id}.png"
                task.error_code = ""
                task.error_message = ""
            else:
                task.status = STATUS_FAILED
                task.error_code = "GENERATION_INTERRUPTED"
                task.error_message = "服务重启中断了这次生成。请重新上传并确认生成；已提交的请求可能计费，系统未自动重试。"
            task.photo_path = ""
        db.commit()
        count = len(tasks)
    # At startup there are no live workers. Remove original photos left by a crash.
    for path in tryon_svc.UPLOAD_DIR.iterdir():
        if path.is_file():
            path.unlink(missing_ok=True)
    for path in tryon_svc.RESULT_DIR.glob("*.partial"):
        path.unlink(missing_ok=True)
    return count
