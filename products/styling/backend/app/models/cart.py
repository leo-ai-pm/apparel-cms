"""加购表（模拟加购，PRD v1.3 feedback_type=simulated_cart）。

按会话记录用户加购了哪些商品，仅计数/演示，不产生真实交易（D8：加购/下单/付款一律拒绝）。
"""
from datetime import datetime

from sqlalchemy import DateTime, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.chat import Base
from app.models.tryon import utcnow


class CartItem(Base):
    __tablename__ = "cart_items"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_id: Mapped[str] = mapped_column(String(36), index=True, default="")
    product_id: Mapped[str] = mapped_column(String(32), default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
