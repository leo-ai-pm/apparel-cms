from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class SignalContext(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(min_length=1, max_length=60)
    title: str = Field(min_length=1, max_length=120)
    quote: str = Field(min_length=1, max_length=500)
    source: str = Field(min_length=1, max_length=80)
    category: str = Field(min_length=1, max_length=80)
    intent: int = Field(ge=0, le=1000000)
    cart: int = Field(ge=0, le=1000000)
    sales: int = Field(ge=0, le=1000000)


class ChatTurn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=1500)


class ChatRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    signal: SignalContext
    question: str = Field(min_length=1, max_length=1500)
    history: list[ChatTurn] = Field(default_factory=list, max_length=12)
    mode: Literal["answer", "plan"] = "answer"
    allowed_tools: list[Literal["search_internal_signals", "search_product_catalog", "get_product_detail", "search_knowledge_base", "search_public_sources"]] = Field(default_factory=lambda: ["search_internal_signals", "search_product_catalog", "get_product_detail", "search_knowledge_base"], min_length=1, max_length=5)


class AnalysisRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    signal: SignalContext


class AnalysisResult(BaseModel):
    model_config = ConfigDict(extra="ignore")

    diagnosis: str = Field(min_length=1, max_length=500)
    grouping: str = Field(min_length=1, max_length=500)
    counter: str = Field(min_length=1, max_length=500)
    action: str = Field(min_length=1, max_length=500)
    draft: str = Field(min_length=1, max_length=1000)
