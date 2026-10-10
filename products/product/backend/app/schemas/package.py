from typing import Optional, Literal

from pydantic import BaseModel, Field


class SampleCount(BaseModel):
    intent: int = 0
    simulated_cart: int = 0
    real_purchase: int = 0


class Attribution(BaseModel):
    supply_gap: bool = False
    image_gap: bool = False
    style_demand: bool = False


class PackagePayload(BaseModel):
    """证据包，字段严格对齐 P0 第 2.2 节（与 CMS PackageCreate 一致）。"""

    package_id: str
    source_agent: str = Field(default="product")
    signal_ids: list[str]
    source: str
    dedup_key: str
    dedup_rule: str
    sample_count: SampleCount
    attribution: Attribution
    constraints: Optional[list[str]] = None
    requirement_desc: str
    version: str
    priority: Optional[Literal["P0", "P1", "P2", "P3"]] = None
    priority_basis: Optional[str] = None
