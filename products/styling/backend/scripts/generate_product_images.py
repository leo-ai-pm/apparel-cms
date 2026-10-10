"""一次性批量生成商品白底图（PRD v1.2 第 11.1 节「VTO 要求：白底/透明底平铺图」）。

用法（需 backend/.env 已配置 RUNNINGHUB_API_KEY）：
    cd backend
    .venv/bin/python -m scripts.generate_product_images          # 生成全部缺失的商品图
    .venv/bin/python -m scripts.generate_product_images P001 P002 # 只生成指定商品

幂等：已存在 data/product-images/{id}.png 的商品会跳过。
"""
from __future__ import annotations

import sys
from pathlib import Path

# 允许 `python -m scripts.generate_product_images` 与 `python scripts/generate_product_images.py` 两种方式
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.database import SessionLocal, init_db  # noqa: E402
from app.models.product import Product  # noqa: E402
from app.services import runninghub, tryon as tryon_svc  # noqa: E402

# 商品英文描述（文生图用英文提示词，效果更稳）
EN_GLOSS = {
    "P001": "white button-up shirt",
    "P002": "navy blazer",
    "P003": "cream knit cardigan",
    "P004": "light gray crew-neck t-shirt",
    "P005": "black turtleneck top",
    "P006": "blue denim jacket",
    "P007": "black A-line skirt",
    "P008": "black straight-leg dress trousers",
    "P009": "cream high-waist wide-leg pants",
    "P010": "dark blue slim-fit jeans",
    "P011": "white sneakers",
    "P012": "black loafers",
    "P013": "brown chelsea boots",
    "P014": "thin leather belt",
    "P015": "canvas tote bag",
    "P016": "gray wool scarf",
    "P017": "black flat shoes",
    "P018": "white canvas sneakers",
    "P019": "brown flat loafers",
    "P020": "black fleece-lined ankle boots",
    "P021": "dark blue low-top casual shoes",
}

_VIEW_BY_CATEGORY = {
    "上装": "laid flat, front view",
    "下装": "laid flat, front view",
    "鞋履": "pair, side view",
    "配饰": "single item, front view",
}


def build_prompt(gloss: str, category: str) -> str:
    view = _VIEW_BY_CATEGORY.get(category, "front view")
    return (
        f"Professional e-commerce product photo of {gloss}, {view}, "
        "on a pure white background, no person, no text, no watermark, "
        "soft even studio lighting, high detail"
    )


def main() -> None:
    init_db()
    tryon_svc.ensure_dirs()

    only = [a.upper() for a in sys.argv[1:]]

    db = SessionLocal()
    try:
        q = db.query(Product).order_by(Product.product_id)
        if only:
            q = q.filter(Product.product_id.in_(only))
        products = q.all()
    finally:
        db.close()

    if not products:
        print("没有匹配的商品。")
        return

    total_cost = 0.0
    done = 0
    skipped = 0
    failed = 0

    for p in products:
        out = tryon_svc.PRODUCT_IMAGE_DIR / f"{p.product_id}.png"
        if out.exists() and out.stat().st_size > 0:
            print(f"[跳过] {p.product_id} {p.name}（已存在）")
            skipped += 1
            continue

        gloss = EN_GLOSS.get(p.product_id, p.name)
        prompt = build_prompt(gloss, p.category)
        print(f"[生成] {p.product_id} {p.name} → {gloss} ...", flush=True)
        try:
            result = runninghub.text_to_image(prompt, str(out), width=1024, height=1024, resolution="1k")
            cost = result.get("cost")
            if cost is not None:
                try:
                    total_cost += float(cost)
                except (TypeError, ValueError):
                    pass
            print(f"      完成，耗时 {result.get('duration')}s，费用 ¥{cost}", flush=True)
            done += 1
        except runninghub.RunningHubError as e:
            print(f"      失败：{e.code} {e.message}", flush=True)
            failed += 1

    print(f"\n完成：生成 {done}，跳过 {skipped}，失败 {failed}，累计费用 ¥{total_cost:.3f}")


if __name__ == "__main__":
    main()
