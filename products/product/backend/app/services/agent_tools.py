"""产品需求智能体的只读工具白名单。工具结果保留来源，不授予写入权限。"""

import os
import re
from pathlib import Path
from typing import Any

import httpx
from dotenv import dotenv_values
from pydantic import BaseModel, Field, ValidationError

from ..core.config import BACKEND_DIR
from ..db import list_direct_signals

CATALOG_URL = "http://127.0.0.1:8110"
SCENE_CN = {"commute": "通勤", "outing": "出游", "dating_party": "约会聚会", "home": "居家", "sport": "运动"}
TAVILY_URL = "https://api.tavily.com/search"
_optional_knowledge_doc = os.environ.get("PRODUCT_KNOWLEDGE_DOC", "").strip() or str(dotenv_values(BACKEND_DIR / ".env").get("PRODUCT_KNOWLEDGE_DOC") or "").strip()
DOCS = [
    BACKEND_DIR.parent / "docs/阶段文档/产品需求工作台角色与审批流程.md",
    BACKEND_DIR.parent / "docs/阶段文档/PRD补全清单.md",
] + ([Path(_optional_knowledge_doc).expanduser()] if _optional_knowledge_doc else [])


class SearchArgs(BaseModel):
    query: str = Field(min_length=1, max_length=120)


class ProductArgs(BaseModel):
    category: str = Field(default="", max_length=30)
    query: str = Field(default="", max_length=80)


class ProductDetailArgs(BaseModel):
    product_id: str = Field(min_length=1, max_length=40)


def public_search_configured() -> bool:
    return bool(dotenv_values(BACKEND_DIR / ".env").get("TAVILY_API_KEY"))


def catalog_available() -> bool:
    try:
        return httpx.get(CATALOG_URL + "/api/v1/health", timeout=1, trust_env=False).status_code == 200
    except httpx.HTTPError:
        return False


