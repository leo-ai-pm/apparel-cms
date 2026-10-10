"""试穿任务表（VTO）：长任务状态持久化，进程重启后可恢复（强制底线 2）。"""
from datetime import datetime, timezone

from sqlalchemy import DateTime, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.chat import Base


def utcnow() -> datetime:
    # SQLite 不保存时区，统一用 naive UTC，避免读写后时区不一致导致运算报错
    return datetime.now(timezone.utc).replace(tzinfo=None)


# 状态机：processing（已提交 RunningHub，生成中）→ succeeded / failed
STATUS_PROCESSING = "processing"
STATUS_SUCCEEDED = "succeeded"
STATUS_FAILED = "failed"

# 试穿生成阶段：beautify（美颜用户照片）→ model（生成白肤模特底图）→ faceswap（换脸V2）→ done（完成）
STAGE_BEAUTIFY = "beautify"
STAGE_MODEL = "model"
STAGE_FACESWAP = "faceswap"
STAGE_DONE = "done"


class TryonTask(Base):
    __tablename__ = "tryon_tasks"

    id: Mapped[str] = mapped_column(String(36), primary_key=True)  # 本服务 task_id（uuid）
    session_id: Mapped[str] = mapped_column(String(36), index=True, default="")
    status: Mapped[str] = mapped_column(String(20), default=STATUS_PROCESSING)
    stage: Mapped[str] = mapped_column(String(20), default=STAGE_BEAUTIFY)  # beautify / model / faceswap / done
    runninghub_task_id: Mapped[str] = mapped_column(String(40), default="")
    product_ids: Mapped[str] = mapped_column(String(200), default="")  # 逗号分隔
    garment_product_id: Mapped[str] = mapped_column(String(32), default="")  # 用于试穿的上衣
    scene: Mapped[str] = mapped_column(String(20), default="通勤")
    photo_path: Mapped[str] = mapped_column(String(300), default="")  # 临时照片，生成后删除
    result_url: Mapped[str] = mapped_column(String(300), default="")
    error_code: Mapped[str] = mapped_column(String(40), default="")
    error_message: Mapped[str] = mapped_column(String(300), default="")
    last_poll_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)


def to_dict(t: "TryonTask") -> dict:
    return {
        "task_id": t.id,
        "session_id": t.session_id,
        "status": t.status,
        "product_ids": [p for p in t.product_ids.split(",") if p],
        "garment_product_id": t.garment_product_id,
        "scene": t.scene,
        "result_url": t.result_url,
        "error": {"code": t.error_code, "message": t.error_message} if t.error_code else None,
    }
