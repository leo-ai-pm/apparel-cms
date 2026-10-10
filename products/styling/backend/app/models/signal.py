"""需求信号草稿表（PRD v1.3 第 12 节 + P0《数据契约》2.1）。

草稿在本服务内生成/更新，运营点「上传」时脱敏提交到 CMS；上传成功后 status=uploaded。
同一会话同一时刻只保留一条 draft（每轮方案 upsert 更新，signal_id 不变）。
"""
from datetime import datetime

from sqlalchemy import DateTime, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.chat import Base
from app.models.tryon import utcnow


# 状态机：draft（本地草稿）→ uploaded（已提交 CMS）
STATUS_DRAFT = "draft"
STATUS_UPLOADED = "uploaded"


class SignalDraft(Base):
    __tablename__ = "signal_drafts"

    signal_id: Mapped[str] = mapped_column(String(32), primary_key=True)  # SIG-YYYYMMDD-序号
    session_id: Mapped[str] = mapped_column(String(36), index=True, default="")
    source_agent: Mapped[str] = mapped_column(String(20), default="outfit")
    timestamp: Mapped[str] = mapped_column(String(30), default="")  # ISO8601
    scene: Mapped[str] = mapped_column(String(20), default="commute")  # 英文枚举
    season: Mapped[str] = mapped_column(String(4), default="")  # 春/夏/秋/冬
    preference: Mapped[str] = mapped_column(Text, default="")  # 用户偏好描述
    body_type_tag: Mapped[str] = mapped_column(String(50), default="")  # 脱敏体型标签
    change_reason: Mapped[str] = mapped_column(Text, default="")  # 换搭理由（调整轮=最近一条用户消息）
    outfit_plan_json: Mapped[str] = mapped_column(Text, default="{}")  # {items:[{product_id,name,category}], note}
    feedback_type: Mapped[str] = mapped_column(String(20), default="")  # 上传时选择
    user_tag: Mapped[str] = mapped_column(String(50), default="")  # 性别-年龄段-场景
    status: Mapped[str] = mapped_column(String(20), default=STATUS_DRAFT)  # draft / uploaded
    uploaded_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow, onupdate=utcnow)
