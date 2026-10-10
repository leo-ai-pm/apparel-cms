from typing import Literal
from pydantic import BaseModel, ConfigDict, Field
from app.schemas.consumer_profile import ProfileFields

class ProfileBinding(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    snapshot_id: str = Field(min_length=1, max_length=64, pattern=r'^[A-Za-z0-9_-]+$')
    profile_id: str | None = Field(default=None, max_length=64)
    profile_version: int = Field(strict=True, ge=0)
    snapshot_digest: str = Field(pattern=r'^[a-f0-9]{64}$')

class RequestConditions(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    scene: str | None = Field(default=None, min_length=1, max_length=40)
    budget_max_fen: int | None = Field(default=None, strict=True, gt=0, le=100000000)
    request_profile_overrides: ProfileFields | None = None

class ProfilePrepareRequest(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)
    operation: Literal['chat', 'turn', 'restore'] = 'chat'
    session_id: str = Field(min_length=1, max_length=64, pattern=r'^[A-Za-z0-9_-]+$')
    request_id: str = Field(min_length=1, max_length=64, pattern=r'^[A-Za-z0-9_-]+$')
    request_body: dict
