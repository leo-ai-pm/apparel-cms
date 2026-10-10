"""工具系统：工具白名单 + 执行器。

四个工具全部只读，副作用为无；写入类操作（加购/下单/付款）不在白名单内，天然被拒绝。
"""
from app.services import catalog

# 供模型函数调用（OpenAI 兼容格式）
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "query_product_catalog",
            "description": "查询授权商品库中的商品事实（名称/品类/季节/风格/价格/适配体型）。筛选条件可留空以放宽范围。",
            "parameters": {
                "type": "object",
                "properties": {
                    "category": {"type": "string", "enum": ["上装", "下装", "鞋", "配饰"]},
                    "season": {"type": "string", "enum": ["春", "夏", "秋", "冬"]},
                    "style": {"type": "string", "enum": ["通勤", "休闲", "优雅", "运动", "街头"]},
                    "body_type": {"type": "string", "enum": ["通用", "梨形", "苹果形", "小个子"]},
                    "max_price": {"type": "number"},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "query_style_knowledge",
            "description": "查询穿搭知识库中的搭配规则与适配理由（按场景/季节/体型）。",
            "parameters": {
                "type": "object",
                "properties": {
                    "scene": {"type": "string"},
                    "season": {"type": "string"},
                    "body_type": {"type": "string"},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_user_profile",
            "description": "读取用户在当前会话中已提供的画像/体型字段（仅当前会话，不跨会话）。",
            "parameters": {
                "type": "object",
                "properties": {
                    "fields": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["fields"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "validate_product_references",
            "description": "输出方案前核查推荐引用的商品是否都在授权商品库内，防止编造商品。",
            "parameters": {
                "type": "object",
                "properties": {
                    "product_ids": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["product_ids"],
            },
        },
    },
]


# MCP 工具（PRD v1.2 第 11.2 节）：商品库检索/详情，供外部系统 MCP 集成与后续 VTO 使用
MCP_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "catalog__search_products",
            "description": "按品类/价格/颜色/风格/季节/场景筛选商品库",
            "parameters": {
                "type": "object",
                "properties": {
                    "category": {"type": "string", "enum": ["上装", "下装", "鞋履", "配饰"]},
                    "price_min": {"type": "number"},
                    "price_max": {"type": "number"},
                    "color": {"type": "string"},
                    "style": {"type": "string"},
                    "season": {"type": "string"},
                    "scene": {"type": "string"},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "catalog__get_product",
            "description": "按商品 ID 获取商品详情",
            "parameters": {
                "type": "object",
                "properties": {"product_id": {"type": "string"}},
                "required": ["product_id"],
            },
        },
    },
]


def _search_products_db(args: dict) -> list[dict]:
    from app.core.database import SessionLocal
    from app.models.product import Product, to_dict
    db = SessionLocal()
    try:
        q = db.query(Product)
        if args.get("category"):
            q = q.filter(Product.category == args["category"])
        if args.get("price_min") is not None:
            q = q.filter(Product.price >= args["price_min"])
        if args.get("price_max") is not None:
            q = q.filter(Product.price <= args["price_max"])
        if args.get("color"):
            q = q.filter(Product.color.contains(args["color"]))
        if args.get("style"):
            q = q.filter(Product.style_tags.contains(args["style"]))
        if args.get("season"):
            q = q.filter(Product.season.contains(args["season"]))
        if args.get("scene"):
            q = q.filter(Product.scene.contains(args["scene"]))
        return [to_dict(p) for p in q.all()]
    finally:
        db.close()


def _get_product_db(product_id: str) -> dict:
    from app.core.database import SessionLocal
    from app.models.product import Product, to_dict
    db = SessionLocal()
    try:
        p = db.get(Product, product_id)
        if p is None:
            return {"error": {"code": "NOT_FOUND", "message": f"商品 {product_id} 不存在"}}
        return to_dict(p)
    finally:
        db.close()


def execute_tool(name: str, args: dict, context: dict) -> dict:
    if name == "query_product_catalog":
        return {
            "products": catalog.search_products(
                category=args.get("category"),
                season=args.get("season"),
                style=args.get("style"),
                body_type=args.get("body_type"),
                max_price=args.get("max_price"),
            ),
        }
    if name == "query_style_knowledge":
        return {
            "rules": catalog.search_rules(
                scene=args.get("scene"),
                season=args.get("season"),
                body_type=args.get("body_type"),
            ),
        }
    if name == "read_user_profile":
        profile = context.get("profile") or {}
        fields = args.get("fields") or []
        return {f: profile.get(f) for f in fields}
    if name == "validate_product_references":
        ids = args.get("product_ids") or []
        valid = [i for i in ids if i in catalog.CATALOG_IDS]
        invalid = [i for i in ids if i not in catalog.CATALOG_IDS]
        return {"valid": valid, "invalid": invalid, "invalid_reason": "不在授权商品库内"}
    if name == "catalog__search_products":
        return {"products": _search_products_db(args)}
    if name == "catalog__get_product":
        return _get_product_db(args.get("product_id", ""))
    return {"error": {"code": "UNKNOWN_TOOL", "message": f"未知工具 {name}"}}
