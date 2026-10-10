from datetime import datetime
from typing import Optional

from pydantic import BaseModel, Field, field_validator


class OutfitItem(BaseModel):
    product_id: str
    name: str
    category: str


class OutfitPlan(BaseModel):
    items: list[OutfitItem] = []
    note: Optional[str] = None


class CmsSignal(BaseModel):
    """旧证据包接口使用的兼容模型。"""

    signal_id: str
    source_agent: str
    timestamp: str
    scene: str
    season: Optional[str] = None
    preference: str = ""
    body_type_tag: Optional[str] = None
    change_reason: Optional[str] = None
    outfit_plan: Optional[OutfitPlan] = None
    feedback_type: str
    user_tag: str = ""
    status: str = "uploaded"


class SignalIn(BaseModel):
    signal_id: str = Field(pattern=r"^SIG-[A-Za-z0-9_-]{1,80}$")
    timestamp: str
    scene: str = Field(min_length=1, max_length=80)
    season: str | None = Field(default=None, max_length=40)
    preference: str = Field(default="", max_length=2000)
    change_reason: str | None = Field(default=None, max_length=2000)
    body_type_tag: str | None = Field(default=None, max_length=100)
    outfit_plan: OutfitPlan = Field(default_factory=OutfitPlan)
    feedback_type: str = Field(min_length=1, max_length=80)
    source_agent: str = Field(default="outfit", max_length=80)

    @field_validator("timestamp")
    @classmethod
    def valid_timestamp(cls, value: str) -> str:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
        return value
