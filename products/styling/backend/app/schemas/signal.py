"""需求信号相关校验（PRD v1.3 + P0《数据契约》第 3 节枚举）。"""
from pydantic import BaseModel, Field

# P0 第 3 节枚举（与 CMS 侧 schemas/enums.py 严格一致）
SCENES = {"commute", "outing", "dating_party", "home", "sport"}
SEASONS = {"春", "夏", "秋", "冬"}
FEEDBACK_TYPES = {"intent", "simulated_cart", "real_purchase", "out_of_stock", "missing_image"}
ITEM_CATEGORIES = {"上装", "下装", "鞋履", "配饰"}


class UploadSignalRequest(BaseModel):
    feedback_type: str = Field(..., description="需求类型（运营上传时手动选择）；枚举校验在服务层统一返回")
