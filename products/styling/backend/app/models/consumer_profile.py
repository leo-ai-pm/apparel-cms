"""Restricted profile values and separate, value-free operation receipts."""
from datetime import datetime

from sqlalchemy import DateTime, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models.chat import Base
from app.models.tryon import utcnow


class ConsumerProfileIdentity(Base):
    __tablename__ = "consumer_profile_identities"
    __table_args__ = (UniqueConstraint("app_scope", "token_hash"),)

    owner_ref: Mapped[str] = mapped_column(String(64), primary_key=True)
    app_scope: Mapped[str] = mapped_column(String(80), index=True)
    token_hash: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime, index=True)


class SavedConsumerProfile(Base):
    __tablename__ = "consumer_profiles"

    profile_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    owner_binding: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    app_scope: Mapped[str] = mapped_column(String(80))
    scope_kind: Mapped[str] = mapped_column(String(16))
    owner_ref: Mapped[str] = mapped_column(String(64))
    profile_version: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(16), default="empty")
    base_profile_json: Mapped[str] = mapped_column(Text)
    default_budget_fen: Mapped[int | None] = mapped_column(Integer, nullable=True)
    updated_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True, index=True)


class ConsumerProfileOperation(Base):
    __tablename__ = "consumer_profile_operations"
    __table_args__ = (UniqueConstraint("owner_binding", "profile_action_id"),)

    operation_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    owner_binding: Mapped[str] = mapped_column(String(64), index=True)
    profile_action_id: Mapped[str] = mapped_column(String(64))
    payload_digest: Mapped[str] = mapped_column(String(64))
    operation_type: Mapped[str] = mapped_column(String(16))
    profile_id: Mapped[str] = mapped_column(String(64))
    version_before: Mapped[int] = mapped_column(Integer)
    version_after: Mapped[int] = mapped_column(Integer)
    changed_field_names_json: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16), default="succeeded")
    result_json: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
