"""Closed inputs for personal previews, separate from recommendation/profile DTOs."""
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

Identifier = Annotated[str, Field(pattern=r'^[A-Za-z0-9_-]{1,64}$')]
Digest = Annotated[str, Field(pattern=r'^[a-f0-9]{64}$')]
Token = Annotated[str, Field(pattern=r'^[A-Za-z0-9_-]{43}$')]


class ClosedInput(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    contract_version: Literal['personal_outfit_preview_v1']


class PreviewConfirmation(ClosedInput):
    session_id: Identifier
    look_version_id: Identifier
    selection_digest: Digest
    photo_sha256: Digest
    confirmed_photo_rights: Literal[True]
    confirmed_ai_reference: Literal[True]

    @field_validator('confirmed_photo_rights', 'confirmed_ai_reference', mode='before')
    @classmethod
    def require_explicit_true(cls, value):
        if value is not True:
            raise ValueError('explicit confirmation required')
        return value


class PreviewTaskInput(ClosedInput):
    request_id: Identifier
    session_id: Identifier
    look_version_id: Identifier
    selection_digest: Digest
    photo_sha256: Digest
    confirmation_id: Identifier
    confirmation_token: Token


class PreviewDelete(ClosedInput):
    delete_action_id: Identifier
