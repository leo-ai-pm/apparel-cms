"""Append-only client observations, independent of demand and generation facts."""
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.chat import Base
from app.models.tryon import utcnow


class ConsumerEvent(Base):
    __tablename__ = "consumer_events"

    event_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    payload_digest: Mapped[str] = mapped_column(String(64))
    semantic_key: Mapped[str | None] = mapped_column(String(64), unique=True, nullable=True)
    session_id: Mapped[str] = mapped_column(String(64), index=True)
    page_view_id: Mapped[str] = mapped_column(String(64), index=True)
    event_name: Mapped[str] = mapped_column(String(32), index=True)
    page: Mapped[str] = mapped_column(String(16))
    source_slot: Mapped[str] = mapped_column(String(64))
    occurred_at: Mapped[datetime] = mapped_column(DateTime)
    received_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    payload_json: Mapped[str] = mapped_column(Text)
    source: Mapped[str] = mapped_column(String(16), default="client")
    data_origin: Mapped[str] = mapped_column(String(32), default="runtime_demo")
    is_simulated: Mapped[bool] = mapped_column(Boolean, default=True)


class ConsumerEventReceipt(Base):
    """Reserve every transport ID, including IDs deduplicated to an earlier exposure."""
    __tablename__ = "consumer_event_receipts"

    event_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    payload_digest: Mapped[str] = mapped_column(String(64))
    canonical_event_id: Mapped[str] = mapped_column(String(64), ForeignKey("consumer_events.event_id"), index=True)
    received_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
