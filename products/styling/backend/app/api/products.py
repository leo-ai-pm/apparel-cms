from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.database import SessionLocal
from app.models.product import Product, to_dict

router = APIRouter(prefix="/api/v1", tags=["products"])


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@router.get("/products")
def list_products(
    category: Optional[str] = None,
    price_min: Optional[int] = None,
    price_max: Optional[int] = None,
    color: Optional[str] = None,
    style: Optional[str] = None,
    season: Optional[str] = None,
    scene: Optional[str] = None,
    ids: Optional[str] = None,
    db: Session = Depends(get_db),
):
    q = db.query(Product)
    if category:
        q = q.filter(Product.category == category)
    if ids:
        id_list = [i.strip() for i in ids.split(",") if i.strip()]
        q = q.filter(Product.product_id.in_(id_list))
    if price_min is not None:
        q = q.filter(Product.price >= price_min)
    if price_max is not None:
        q = q.filter(Product.price <= price_max)
    if color:
        q = q.filter(Product.color.contains(color))
    if style:
        q = q.filter(Product.style_tags.contains(style))
    if season:
        q = q.filter(Product.season.contains(season))
    if scene:
        q = q.filter(Product.scene.contains(scene))
    products = q.all()
    return {"products": [to_dict(p) for p in products], "count": len(products)}


@router.get("/products/{product_id}")
def get_product(product_id: str, db: Session = Depends(get_db)):
    p = db.get(Product, product_id)
    if p is None:
        return {"error": {"code": "NOT_FOUND", "message": f"商品 {product_id} 不存在"}}
    return to_dict(p)
