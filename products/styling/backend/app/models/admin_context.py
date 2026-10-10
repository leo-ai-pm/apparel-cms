"""Private manager intent bindings; never appended to partner envelopes."""
from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.chat import Base
from app.models.tryon import utcnow


class AdminAuthorizationGeneration(Base):
    __tablename__ = "styling_admin_authorization_generations"
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    configuration_digest: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    retired_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class AdminSessionContext(Base):
    __tablename__ = "styling_admin_session_contexts"
    session_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    context_id: Mapped[str] = mapped_column(String(43), unique=True)
    generation_id: Mapped[str] = mapped_column(String(64))
    subject: Mapped[str] = mapped_column(String(128))
    scope: Mapped[str] = mapped_column(String(128))
    source_instance_id: Mapped[str] = mapped_column(String(128))
    role: Mapped[str] = mapped_column(String(32))
    audience: Mapped[str] = mapped_column(String(32))
    auth_method: Mapped[str] = mapped_column(String(32))
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class AdminOperation(Base):
    __tablename__ = "styling_admin_operations"
    __table_args__ = (UniqueConstraint("source_instance_id", "scope", "request_id"),)
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    source_instance_id: Mapped[str] = mapped_column(String(128))
    scope: Mapped[str] = mapped_column(String(128))
    request_id: Mapped[str] = mapped_column(String(160), index=True)
    actor_subject: Mapped[str] = mapped_column(String(128))
    operation_context_ref: Mapped[str] = mapped_column(String(64))
    operation_kind: Mapped[str] = mapped_column(String(32))
    method: Mapped[str] = mapped_column(String(8))
    path: Mapped[str] = mapped_column(String(512))
    body_digest: Mapped[str] = mapped_column(String(64))
    digest_version: Mapped[str] = mapped_column(String(32), default="admin-json-v1")
    state: Mapped[str] = mapped_column(String(24), default="pending")
    outcome: Mapped[str | None] = mapped_column(String(24), nullable=True)
    accepted_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    result_ref_json: Mapped[str] = mapped_column(Text, default="null")
    response_digest: Mapped[str | None] = mapped_column(String(64), nullable=True)
    response_status: Mapped[int | None] = mapped_column(Integer, nullable=True)
    response: Mapped["AdminOperationResponse | None"] = relationship(
        back_populates="operation", uselist=False, cascade="all, delete-orphan")

    @property
    def response_json(self):
        return self.response.content_json if self.response else "null"


class AdminOperationResponse(Base):
    """Restricted immutable original DTO, outside the metadata ledger projection.

    This is read only via a fully revalidated exact same-context POST replay;
    operations GET exposes no original private DTO.
    """
    __tablename__ = "styling_admin_action_responses"
    operation_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("styling_admin_operations.id"), primary_key=True)
    content_json: Mapped[str] = mapped_column(Text)
    operation: Mapped[AdminOperation] = relationship(back_populates="response")
