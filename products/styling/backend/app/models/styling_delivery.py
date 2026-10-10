"""Independent direct transport ledger; legacy handoff state stays untouched."""
from datetime import datetime
from sqlalchemy import DateTime, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column
from app.models.chat import Base
from app.models.tryon import utcnow


class StylingDirectDelivery(Base):
    __tablename__ = 'styling_direct_deliveries'
    __table_args__ = (UniqueConstraint('handoff_id', 'revision'),)
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    handoff_id: Mapped[str] = mapped_column(String(160), index=True)
    revision: Mapped[int] = mapped_column(Integer)
    scope: Mapped[str] = mapped_column(String(160))
    source_instance_id: Mapped[str] = mapped_column(String(160))
    target_instance_id: Mapped[str] = mapped_column(String(160))
    approval_record_id: Mapped[str] = mapped_column(String(160))
    actor_subject: Mapped[str] = mapped_column(String(160))
    envelope_json: Mapped[str] = mapped_column(Text)
    envelope_digest: Mapped[str] = mapped_column(String(64))
    payload_digest: Mapped[str] = mapped_column(String(64))
    first_supplement_id: Mapped[str | None] = mapped_column(String(160), nullable=True)
    first_supplement_digest: Mapped[str | None] = mapped_column(String(64), nullable=True)
    status: Mapped[str] = mapped_column(String(24), default='unconfirmed')
    receipt_json: Mapped[str] = mapped_column(Text, default='null')
    current_supplement_json: Mapped[str] = mapped_column(Text, default='null')
    last_error: Mapped[str] = mapped_column(String(64), default='')
    lease_token: Mapped[str | None] = mapped_column(String(64), nullable=True)
    lease_until: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class StylingDirectAction(Base):
    __tablename__ = 'styling_direct_actions'
    __table_args__ = (UniqueConstraint('scope', 'actor_subject', 'request_id'),)
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    delivery_id: Mapped[str] = mapped_column(String(64), index=True)
    scope: Mapped[str] = mapped_column(String(160))
    actor_subject: Mapped[str] = mapped_column(String(160))
    request_id: Mapped[str] = mapped_column(String(160))
    operation: Mapped[str] = mapped_column(String(24))
    request_digest: Mapped[str] = mapped_column(String(64))
    response_json: Mapped[str] = mapped_column(Text, default='null')
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class StylingDirectAttempt(Base):
    __tablename__ = 'styling_direct_attempts'
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    delivery_id: Mapped[str] = mapped_column(String(64), index=True)
    action_id: Mapped[str] = mapped_column(String(64), index=True)
    operation: Mapped[str] = mapped_column(String(24))
    status: Mapped[str] = mapped_column(String(24), default='sending')
    error_code: Mapped[str] = mapped_column(String(64), default='')
    started_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class StylingDirectSupplement(Base):
    __tablename__ = 'styling_direct_supplements'
    __table_args__ = (UniqueConstraint('delivery_id'),)
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    delivery_id: Mapped[str] = mapped_column(String(64), index=True)
    supplement_id: Mapped[str] = mapped_column(String(160))
    digest: Mapped[str] = mapped_column(String(64))
    request_json: Mapped[str] = mapped_column(Text)
    request_digest: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(24), default='unconfirmed')
    receipt_json: Mapped[str] = mapped_column(Text, default='null')
    last_error: Mapped[str] = mapped_column(String(64), default='')
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
