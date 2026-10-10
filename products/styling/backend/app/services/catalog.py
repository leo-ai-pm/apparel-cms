"""第一版模拟数据：授权商品库 + 穿搭知识库。

数据源决策（PRD 体检问题 2 = A）：第一版用内置模拟数据跑通链路，
真实商品库/知识库对接在二期用 MCP 接入。
"""

# 商品库（模拟授权商品）
PRODUCTS = [
    {"id": "P001", "name": "白色基础衬衫", "category": "上装", "season": ["春", "夏", "秋"],
     "style": ["通勤", "休闲"], "price": 159, "colors": ["白"], "body_fit": ["通用", "梨形", "苹果形"],
     "desc": "挺括棉质，百搭基础款，四季可穿"},
    {"id": "P002", "name": "藏青西装外套", "category": "上装", "season": ["春", "秋"],
     "style": ["通勤"], "price": 399, "colors": ["藏青"], "body_fit": ["通用", "梨形"],
     "desc": "修身剪裁，正式场合百搭"},
    {"id": "P003", "name": "米白针织开衫", "category": "上装", "season": ["春", "秋"],
     "style": ["优雅", "休闲"], "price": 259, "colors": ["米白"], "body_fit": ["通用"],
     "desc": "柔软亲肤，温柔气质款"},
    {"id": "P004", "name": "浅灰圆领T恤", "category": "上装", "season": ["夏"],
     "style": ["休闲"], "price": 89, "colors": ["浅灰"], "body_fit": ["通用"],
     "desc": "纯棉透气，日常百搭"},
    {"id": "P005", "name": "黑色高领打底衫", "category": "上装", "season": ["冬"],
     "style": ["通勤", "优雅"], "price": 129, "colors": ["黑"], "body_fit": ["通用", "梨形"],
     "desc": "修身保暖，叠穿内搭"},
    {"id": "P006", "name": "牛仔外套", "category": "上装", "season": ["春", "秋"],
     "style": ["休闲", "街头"], "price": 329, "colors": ["牛仔蓝"], "body_fit": ["通用"],
     "desc": "经典版型，休闲街头风"},
    {"id": "P007", "name": "A字半身裙", "category": "下装", "season": ["春", "夏", "秋"],
     "style": ["优雅", "通勤"], "price": 219, "colors": ["黑", "卡其"], "body_fit": ["梨形", "通用"],
     "desc": "高腰A字，遮胯显瘦，梨形身材友好"},
    {"id": "P008", "name": "直筒西装裤", "category": "下装", "season": ["春", "秋", "冬"],
     "style": ["通勤"], "price": 279, "colors": ["黑", "灰"], "body_fit": ["通用", "梨形", "苹果形"],
     "desc": "垂坠面料，通勤利落"},
    {"id": "P009", "name": "高腰阔腿裤", "category": "下装", "season": ["春", "夏", "秋"],
     "style": ["休闲", "优雅"], "price": 249, "colors": ["米白", "黑"], "body_fit": ["通用", "梨形"],
     "desc": "高腰拉长比例，小个子友好"},
    {"id": "P010", "name": "紧身牛仔裤", "category": "下装", "season": ["春", "秋", "冬"],
     "style": ["休闲", "街头"], "price": 299, "colors": ["深蓝"], "body_fit": ["通用"],
     "desc": "弹力显瘦，休闲百搭"},
    {"id": "P011", "name": "白色运动鞋", "category": "鞋", "season": ["春", "夏", "秋"],
     "style": ["休闲", "运动"], "price": 399, "colors": ["白"], "body_fit": ["通用"],
     "desc": "轻便百搭，日常通勤皆可"},
    {"id": "P012", "name": "黑色乐福鞋", "category": "鞋", "season": ["春", "秋"],
     "style": ["通勤", "优雅"], "price": 349, "colors": ["黑"], "body_fit": ["通用"],
     "desc": "简约通勤，优雅百搭"},
    {"id": "P013", "name": "棕色切尔西靴", "category": "鞋", "season": ["秋", "冬"],
     "style": ["通勤", "休闲"], "price": 459, "colors": ["棕"], "body_fit": ["通用"],
     "desc": "秋冬百搭，利落有型"},
    {"id": "P017", "name": "黑色平底单鞋", "category": "鞋", "season": ["春", "秋"],
     "style": ["通勤", "优雅"], "price": 129, "colors": ["黑"], "body_fit": ["通用"],
     "desc": "平价通勤百搭，舒适不累脚"},
    {"id": "P018", "name": "白色帆布鞋", "category": "鞋", "season": ["春", "夏", "秋"],
     "style": ["休闲"], "price": 159, "colors": ["白"], "body_fit": ["通用"],
     "desc": "平价休闲百搭，清爽减龄"},
    {"id": "P019", "name": "棕色平底乐福鞋", "category": "鞋", "season": ["春", "秋"],
     "style": ["通勤", "优雅"], "price": 189, "colors": ["棕"], "body_fit": ["通用"],
     "desc": "平价通勤乐福，优雅不累脚"},
    {"id": "P020", "name": "加绒平底短靴", "category": "鞋", "season": ["秋", "冬"],
     "style": ["通勤", "休闲"], "price": 199, "colors": ["黑"], "body_fit": ["通用"],
     "desc": "平价保暖短靴，秋冬通勤实用"},
    {"id": "P021", "name": "深蓝低帮休闲鞋", "category": "鞋", "season": ["春", "秋"],
     "style": ["休闲", "街头"], "price": 179, "colors": ["深蓝"], "body_fit": ["通用"],
     "desc": "平价休闲鞋，日常百搭"},
    {"id": "P014", "name": "细腰带", "category": "配饰", "season": ["春", "夏", "秋", "冬"],
     "style": ["通勤", "优雅"], "price": 79, "colors": ["黑", "棕"], "body_fit": ["通用"],
     "desc": "提高腰线，点睛配饰"},
    {"id": "P015", "name": "帆布托特包", "category": "配饰", "season": ["春", "夏", "秋"],
     "style": ["休闲", "通勤"], "price": 199, "colors": ["米白"], "body_fit": ["通用"],
     "desc": "大容量，通勤实用"},
    {"id": "P016", "name": "羊毛围巾", "category": "配饰", "season": ["冬"],
     "style": ["优雅", "通勤"], "price": 149, "colors": ["灰", "驼"], "body_fit": ["通用"],
     "desc": "保暖提升气质，冬日点缀"},
]

