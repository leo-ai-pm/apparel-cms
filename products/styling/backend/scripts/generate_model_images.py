"""预生成"穿着商品的模特底图"（每款商品一张，缓存复用，出图时不再现生成）。

用法（需 backend/.env 已配置 RUNNINGHUB_API_KEY）：
    cd backend
    .venv/bin/python -m scripts.generate_model_images

生成到 data/model-images/{product_id}.png；幂等（已存在则跳过）。
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.database import SessionLocal, init_db  # noqa: E402
from app.models.product import Product  # noqa: E402
from app.services import runninghub, tryon as tryon_svc  # noqa: E402

MODEL_IMAGE_DIR = Path(tryon_svc.DATA_DIR) / "model-images"


def main() -> None:
    init_db()
    MODEL_IMAGE_DIR.mkdir(parents=True, exist_ok=True)

    db = SessionLocal()
    try:
        products = db.query(Product).order_by(Product.product_id).all()
    finally:
        db.close()

    total_cost = 0.0
    done = skipped = failed = 0
    for p in products:
        out = MODEL_IMAGE_DIR / f"{p.product_id}.png"
        if out.exists() and out.stat().st_size > 0:
            skipped += 1
            continue
        prompt = tryon_svc.build_model_prompt(p, "通勤")
        print(f"[生成] {p.product_id} {p.name} ...", flush=True)
        try:
            r = runninghub.text_to_image(prompt, str(out), width=768, height=1024, resolution="1k")
            if r.get("cost") is not None:
                total_cost += float(r["cost"])
            done += 1
        except runninghub.RunningHubError as e:
            print(f"  失败：{e.code} {e.message}", flush=True)
            failed += 1
    print(f"\n完成：生成 {done}，跳过 {skipped}，失败 {failed}，累计费用 ¥{total_cost:.3f}")


if __name__ == "__main__":
    main()
