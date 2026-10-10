from typing import Optional, Literal

from pydantic import BaseModel


class PublishRequest(BaseModel):
    requirement_desc: str
    constraints: Optional[list[str]] = None
    style_demand: Optional[bool] = None  # 留空 = 沿用自动判定结果
    priority: Optional[Literal["P0", "P1", "P2", "P3"]] = None
    priority_basis: Optional[str] = None
