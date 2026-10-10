"""Independent proof receipts; no alteration of legacy approval or send tables."""
from datetime import datetime
from sqlalchemy import DateTime, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column
from app.models.chat import Base


class StylingApprovalVerification(Base):
    __tablename__ = 'styling_approval_verifications'
    __table_args__ = (UniqueConstraint('verifier_subject', 'nonce'),)
    verification_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    verifier_subject: Mapped[str] = mapped_column(String(160))
    nonce: Mapped[str] = mapped_column(String(128))
    request_digest: Mapped[str] = mapped_column(String(64))
    response_json: Mapped[str] = mapped_column(Text)
    verified_at: Mapped[datetime] = mapped_column(DateTime)
    expires_at: Mapped[datetime] = mapped_column(DateTime)
