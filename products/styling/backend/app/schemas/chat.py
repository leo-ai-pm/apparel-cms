from pydantic import BaseModel, ConfigDict, Field
from app.schemas.profile_snapshot import ProfileBinding, RequestConditions


class ChatRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    request_id: str = Field(default="", max_length=64, pattern=r"^[A-Za-z0-9_-]*$")
    session_id: str = Field(default="", max_length=64, description="会话 ID，空则后端生成")
    message: str = Field(..., min_length=1, max_length=4000, description="用户输入")
    budget: str = Field(default="", max_length=16, description="用户选择的预算（空=未选）")
    scene: str = Field(default="", max_length=20, description="场景（中文，如 通勤/出游/约会聚会，空则后端从文本识别）")
    profile_binding: ProfileBinding | None = None
    request_conditions: RequestConditions | None = None
