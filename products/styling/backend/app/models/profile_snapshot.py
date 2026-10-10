"""Immutable profile inputs; only qualification and execution state can change."""
from datetime import datetime
from sqlalchemy import String, Text, DateTime, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column
from app.models.chat import Base
from app.models.tryon import utcnow


class ConsumerProfileSnapshot(Base):
    __tablename__ = 'consumer_profile_snapshots'
    __table_args__ = (UniqueConstraint('owner_key', 'request_id'),)
    snapshot_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    owner_key: Mapped[str] = mapped_column(String(64), index=True)
    session_id: Mapped[str] = mapped_column(String(64), index=True)
    request_id: Mapped[str] = mapped_column(String(100), index=True)
    operation: Mapped[str] = mapped_column(String(16))
    profile_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    profile_version: Mapped[int]
    body_digest: Mapped[str] = mapped_column(String(64))
    snapshot_digest: Mapped[str] = mapped_column(String(64))
    snapshot_json: Mapped[str] = mapped_column(Text)
    effective_json: Mapped[str] = mapped_column(Text, default='')
    state: Mapped[str] = mapped_column(String(16), default='prepared')
    invalidation_reason: Mapped[str] = mapped_column(String(64), default='')
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class ConsumerSessionOwner(Base):
    __tablename__ = 'consumer_session_owners'
    session_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    owner_key: Mapped[str] = mapped_column(String(64), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