def tool_definitions(allowed: set[str] | None = None) -> list[dict]:
    tools = [
        {"type": "function", "function": {"name": "search_internal_signals", "description": "查询穿搭型号中已脱敏的需求信号。适合核对是否有同类用户反馈、场景及来源；没有结果时不得编造。", "parameters": {"type": "object", "properties": {"query": {"type": "string", "description": "简短的品类、场景或问题关键词"}}, "required": ["query"]}}},
        {"type": "function", "function": {"name": "search_knowledge_base", "description": "查询产品需求工作台流程和穿搭 Agent 的本地需求文档，核对角色、审批和业务规则。只返回匹配摘录。", "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}},
    ]
    if catalog_available():
        tools.extend([
            {"type": "function", "function": {"name": "search_product_catalog", "description": "查询穿搭系统的商品目录，核对已有商品、尺码和库存标记。source=seed 是演示数据，不代表真实库存。", "parameters": {"type": "object", "properties": {"category": {"type": "string", "description": "如上装、下装、鞋履；可留空"}, "query": {"type": "string", "description": "商品名或材料关键词；可留空"}}}}},
            {"type": "function", "function": {"name": "get_product_detail", "description": "根据商品 ID 查询商品详情与来源标记。必须先取得真实存在的商品 ID。", "parameters": {"type": "object", "properties": {"product_id": {"type": "string"}}, "required": ["product_id"]}}},
        ])
    if public_search_configured():
        tools.append({"type": "function", "function": {"name": "search_public_sources", "description": "检索公开网页资料，用于行业、材料或竞品信息。只能搜索通用主题，不得把用户原话、内部编号或私人资料放入搜索词。引用时给出返回的真实 URL。", "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}}})
    return [tool for tool in tools if allowed is None or tool["function"]["name"] in allowed]


def tool_availability() -> dict[str, bool]:
    return {
        "search_internal_signals": True,
        "search_product_catalog": catalog_available(),
        "get_product_detail": catalog_available(),
        "search_knowledge_base": any(path.is_file() for path in DOCS),
        "search_public_sources": public_search_configured(),
    }


def _trace(tool: str, title: str, status: str, summary: str, sources: list[dict] | None = None) -> dict:
    return {"tool": tool, "title": title, "status": status, "summary": summary, "sources": sources or []}


def _search_signals(args: SearchArgs) -> tuple[dict, dict]:
    try:
        records = [record for record in list_direct_signals(limit=100)
                   if not str(record.get("signal_id", "")).startswith("SIG-DEMO-")]
    except Exception:
        return {"status": "unavailable", "records": []}, _trace("search_internal_signals", "穿搭型号", "unavailable", "穿搭型号数据暂时无法读取")
    words = [word for word in re.split(r"[\s/、，,＋+]+", args.query.lower()) if len(word) >= 2]
    matches = []
    for record in records:
        searchable = " ".join([*(str(record.get(key) or "") for key in ("scene", "season", "preference", "change_reason", "feedback_type")), SCENE_CN.get(str(record.get("scene") or ""), "")])
        if words and not any(word in searchable.lower() for word in words):
            continue
        matches.append({key: record.get(key) for key in ("signal_id", "timestamp", "scene", "season", "preference", "change_reason", "feedback_type", "source_agent")})
        if len(matches) == 5:
            break
    return {"status": "ok", "records": matches, "searched_count": len(records)}, _trace("search_internal_signals", "穿搭型号", "ok", f"查到 {len(matches)} 条匹配信号（检索范围 {len(records)} 条）", [{"label": item["signal_id"], "url": ""} for item in matches])


def _catalog_request(path: str, params: dict | None = None) -> Any:
    response = httpx.get(CATALOG_URL + path, params=params, timeout=5, trust_env=False)
    response.raise_for_status()
    return response.json()


def _compact_product(product: dict) -> dict:
    return {key: product.get(key) for key in ("product_id", "name", "category", "brand", "price", "size", "material", "stock_status", "source", "scene", "body_fit")}


def _search_products(args: ProductArgs) -> tuple[dict, dict]:
    params = {"category": args.category} if args.category else None
    try:
        data = _catalog_request("/api/v1/products", params)
    except (httpx.HTTPError, ValueError):
        return {"status": "unavailable", "products": []}, _trace("search_product_catalog", "穿搭商品目录", "unavailable", "商品目录暂时无法读取")
    products = data.get("products", []) if isinstance(data, dict) else []
    if args.query:
        query = args.query.lower()
        products = [item for item in products if query in " ".join(str(item.get(key) or "") for key in ("name", "material", "style_tags", "scene")).lower()]
    compact = [_compact_product(item) for item in products[:5]]
    seed_count = sum(item.get("source") == "seed" for item in compact)
    note = f"找到 {len(compact)} 件商品；其中 {seed_count} 件为演示商品，不能据此确认真实库存"
    return {"status": "ok", "products": compact, "total_matches": len(products)}, _trace("search_product_catalog", "穿搭商品目录", "ok", note, [{"label": item.get("product_id", ""), "url": ""} for item in compact])


def _product_detail(args: ProductDetailArgs) -> tuple[dict, dict]:
    if not re.fullmatch(r"[A-Za-z0-9_-]+", args.product_id):
        return {"status": "invalid_id"}, _trace("get_product_detail", "商品详情", "invalid", "商品 ID 格式不合法")
    try:
        data = _catalog_request(f"/api/v1/products/{args.product_id}")
    except (httpx.HTTPError, ValueError):
        return {"status": "unavailable"}, _trace("get_product_detail", "商品详情", "unavailable", "商品详情暂时无法读取")
    if not isinstance(data, dict) or data.get("error"):
        return {"status": "not_found"}, _trace("get_product_detail", "商品详情", "not_found", f"未找到商品 {args.product_id}")
    product = _compact_product(data)
    summary = f"已读取 {args.product_id}；来源 {product.get('source') or '未知'}，不能据此确认真实库存"
    return {"status": "ok", "product": product}, _trace("get_product_detail", "商品详情", "ok", summary, [{"label": args.product_id, "url": ""}])


def _search_public(args: SearchArgs) -> tuple[dict, dict]:
    key = dotenv_values(BACKEND_DIR / ".env").get("TAVILY_API_KEY")
    if not key:
        return {"status": "not_configured", "results": []}, _trace("search_public_sources", "公开资料检索", "unavailable", "未配置公开检索服务")
    if re.search(r"[\w.+-]+@[\w.-]+|\d{7,}|REQ-\d+|SIG-\w+", args.query, re.I):
        return {"status": "query_rejected", "results": []}, _trace("search_public_sources", "公开资料检索", "invalid", "搜索词疑似包含私人信息或内部编号，已拒绝发送")
    try:
        response = httpx.post(TAVILY_URL, headers={"Authorization": f"Bearer {key}"}, json={"query": args.query, "search_depth": "basic", "max_results": 3, "include_answer": False}, timeout=15)
        response.raise_for_status()
        data = response.json()
    except (httpx.HTTPError, ValueError):
        return {"status": "unavailable", "results": []}, _trace("search_public_sources", "公开资料检索", "unavailable", "公开资料检索失败")
    results = [{"title": str(item.get("title", ""))[:160], "url": str(item.get("url", ""))[:500], "snippet": str(item.get("content", ""))[:700]} for item in data.get("results", [])[:3]]
    return {"status": "ok", "results": results}, _trace("search_public_sources", "公开资料检索", "ok", f"查到 {len(results)} 条公开资料；网页内容需核对发布日期与原文", [{"label": item["title"], "url": item["url"]} for item in results])


def _search_knowledge(args: SearchArgs) -> tuple[dict, dict]:
    words = [word for word in re.split(r"[\s/、，,＋+？?]+", args.query.lower()) if len(word) >= 2]
    matches = []
    for path in DOCS:
        if not path.is_file():
            continue
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except (OSError, UnicodeError):
            continue
        for number, line in enumerate(lines, 1):
            if not line.strip() or not any(word in line.lower() for word in words):
                continue
            matches.append({"title": path.stem, "reference": f"{path.name}:{number}", "excerpt": line.strip()[:450]})
            if len(matches) >= 5:
                break
        if len(matches) >= 5:
            break
    return {"status": "ok", "matches": matches}, _trace("search_knowledge_base", "产品知识库", "ok", f"查到 {len(matches)} 段本地文档摘录", [{"label": item["reference"], "url": ""} for item in matches])


def execute_tool(name: str, raw_args: dict, allowed: set[str] | None = None) -> tuple[dict, dict]:
    if allowed is not None and name not in allowed:
        return {"status": "forbidden"}, _trace(name, "未授权工具", "forbidden", "此轮对话未启用该工具")
    try:
        if name == "search_internal_signals":
            return _search_signals(SearchArgs.model_validate(raw_args))
        if name == "search_product_catalog":
            return _search_products(ProductArgs.model_validate(raw_args))
        if name == "get_product_detail":
            return _product_detail(ProductDetailArgs.model_validate(raw_args))
        if name == "search_public_sources" and public_search_configured():
            return _search_public(SearchArgs.model_validate(raw_args))
        if name == "search_knowledge_base":
            return _search_knowledge(SearchArgs.model_validate(raw_args))
    except ValidationError:
        return {"status": "invalid_arguments"}, _trace(name, "工具参数", "invalid", "模型提供的工具参数不合法")
    return {"status": "forbidden"}, _trace(name, "未知工具", "forbidden", "工具不在只读白名单中")
