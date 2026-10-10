from app.services import permissions


def test_known_tools_are_allowed():
    for name in ["query_product_catalog", "query_style_knowledge", "read_user_profile", "validate_product_references"]:
        assert permissions.check_tool_permission(name) == "allow"


def test_unknown_tool_is_denied():
    assert permissions.check_tool_permission("add_to_cart") == "deny"
    assert permissions.check_tool_permission("make_payment") == "deny"


def test_detect_write_request():
    assert permissions.detect_write_request("帮我下单这件衣服") is True
    assert permissions.detect_write_request("我要付款") is True
    assert permissions.detect_write_request("加入购物车") is True


def test_detect_write_request_negative():
    assert permissions.detect_write_request("我想买一套通勤装，帮我推荐") is False
    assert permissions.detect_write_request("预算500以内") is False
