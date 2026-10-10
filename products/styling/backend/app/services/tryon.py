"""VTO 试穿业务逻辑：照片校验、商品图解析、提示词构造、目录管理。

照片属生物特征敏感数据（PRD 第 6 节）：仅用于本次生成，处理完成即删，不落库、不训练。
"""
from __future__ import annotations

from pathlib import Path

from app.core.config import DATA_DIR, settings

try:
    from PIL import Image
except ImportError:  # Pillow 未安装时不强制（上传不做比例归一化）
    Image = None

# —— 目录（均在 data/ 下，已被 .gitignore 忽略，不进仓库） ——
UPLOAD_DIR = DATA_DIR / "tryon_uploads"      # 用户照片临时暂存（生成后删除）
RESULT_DIR = DATA_DIR / "tryon-results"      # 生成结果图
PRODUCT_IMAGE_DIR = DATA_DIR / "product-images"  # 商品白底图

# 允许的上传图片类型（按真实文件头校验，非仅扩展名）
IMAGE_MIME_BY_EXT = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
}

# 场景 → 提示词软提示（背景由用户照片决定，场景暂作为生成语气提示）
SCENE_HINTS = {
    "通勤": "整体通勤利落",
    "出游": "整体轻松自然",
    "约会聚会": "整体温柔大方",
}

DEFAULT_SCENE = "通勤"


def ensure_dirs() -> None:
    for d in (UPLOAD_DIR, RESULT_DIR, PRODUCT_IMAGE_DIR):
        d.mkdir(parents=True, exist_ok=True)


def sniff_image_type(data: bytes) -> str | None:
    """按文件头识别真实图片类型（jpg/png/webp），不信任扩展名。"""
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if len(data) >= 12 and data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def validate_photo(data: bytes) -> tuple[str | None, str | None]:
    """返回 (错误码, 错误信息)；通过时返回 (None, None)。"""
    if not data:
        return "EMPTY_FILE", "照片为空，请重新上传"
    mime = sniff_image_type(data)
    if mime is None:
        return "INVALID_IMAGE", "照片格式不支持，请上传 JPG / PNG / WebP 图片"
    if len(data) > settings.photo_max_bytes:
        return "IMAGE_TOO_LARGE", "照片过大，请上传 5MB 以内的图片"
    return None, None


def parse_product_ids(raw: str) -> list[str]:
    if not raw:
        return []
    return [p.strip() for p in raw.replace("，", ",").split(",") if p.strip()]


def resolve_garment(product_ids: list[str], db) -> tuple[str | None, str | None]:
    """从方案商品里挑出用于试穿的单品：优先上装，否则第一个商品。

    返回 (product_id, 白底图本地路径)；找不到返回 (None, None)。
    """
    from app.models.product import Product

    if not product_ids:
        return None, None
    rows = db.query(Product).filter(Product.product_id.in_(product_ids)).all()
    if not rows:
        return None, None
    top = next((p for p in rows if p.category == "上装"), None)
    chosen = top or rows[0]
    image_path = PRODUCT_IMAGE_DIR / f"{chosen.product_id}.png"
    return chosen.product_id, str(image_path)


def build_vto_prompt(scene: str | None) -> str:
    hint = SCENE_HINTS.get(scene or "", "")
    base = "让图一的人物穿上图二的衣服，自然合身，保持人物脸部、发型与姿态一致"
    return f"{base}，{hint}" if hint else base


# 商品英文描述（用于生成"穿着商品的模特图"，文生图用英文更稳）
GARMENT_EN_GLOSS = {
    "P001": "white button-up shirt", "P002": "navy blazer", "P003": "cream knit cardigan",
    "P004": "light gray crew-neck t-shirt", "P005": "black turtleneck top", "P006": "blue denim jacket",
    "P007": "black A-line skirt", "P008": "black straight-leg dress trousers",
    "P009": "cream high-waist wide-leg pants", "P010": "dark blue slim-fit jeans",
    "P011": "white sneakers", "P012": "black loafers", "P013": "brown chelsea boots",
    "P014": "thin leather belt", "P015": "canvas tote bag", "P016": "gray wool scarf",
    "P017": "black flat shoes", "P018": "white canvas sneakers", "P019": "brown flat loafers",
    "P020": "black fleece-lined ankle boots", "P021": "dark blue low-top casual shoes",
}

# 统一摄影棚白底（商品图风格），姿势自然、手臂自然垂放，下装用长裤（长裙易生成出多余肢体）
def build_model_prompt(garment, scene: str) -> str:
    """生成"穿着商品的模特底图"提示词：白肤中国女性、摄影棚白底、自然站姿手臂垂放、搭配长裤。"""
    gloss = GARMENT_EN_GLOSS.get(garment.product_id, garment.name)
    return (f"Fashion e-commerce photography, full-body shot of a young Chinese woman with fair skin, "
            f"wearing {gloss}, paired with tailored full-length trousers, "
            f"natural relaxed standing pose, both legs together, arms relaxed at her sides, "
            f"pure white studio background, soft even lighting, "
            f"realistic, natural skin texture, no excessive shine, high detail")


def resolve_garment_product(product_ids: list[str], db):
    """返回用于生成模特图的商品对象（优先上装，否则第一个）。"""
    from app.models.product import Product

    if not product_ids:
        return None
    rows = db.query(Product).filter(Product.product_id.in_(product_ids)).all()
    if not rows:
        return None
    return next((p for p in rows if p.category == "上装"), rows[0])


