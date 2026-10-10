"""Persistent execution lifecycle; extraction has its own independent status."""
from datetime import datetime

from sqlalchemy import Boolean, DateTime, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.chat import Base
from app.models.tryon import utcnow


class GenerationRequest(Base):
    __tablename__ = "generation_requests"

    request_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    session_id: Mapped[str] = mapped_column(String(64), index=True)
    turn_id: Mapped[str] = mapped_column(String(64), index=True)
    status: Mapped[str] = mapped_column(String(16), default="accepted", index=True)
    outcome: Mapped[str] = mapped_column(String(32), default="")
    error_code: Mapped[str] = mapped_column(String(64), default="")
    result_json: Mapped[str] = mapped_column(Text, default="null")
    accepted_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    started_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    data_origin: Mapped[str] = mapped_column(String(32), default="runtime_demo")
    is_simulated: Mapped[bool] = mapped_column(Boolean, default=True)
