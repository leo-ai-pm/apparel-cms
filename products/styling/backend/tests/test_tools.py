from app.services import tools
from app.services import catalog


def test_query_product_catalog_filters_by_category():
    result = tools.execute_tool("query_product_catalog", {"category": "鞋"}, {})
    ids = [p["id"] for p in result["products"]]
    assert "P011" in ids and "P012" in ids
    assert all(p["category"] == "鞋" for p in result["products"])


def test_query_product_catalog_price_filter():
    result = tools.execute_tool("query_product_catalog", {"max_price": 100}, {})
    assert all(p["price"] <= 100 for p in result["products"])


def test_validate_product_references_flags_fake():
    result = tools.execute_tool("validate_product_references", {"product_ids": ["P001", "P999"]}, {})
    assert result["valid"] == ["P001"]
    assert result["invalid"] == ["P999"]


def test_read_user_profile_returns_requested_fields():
    ctx = {"profile": {"身高": "160cm", "体型": "梨形"}}
    result = tools.execute_tool("read_user_profile", {"fields": ["身高", "体型"]}, ctx)
    assert result == {"身高": "160cm", "体型": "梨形"}


def test_unknown_tool_returns_error():
    result = tools.execute_tool("nonexistent", {}, {})
    assert result["error"]["code"] == "UNKNOWN_TOOL"
