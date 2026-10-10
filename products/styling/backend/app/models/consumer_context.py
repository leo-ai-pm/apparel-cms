"""Opaque mutation intent bindings; separate from existing profile/history rows."""
from datetime import datetime
from sqlalchemy import DateTime, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column
from app.models.chat import Base
from app.models.tryon import utcnow


class ConsumerAuthorizationContext(Base):
    __tablename__ = "consumer_profile_authorization_contexts"
    __table_args__ = (UniqueConstraint("owner_binding", "auth_instance_ref"),)
    context_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    owner_binding: Mapped[str] = mapped_column(String(64), index=True)
    auth_instance_ref: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class ConsumerMutationToken(Base):
    __tablename__ = "consumer_profile_mutation_tokens"
    token_digest: Mapped[str] = mapped_column(String(64), primary_key=True)
    context_id: Mapped[str] = mapped_column(String(64), index=True)
    purpose: Mapped[str] = mapped_column(String(32))
    issued_at: Mapped[datetime] = mapped_column(DateTime)
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    accepted_action_id: Mapped[str | None] = mapped_column(String(64), nullable=True)


class ConsumerOperationContext(Base):
    __tablename__ = "consumer_profile_operation_contexts"
    operation_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    context_id: Mapped[str] = mapped_column(String(64), index=True)
    token_digest: Mapped[str] = mapped_column(String(64))
    owner_binding: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class ConsumerIdentityRevocation(Base):
    __tablename__ = "consumer_profile_identity_revocations"
    owner_ref: Mapped[str] = mapped_column(String(64), primary_key=True)
    revoked_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