CATALOG_NAMES = {p["name"] for p in PRODUCTS}
CATALOG_IDS = {p["id"] for p in PRODUCTS}

# 穿搭知识库（模拟规则）
STYLE_RULES = [
    {"id": "R001", "scene": "通勤", "season": "春秋", "body_type": "梨形",
     "rule": "上浅下深，上装选合身款，下装选A字半裙或直筒西装裤遮胯", "reason": "平衡上下半身量感，突出上半身"},
    {"id": "R002", "scene": "通勤", "season": "春秋", "body_type": "通用",
     "rule": "衬衫/针织 + 直筒西装裤/半裙 + 乐福鞋，配色不超过三色", "reason": "正式不失亲和，耐看"},
    {"id": "R003", "scene": "约会", "season": "春秋", "body_type": "通用",
     "rule": "针织开衫 + A字半身裙 + 乐福鞋，柔和色系", "reason": "温柔气质，亲和力强"},
    {"id": "R004", "scene": "休闲", "season": "夏", "body_type": "通用",
     "rule": "浅色T恤 + 高腰阔腿裤 + 白色运动鞋", "reason": "清爽显高，舒适透气"},
    {"id": "R005", "scene": "通勤", "season": "冬", "body_type": "通用",
     "rule": "高领打底衫 + 西装外套 + 直筒西装裤 + 切尔西靴", "reason": "保暖利落，职场保暖两不误"},
    {"id": "R006", "scene": "休闲", "season": "秋冬", "body_type": "通用",
     "rule": "牛仔外套 + 紧身牛仔裤 + 切尔西靴", "reason": "经典休闲，显精神"},
    {"id": "R007", "body_type": "小个子", "rule": "强调高腰线，下装选高腰款，避免过长外套，鞋与下装同色显腿长",
     "reason": "拉长腿部视觉比例"},
    {"id": "R008", "body_type": "苹果形", "rule": "上装选V领或简洁款，下装选直筒/阔腿，避免紧身上衣", "reason": "弱化上半身，突出腿型优势"},
]


def search_products(category=None, season=None, style=None, max_price=None, body_type=None):
    results = PRODUCTS
    if category:
        results = [p for p in results if p["category"] == category]
    if season:
        results = [p for p in results if season in p["season"]]
    if style:
        results = [p for p in results if style in p["style"]]
    if body_type:
        results = [p for p in results if body_type in p["body_fit"] or "通用" in p["body_fit"]]
    if max_price is not None:
        results = [p for p in results if p["price"] <= max_price]
    return results


def search_rules(scene=None, season=None, body_type=None):
    results = STYLE_RULES
    if scene:
        results = [r for r in results if r.get("scene") == scene]
    if season:
        results = [r for r in results if season in r.get("season", season)]
    if body_type:
        results = [r for r in results if r.get("body_type") == body_type]
    if not results:
        results = STYLE_RULES
    return results