# 场景 → 背景描述（出图背景随用户场景变化，单人图，均走动起来）
SCENE_BACKGROUNDS = {
    "通勤": "现代城市街道，人物在自然走路",
    "出游": "城市公园、绿荫步道或轻松的街头，人物在自然漫步（背景是城市休闲环境，不要山林、土路、登山、徒步等野外场景）",
    "约会聚会": "商场或精致街区，人物在自然走路",
}


def resolve_outfit_products(product_ids: list[str], db):
    """从方案商品里挑出完整搭配：上衣 + 下装 + 鞋履 + 配饰（各取第一件）。"""
    from app.models.product import Product

    if not product_ids:
        return []
    rows = db.query(Product).filter(Product.product_id.in_(product_ids)).all()
    if not rows:
        return []
    result = []
    for cat in ("上装", "下装", "鞋履", "配饰"):
        p = next((x for x in rows if x.category == cat), None)
        if p:
            result.append(p)
    return result


def build_tryon_instruction(products, scene: str) -> str:
    """构建 Gemini 图像编辑指令：多张商品参考图 + 完整搭配，保持脸不变，全身照，场景背景。"""
    bg = SCENE_BACKGROUNDS.get(scene or "", SCENE_BACKGROUNDS["通勤"])
    # 图1 = 用户照片；图2.. = 商品参考图
    refs = "、".join(f"图{i}" for i in range(2, len(products) + 2))
    desc = "；".join(f"图{i}是「{p.name}」（{p.color}）" for i, p in enumerate(products, start=2))
    # 有腰带时：上衣必须塞进下装、腰带系在自然腰线居中完整露出（束腰才有意义，Gemini 需明确指令）
    has_belt = any("腰带" in p.name for p in products)
    belt_note = (
        "把上衣下摆完全塞进下装的腰头里（塞进去，不能散落在下装外面），"
        "并把「细腰带」系在自然腰线处、位于身体正中间，腰带完整露出、居中、不歪斜。"
    ) if has_belt else ""
    return (f"给图1的人换上 {refs} 的衣服（保持她的脸型和发型不变、五官与身份一致，"
            f"并对她的面部做自然美颜处理：轻微磨皮、提亮肤色、气色红润，美颜自然不夸张），"
            f"衣服的款式、颜色、面料必须与参考图一致：{desc}。{belt_note}"
            f"竖向 3:4 比例，全身照（从头到脚，完整露出头顶和头发，头顶与图片上沿之间留一点空白，"
            f"把人物整体放在画面偏上位置，脚底与图片底部之间留出足够距离，鞋子完整露出），"
            f"脸部完整清晰、不要裁剪，"
            f"单人图（画面中只有她一个人），表情自然微笑、生动自然、有感染力，"
            f"{bg}，自然的走路姿态（迈步中），手臂自然摆动，"
            f"专业电商摄影风格，光线柔和，真实自然，美颜自然不过度")


def model_image_path_for(task_id: str) -> str:
    """中间产物（穿着商品的模特图）本地路径。"""
    return str(UPLOAD_DIR / f"{task_id}_model.png")


def model_image_path_for_product(product_id: str) -> str:
    """预生成的模特底图本地路径（按商品缓存，出图时复用，加速）。"""
    return str(DATA_DIR / "model-images" / f"{product_id}.png")


def beauty_path_for(task_id: str) -> str:
    """中间产物（美颜后的用户照片）本地路径。"""
    return str(UPLOAD_DIR / f"{task_id}_beauty.jpg")


def pose_ref_path() -> str:
    """换头换装工作流的"模特姿势参考图"（摄影棚白底，全请求复用）。"""
    return str(DATA_DIR / "pose-ref.png")


def photo_path_for(task_id: str, mime: str) -> str:
    ext = IMAGE_MIME_BY_EXT.get(mime, ".jpg")
    return str(UPLOAD_DIR / f"{task_id}{ext}")


def result_path_for(task_id: str) -> str:
    return str(RESULT_DIR / f"{task_id}.png")


def delete_file(path: str) -> None:
    if not path:
        return
    try:
        Path(path).unlink(missing_ok=True)
    except OSError:
        pass


def normalize_photo(src_path: str, dst_path: str, max_side: int = 1024, target_ratio: float = 3 / 4) -> None:
    """把用户照片归一化为安全尺寸与比例：长边缩放 + 白底填充到 3:4。

    避免 VTO 工作流按固定比例裁剪导致脸部被切掉；白底填充保留完整人物。
    """
    if Image is None:
        return
    img = Image.open(src_path).convert("RGB")
    w, h = img.size
    if w <= 0 or h <= 0:
        return
    # 1. 长边缩放到 max_side
    scale = max_side / max(w, h)
    if scale < 1:
        img = img.resize((max(1, round(w * scale)), max(1, round(h * scale))), Image.LANCZOS)
        w, h = img.size
    # 2. 白底填充到 3:4（纵向保留完整人物，横向补白）
    ratio = w / h
    if ratio < target_ratio:
        new_w = max(1, round(h * target_ratio))
        canvas = Image.new("RGB", (new_w, h), (255, 255, 255))
        canvas.paste(img, ((new_w - w) // 2, 0))
    elif ratio > target_ratio:
        new_h = max(1, round(w / target_ratio))
        canvas = Image.new("RGB", (w, new_h), (255, 255, 255))
        canvas.paste(img, (0, (new_h - h) // 2))
    else:
        canvas = img
    canvas.save(dst_path, "JPEG", quality=92)
