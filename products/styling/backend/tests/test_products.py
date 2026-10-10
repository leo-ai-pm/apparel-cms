from app.services import tools


def test_list_products(client):
    r = client.get("/api/v1/products")
    assert r.status_code == 200
    data = r.json()
    assert data["count"] > 0
    assert "products" in data
    p = data["products"][0]
    for k in ["product_id", "name", "category", "price", "image_url", "stock_status", "style_tags", "season", "scene"]:
        assert k in p


def test_list_products_filter_category(client):
    r = client.get("/api/v1/products", params={"category": "鞋履"})
    data = r.json()
    assert data["count"] > 0
    assert all(p["category"] == "鞋履" for p in data["products"])


def test_list_products_filter_price(client):
    r = client.get("/api/v1/products", params={"price_max": 100})
    data = r.json()
    assert all(p["price"] <= 100 for p in data["products"])


def test_get_product(client):
    r = client.get("/api/v1/products/P001")
    assert r.status_code == 200
    assert r.json()["product_id"] == "P001"


def test_get_product_not_found(client):
    r = client.get("/api/v1/products/P999")
    body = r.json()
    assert body["error"]["code"] == "NOT_FOUND"


def test_mcp_search_products():
    result = tools.execute_tool("catalog__search_products", {"category": "鞋履"}, {})
    assert result["products"]
    assert all(p["category"] == "鞋履" for p in result["products"])


def test_mcp_get_product():
    result = tools.execute_tool("catalog__get_product", {"product_id": "P001"}, {})
    assert result["product_id"] == "P001"


def test_mcp_get_product_not_found():
    result = tools.execute_tool("catalog__get_product", {"product_id": "P999"}, {})
    assert result["error"]["code"] == "NOT_FOUND"
