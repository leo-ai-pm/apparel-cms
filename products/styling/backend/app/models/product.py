"""商品表（PRD v1.2 第 11.1 节字段，另加 body_fit 兼容现有工具）。"""
from sqlalchemy import Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.chat import Base


class Product(Base):
    __tablename__ = "products"

    product_id: Mapped[str] = mapped_column(String(32), primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    category: Mapped[str] = mapped_column(String(20))  # 上装/下装/鞋履/配饰
    brand: Mapped[str] = mapped_column(String(50), default="")
    price: Mapped[int] = mapped_column(Integer)
    color: Mapped[str] = mapped_column(String(50), default="")
    size: Mapped[str] = mapped_column(String(50), default="")
    material: Mapped[str] = mapped_column(String(100), default="")
    style_tags: Mapped[str] = mapped_column(String(200), default="")  # 逗号分隔
    season: Mapped[str] = mapped_column(String(50), default="")  # 逗号分隔
    scene: Mapped[str] = mapped_column(String(100), default="")  # 逗号分隔
    image_url: Mapped[str] = mapped_column(String(300), default="")
    link: Mapped[str] = mapped_column(String(300), default="")
    stock_status: Mapped[str] = mapped_column(String(20), default="in_stock")
    source: Mapped[str] = mapped_column(String(50), default="seed")
    body_fit: Mapped[str] = mapped_column(String(100), default="")  # 兼容现有工具的体型适配


def to_dict(p: "Product") -> dict:
    return {
        "product_id": p.product_id,
        "name": p.name,
        "category": p.category,
        "brand": p.brand,
        "price": p.price,
        "color": p.color,
        "size": p.size,
        "material": p.material,
        "style_tags": [t for t in p.style_tags.split(",") if t],
        "season": [s for s in p.season.split(",") if s],
        "scene": [s for s in p.scene.split(",") if s],
        "image_url": p.image_url,
        "link": p.link,
        "stock_status": p.stock_status,
        "source": p.source,
        "body_fit": [b for b in p.body_fit.split(",") if b],
    }
