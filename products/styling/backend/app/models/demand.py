"""Append-only dialogue evidence and approved handoff snapshots, v1.4."""
from datetime import datetime
from sqlalchemy import DateTime, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column
from app.models.chat import Base
from app.models.tryon import utcnow


class DemandTurn(Base):
    __tablename__ = "demand_turns"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    request_id: Mapped[str] = mapped_column(String(64), unique=True)
    session_id: Mapped[str] = mapped_column(String(100), index=True)
    text: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(30))
    extractor: Mapped[str] = mapped_column(String(30), default="rules-v1")
    data_origin: Mapped[str] = mapped_column(String(30), default="runtime_demo")
    error_code: Mapped[str] = mapped_column(String(64), default="")
    extraction_attempts: Mapped[int] = mapped_column(Integer, default=1)
    negative_json: Mapped[str] = mapped_column(Text, default="[]")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class DemandOccurrence(Base):
    __tablename__ = "demand_occurrences"
    __table_args__ = (UniqueConstraint("turn_id", "group_key"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    turn_id: Mapped[str] = mapped_column(String(36), index=True)
    group_key: Mapped[str] = mapped_column(String(64), index=True)
    title: Mapped[str] = mapped_column(String(160))
    description: Mapped[str] = mapped_column(Text)
    attributes_json: Mapped[str] = mapped_column(Text)
    review_state: Mapped[str] = mapped_column(String(20), default="pending")
    reason: Mapped[str] = mapped_column(Text, default="")
    normalizer_version: Mapped[str] = mapped_column(String(40), default="rules-v1")
    context_turn_ids_json: Mapped[str] = mapped_column(Text, default="[]")
    field_sources_json: Mapped[str] = mapped_column(Text, default="{}")
    revision: Mapped[int] = mapped_column(Integer, default=1)
    lifecycle: Mapped[str] = mapped_column(String(20), default="active")


class DemandHandoff(Base):
    __tablename__ = "demand_handoffs"
    __table_args__ = (UniqueConstraint("group_key", "version"), UniqueConstraint("group_key", "fingerprint"))
    id: Mapped[str] = mapped_column(String(40), primary_key=True)
    group_key: Mapped[str] = mapped_column(String(64), index=True)
    version: Mapped[int] = mapped_column(Integer)
    fingerprint: Mapped[str] = mapped_column(String(64))
    payload_json: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20), default="approved")
    last_error: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    received_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    metadata_json: Mapped[str] = mapped_column(Text, default="{}")


class DemandAudit(Base):
    __tablename__ = "demand_audit"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    action: Mapped[str] = mapped_column(String(30))
    target_id: Mapped[str] = mapped_column(String(64))
    actor: Mapped[str] = mapped_column(String(30), default="styling-manager")
    note: Mapped[str] = mapped_column(Text)
    before_json: Mapped[str] = mapped_column(Text, default="{}")
    after_json: Mapped[str] = mapped_column(Text, default="{}")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class DemandSendAttempt(Base):
    __tablename__ = "demand_send_attempts"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    handoff_id: Mapped[str] = mapped_column(String(40), index=True)
    status: Mapped[str] = mapped_column(String(20), default="sending")
    attempted_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    error_code: Mapped[str] = mapped_column(String(64), default="")
    receipt_json: Mapped[str] = mapped_column(Text, default="{}")


class DemandOccurrenceRevision(Base):
    """Immutable history; DemandOccurrence remains the current query projection."""
    __tablename__ = "demand_occurrence_revisions"
    __table_args__ = (UniqueConstraint("occurrence_id", "revision"),)
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    occurrence_id: Mapped[str] = mapped_column(String(36), index=True)
    revision: Mapped[int] = mapped_column(Integer)
    snapshot_json: Mapped[str] = mapped_column(Text)
    action: Mapped[str] = mapped_column(String(30))
    actor: Mapped[str] = mapped_column(String(30), default="styling-manager")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class DemandAdminSession(Base):
    """Random signed sessions allow persistent logout revocation."""
    __tablename__ = "demand_admin_sessions"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class DemandRequestAdmission(Base):
    """Exactly-once quota admission; contains no raw user text."""
    __tablename__ = "demand_request_admissions"
    request_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    payload_digest: Mapped[str] = mapped_column(String(64))
    day: Mapped[str] = mapped_column(String(10))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
