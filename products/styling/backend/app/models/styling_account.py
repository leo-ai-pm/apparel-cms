"""Account bindings for newly issued styling manager sessions only.

Legacy DemandAdminSession rows have no account evidence and are never backfilled.
This does not constitute a multi-user account or natural-person identity system.
"""
from datetime import datetime

from sqlalchemy import DateTime, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.chat import Base
from app.models.tryon import utcnow


class StylingAccountSession(Base):
    __tablename__ = "styling_admin_account_sessions"

    session_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    subject: Mapped[str] = mapped_column(String(128))
    scope: Mapped[str] = mapped_column(String(128))
    audience: Mapped[str] = mapped_column(String(32))
    source_instance_id: Mapped[str] = mapped_column(String(128))
    auth_method: Mapped[str] = mapped_column(String(32))
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
