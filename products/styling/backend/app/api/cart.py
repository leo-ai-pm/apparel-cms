"""加购接口（模拟加购，PRD v1.3 feedback_type=simulated_cart）。

- GET    /api/v1/cart                按会话列出已加购商品 ID
- POST   /api/v1/cart                加购（幂等）
- DELETE /api/v1/cart/{product_id}   取消加购
"""
from fastapi import APIRouter
from pydantic import BaseModel

from app.services import cart

router = APIRouter(prefix="/api/v1", tags=["cart"])


class CartAddRequest(BaseModel):
    session_id: str
    product_id: str


@router.get("/cart")
def get_cart(session_id: str):
    return {"cart": cart.get_cart_ids(session_id.strip())}


@router.post("/cart")
def add_cart(req: CartAddRequest):
    return {"cart": cart.add(req.session_id.strip(), req.product_id.strip())}


@router.delete("/cart/{product_id}")
def remove_cart(product_id: str, session_id: str):
    return {"cart": cart.remove(session_id.strip(), product_id.strip())}
