from app.services.aggregate import aggregate


def test_counts_and_attribution(make_signal):
    signals = [
        make_signal("S1", "intent"),
        make_signal("S2", "intent"),
        make_signal("S3", "simulated_cart"),
        make_signal("S4", "real_purchase"),
        make_signal("S5", "real_purchase"),
        make_signal("S6", "out_of_stock"),
        make_signal("S7", "missing_image"),
    ]
    agg = aggregate(signals)
    sc = agg["sample_count"]
    assert sc.intent == 2
    assert sc.simulated_cart == 1
    assert sc.real_purchase == 2

    at = agg["attribution"]
    assert at.supply_gap is True
    assert at.image_gap is True
    assert at.style_demand is True  # real_purchase 存在


def test_out_of_stock_not_counted_and_no_style_demand(make_signal):
    agg = aggregate([make_signal("S1", "out_of_stock")])
    assert agg["sample_count"].real_purchase == 0
    assert agg["sample_count"].intent == 0
    assert agg["attribution"].supply_gap is True
    assert agg["attribution"].style_demand is False


def test_intent_only_no_style_demand(make_signal):
    agg = aggregate([make_signal("S1", "intent"), make_signal("S2", "simulated_cart")])
    assert agg["attribution"].style_demand is False
    assert agg["dedup_key"].endswith("-意图加购")


def test_dedup_key_priority(make_signal):
    # real_purchase 优先 → 真实需求
    agg = aggregate([make_signal("S1", "real_purchase"), make_signal("S2", "out_of_stock")])
    assert agg["dedup_key"].endswith("-真实需求")
    # 只有缺货 → 缺货
    agg2 = aggregate([make_signal("S1", "out_of_stock")])
    assert agg2["dedup_key"].endswith("-缺货")
    # 只有缺图 → 缺图
    agg3 = aggregate([make_signal("S1", "missing_image")])
    assert agg3["dedup_key"].endswith("-缺图")


def test_dominant_scene_and_category(make_signal):
    signals = [
        make_signal("S1", "intent", scene="commute", categories=["上装"]),
        make_signal("S2", "intent", scene="commute", categories=["上装"]),
        make_signal("S3", "intent", scene="outing", categories=["鞋履"]),
    ]
    agg = aggregate(signals)
    assert agg["dedup_key"].startswith("通勤-上装-")
    assert agg["scene_cn"] == "通勤"
    assert agg["category"] == "上装"


def test_default_constraints_include_scene_and_season(make_signal):
    agg = aggregate([make_signal("S1", "intent", scene="commute", season="秋")])
    assert "场景：通勤" in agg["default_constraints"]
    assert "季节：秋" in agg["default_constraints"]
