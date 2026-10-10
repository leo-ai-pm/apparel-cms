"""Append-only account approval facts and frozen evidence projections.

These records are separate from the historical DH and its old transport state.
"""
from sqlalchemy import Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models.chat import Base


class StylingApprovalFact(Base):
    __tablename__ = "styling_approval_facts"
    __table_args__ = (UniqueConstraint("handoff_id", "revision"),)
    approval_record_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    handoff_id: Mapped[str] = mapped_column(String(40), index=True)
    revision: Mapped[int] = mapped_column(Integer)
    scope: Mapped[str] = mapped_column(String(160))
    source_instance_id: Mapped[str] = mapped_column(String(160))
    subject: Mapped[str] = mapped_column(String(160))
    auth_method: Mapped[str] = mapped_column(String(64))
    approved_at: Mapped[str] = mapped_column(String(64))
    payload_digest: Mapped[str] = mapped_column(String(64))
    metadata_digest: Mapped[str] = mapped_column(String(64))
    data_origin: Mapped[str] = mapped_column(String(32))


class StylingEvidenceExport(Base):
    __tablename__ = "styling_evidence_exports"
    __table_args__ = (UniqueConstraint("handoff_id", "revision", "rule_version"),)
    supplement_id: Mapped[str] = mapped_column(String(64), primary_key=True)
    handoff_id: Mapped[str] = mapped_column(String(40), index=True)
    revision: Mapped[int] = mapped_column(Integer)
    approval_record_id: Mapped[str] = mapped_column(String(64))
    scope: Mapped[str] = mapped_column(String(160))
    source_instance_id: Mapped[str] = mapped_column(String(160))
    exported_by: Mapped[str] = mapped_column(String(200))
    payload_digest: Mapped[str] = mapped_column(String(64))
    metadata_digest: Mapped[str] = mapped_column(String(64))
    content_json: Mapped[str] = mapped_column(Text)
    digest: Mapped[str] = mapped_column(String(64))
    rule_version: Mapped[str] = mapped_column(String(64))
