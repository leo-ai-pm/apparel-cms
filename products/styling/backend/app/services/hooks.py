"""安全钩子：输出前的确定性合规检查。"""
import re

from app.services import catalog

# 承诺试穿/合身效果的红线表述
TRIAL_CLAIM_PATTERNS = [
    r"保证合身", r"保证显瘦", r"一定合身", r"绝对合身", r"承诺试穿", r"承诺.*合身", r"100%合身",
]

DISCLAIMER = "（温馨提示：以上建议仅供参考，不承诺真实试穿或合身效果。）"


def check_trial_claims(text: str) -> tuple[list[str], str]:
    """返回（命中的违规表述, 改写后的文本）。"""
    violations = []
    for pat in TRIAL_CLAIM_PATTERNS:
        if re.search(pat, text):
            violations.append(pat)
    if violations:
        text = text.rstrip() + "\n\n" + DISCLAIMER
    return violations, text


def check_fabricated_products(text: str) -> tuple[list[str], str]:
    """校验商品清单行（`- 「商品名」｜…`）中的商品名是否都在授权商品库内，防止编造商品。

    只匹配后跟「｜」的「」内容（商品清单格式），避免把「不限季节/风格」这类非商品强调词误报。
    """
    names = re.findall(r"「([^」]+)」(?=｜)", text)
    invalid = [n for n in names if n not in catalog.CATALOG_NAMES]
    if invalid:
        text = text.rstrip() + "\n\n（提示：以下商品未在授权商品库中找到，请忽略："
        text += "、".join(invalid) + "）"
    return invalid, text


def apply_all(text: str) -> str:
    _, text = check_trial_claims(text)
    _, text = check_fabricated_products(text)
    return text
