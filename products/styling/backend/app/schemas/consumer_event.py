"""Strict browser observations: no raw drafts or client-authored business success."""
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

Identifier = Annotated[str, Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")]


class ConsumerEventRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schema_version: int = Field(strict=True, ge=1, le=1)
    event_id: Identifier
    session_id: Identifier
    page_view_id: Identifier
    page: Literal["home", "discover", "outfit", "bag", "history"]
    occurred_at: datetime
    source_slot: Identifier
    event_name: Literal["page_view", "product_impression", "product_detail_open", "draft_prefill",
                        "message_submit", "outfit_displayed", "history_restore", "example_exposure"]
    product_id: Identifier | None = None
    request_id: Identifier | None = None
    look_version_id: Identifier | None = None
    sku_ids: list[Identifier] | None = Field(default=None, max_length=3)
    image_loaded: bool | None = Field(default=None, strict=True)
    visible_fraction: float | None = Field(default=None, ge=0, le=1, strict=True)
    dwell_ms: int | None = Field(default=None, ge=0, le=86_400_000, strict=True)
    canvas_visible: bool | None = Field(default=None, strict=True)

    @model_validator(mode="after")
    def validate_observation(self):
        if self.occurred_at.tzinfo is None or self.occurred_at.utcoffset() is None:
            raise ValueError("occurred_at must include a timezone")
        if self.event_name in ("product_impression", "product_detail_open") and not self.product_id:
            raise ValueError("product event requires product_id")
        if self.event_name == "product_impression":
            if (self.image_loaded is not True or self.visible_fraction is None or self.visible_fraction < .5
                    or self.dwell_ms is None or self.dwell_ms < 1000):
                raise ValueError("impression requires a loaded image visible for at least one second")
        if self.event_name == "message_submit" and not self.request_id:
            raise ValueError("message_submit requires request_id")
        if self.event_name == "outfit_displayed":
            if (not self.look_version_id or not self.sku_ids or len(set(self.sku_ids)) != 3
                    or self.image_loaded is not True or self.canvas_visible is not True):
                raise ValueError("outfit display requires a loaded visible complete version and three SKUs")
        return self
