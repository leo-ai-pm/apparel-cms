from app.services import hooks


def test_trial_claim_detected_and_disclaimed():
    violations, text = hooks.check_trial_claims("这套搭配保证合身，显瘦")
    assert violations
    assert "仅供参考" in text


def test_no_trial_claim_no_change():
    violations, text = hooks.check_trial_claims("这套搭配适合通勤场合")
    assert violations == []
    assert "仅供参考" not in text


def test_fabricated_product_flagged():
    text = "- 「白色基础衬衫」｜上装｜¥159｜好\n- 「太空宇航服」｜上装｜¥999｜不存在"
    invalid, text = hooks.check_fabricated_products(text)
    assert "太空宇航服" in invalid
    assert "未在授权商品库" in text


def test_valid_products_pass():
    text = "- 「白色基础衬衫」｜上装｜¥159｜好\n- 「A字半身裙」｜下装｜¥219｜好"
    invalid, text = hooks.check_fabricated_products(text)
    assert invalid == []
    assert "未在授权商品库" not in text


def test_inline_emphasis_not_flagged():
    # 非商品清单行的「」不应误报为编造商品
    invalid, text = hooks.check_fabricated_products("放宽到「不限季节/风格」再查一次")
    assert invalid == []
    assert "未在授权商品库" not in text
