"""Strict v0.3 source callback shape; no URLs, owners or CMS identifiers."""
import base64
import re
from typing import Annotated, Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator, field_validator
from app.schemas.admin_context import AdminActionFields

Id = Annotated[str, Field(strict=True, min_length=1, max_length=160, pattern=r'^[A-Za-z0-9_.:-]+$')]
Sha = Annotated[str, Field(strict=True, pattern=r'^[0-9a-f]{64}$')]


class StrictObject(BaseModel):
    model_config = ConfigDict(extra='forbid')


class ApprovalRef(StrictObject):
    approval_record_id: Id


class VerifyApproval(StrictObject):
    proof_schema: Literal['pa-direct-approval-proof/1']
    verification_purpose: Literal['initial_delivery', 'supplement_append']
    nonce: str = Field(strict=True, min_length=22, max_length=128, pattern=r'^[A-Za-z0-9_-]+$')
    source_product: Literal['personal_styling']
    target_product: Literal['product_management']
    source_instance_id: Id
    target_instance_id: Id
    authorized_scope: Id
    source_approval_ref: ApprovalRef
    handoff_id: Id
    revision: int = Field(strict=True, ge=1, le=2**63-1)
    payload_digest: Sha
    supplement_id: Id | None
    supplement_digest: Sha | None

    @field_validator('nonce')
    @classmethod
    def full_nonce(cls, value):
        if re.fullmatch(r'[0-9a-f]{32,128}', value) and len(value) % 2 == 0:
            return value
        try:
            raw = base64.b64decode(value + '=' * (-len(value) % 4), altchars=b'-_', validate=True)
        except ValueError:
            raise ValueError('nonce') from None
        if len(raw) < 16 or base64.urlsafe_b64encode(raw).decode().rstrip('=') != value:
            raise ValueError('nonce')
        return value

    @model_validator(mode='after')
    def paired_supplement(self):
        if (self.supplement_id is None) != (self.supplement_digest is None):
            raise ValueError('supplement')
        if self.verification_purpose == 'supplement_append' and self.supplement_id is None:
            raise ValueError('supplement')
        return self


class DirectSend(AdminActionFields):
    request_id: Id
    expected_revision: int = Field(strict=True, ge=1, le=2**63-1)
    include_supplement: bool = Field(default=True, strict=True)


class DirectAction(AdminActionFields):
    request_id: Id
    expected_revision: int = Field(strict=True, ge=1, le=2**63-1)


class EvidenceAction(AdminActionFields):
    expected_revision: int = Field(strict=True, ge=1, le=2**63-1)
