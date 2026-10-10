"""归因去重（最简版）：按反馈类型计数 + 三选一/组合归因 + 去重口径。

规则完全对齐 PRD 第 3.2 节与 5 节速查表：
- intent / simulated_cart / real_purchase → 分别计数
- out_of_stock / missing_image → 不计入三计数，只置 supply_gap / image_gap
- style_demand = 是否存在 real_purchase（人工可覆盖）
- 主归因优先级：真实需求 > 缺货 > 缺图 > 意图加购（矛盾 1 裁决）
"""

from collections import Counter

from ..schemas.package import Attribution, SampleCount
from ..schemas.signal import CmsSignal

SCENE_CN = {
    "commute": "通勤",
    "outing": "出游",
    "dating_party": "约会聚会",
    "home": "居家",
    "sport": "运动",
}

DEDUP_RULE = "同场景+同品类+同缺口类型合并；不同用户但同诉求计为同一样本"
SOURCE = "穿搭 Agent 需求信号，经人工上传后汇总"


def main_type_of(attribution: dict) -> str:
    if attribution.get("style_demand"):
        return "真实需求"
    if attribution.get("supply_gap"):
        return "缺货"
    if attribution.get("image_gap"):
        return "缺图"
    return "意图加购"


def _dominant(items) -> str | None:
    if not items:
        return None
    return Counter(items).most_common(1)[0][0]


def suggest_priority(counts: dict, attribution: dict) -> tuple[str, str]:
    """Transparent triage suggestion; P0 requires a human decision."""
    if attribution.get("style_demand") and counts["real_purchase"] >= 2:
        return "P1", "至少两条真实成交信号，建议优先核对设计需求"
    if attribution.get("style_demand") or counts["simulated_cart"] >= 2:
        return "P2", "有成交信号或重复模拟加购，建议进入常规评估"
    return "P3", "现有证据较弱，建议继续收集；P0 只能由负责人明确指定"


def aggregate(signals: list[CmsSignal]) -> dict:
    counts = {"intent": 0, "simulated_cart": 0, "real_purchase": 0}
    supply_gap = False
    image_gap = False
    scenes: list[str] = []
    categories: list[str] = []
    seasons: list[str] = []

    for s in signals:
        ft = s.feedback_type
        if ft == "intent":
            counts["intent"] += 1
        elif ft == "simulated_cart":
            counts["simulated_cart"] += 1
        elif ft == "real_purchase":
            counts["real_purchase"] += 1
        elif ft == "out_of_stock":
            supply_gap = True
        elif ft == "missing_image":
            image_gap = True
        scenes.append(s.scene)
        if s.season:
            seasons.append(s.season)
        if s.outfit_plan:
            for item in s.outfit_plan.items:
                categories.append(item.category)

    style_demand = counts["real_purchase"] > 0
    attribution = Attribution(supply_gap=supply_gap, image_gap=image_gap, style_demand=style_demand)
    priority, priority_basis = suggest_priority(counts, attribution.model_dump())

    scene_cn = SCENE_CN.get(_dominant(scenes) or "", "通勤")
    category = _dominant(categories) or "下装"
    season = _dominant(seasons)

    dedup_key = f"{scene_cn}-{category}-{main_type_of(attribution.model_dump())}"

    default_constraints = [f"场景：{scene_cn}"]
    if season:
        default_constraints.append(f"季节：{season}")

    return {
        "signal_ids": [s.signal_id for s in signals],
        "sample_count": SampleCount(**counts),
        "attribution": attribution,
        "dedup_key": dedup_key,
        "dedup_rule": DEDUP_RULE,
        "source": SOURCE,
        "scene_cn": scene_cn,
        "category": category,
        "season": season,
        "default_constraints": default_constraints,
        "priority": priority,
        "priority_basis": priority_basis,
    }
