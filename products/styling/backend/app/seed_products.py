"""seed 模拟商品数据：把现有内存商品库升级为 SQLite 商品表（PRD v1.2 第 11 节）。"""
from app.models.product import Product
from app.services.catalog import PRODUCTS

# 品类与场景映射（现有 catalog 用"鞋"，PRD 用"鞋履"）
_CATEGORY_MAP = {"鞋": "鞋履"}

# 按风格推导场景（粗略，供 seed 用）
def _derive_scene(style: list[str]) -> str:
    scenes = []
    if any(s in style for s in ["通勤", "优雅"]):
        scenes.append("通勤")
    if any(s in style for s in ["休闲", "街头", "运动"]):
        scenes.append("出游")
    if any(s in style for s in ["优雅"]):
        scenes.append("约会聚会")
    return ",".join(scenes) if scenes else "通勤"


def build_seed_rows() -> list[dict]:
    rows = []
    for p in PRODUCTS:
        category = _CATEGORY_MAP.get(p["category"], p["category"])
        rows.append({
            "product_id": p["id"],
            "name": p["name"],
            "category": category,
            "brand": "示例品牌",
            "price": p["price"],
            "color": ",".join(p.get("colors", [])),
            "size": "均码",
            "material": p.get("desc", ""),
            "style_tags": ",".join(p.get("style", [])),
            "season": ",".join(p.get("season", [])),
            "scene": _derive_scene(p.get("style", [])),
            "image_url": f"/product-images/{p['id']}.png",
            "link": "",
            "stock_status": "in_stock",
            "source": "seed",
            "body_fit": ",".join(p.get("body_fit", [])),
        })
    return rows


def seed_products(db) -> None:
    if db.query(Product).count() == 0:
        for row in build_seed_rows():
            db.add(Product(**row))
        db.commit()
    migrate_image_urls(db)


def migrate_image_urls(db) -> None:
    """把旧占位图路径（/static/product-images/{id}.svg）迁移为白底图路径（/product-images/{id}.png）。"""
    rows = db.query(Product).all()
    changed = 0
    for p in rows:
        if p.image_url.endswith(".svg") or "/static/product-images/" in p.image_url:
            p.image_url = f"/product-images/{p.product_id}.png"
            changed += 1
    if changed:
        db.commit()
