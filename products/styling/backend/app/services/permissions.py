"""权限系统：工具白名单 + 写入类操作确定性拒绝。"""

# 工具白名单：只读工具，全部 allow；其余一律 deny
TOOL_PERMISSIONS = {
    "query_product_catalog": "allow",
    "query_style_knowledge": "allow",
    "read_user_profile": "allow",
    "validate_product_references": "allow",
    "catalog__search_products": "allow",
    "catalog__get_product": "allow",
}

# 写入类动作关键词（执行交易类，确定性拒绝，不交给模型判断）
WRITE_ACTION_KEYWORDS = [
    "下单", "付款", "支付", "结算", "结账", "加购", "加入购物车", "替我下单", "帮我下单",
]

REFUSAL_TEXT = (
    "该操作未被授权：本助手仅提供穿搭建议，不支持加购、下单、付款或修改商品数据。"
)


def check_tool_permission(tool_name: str) -> str:
    return TOOL_PERMISSIONS.get(tool_name, "deny")


def detect_write_request(text: str) -> bool:
    return any(k in text for k in WRITE_ACTION_KEYWORDS)
