"""consumer_profile_v1: explicit intent, nullable patches and shared input bounds."""
import math
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

PROFILE_CONTRACT = "consumer_profile_v1"
Identifier = Annotated[str, Field(strict=True, min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")]


class ProfileError(Exception):
    def __init__(self, code: str, message: str, status: int = 422):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


class StrictObject(BaseModel):
    model_config = ConfigDict(extra="forbid")


class Size(StrictObject):
    system: Literal["clothing_alpha", "cn_shoe"]
    value: str = Field(strict=True)

    @model_validator(mode="after")
    def allowed_value(self):
        allowed = {"S", "M", "L", "XL"} if self.system == "clothing_alpha" else {str(i) for i in range(35, 41)}
        if self.value not in allowed:
            raise ValueError("PROFILE_INVALID_SIZE")
        return self


class UsualSizes(StrictObject):
    top: Size | None = None
    bottom: Size | None = None
    shoes: Size | None = None

    @model_validator(mode="after")
    def correct_slot(self):
        for slot in ("top", "bottom", "shoes"):
            value = getattr(self, slot)
            expected = "cn_shoe" if slot == "shoes" else "clothing_alpha"
            if value is not None and value.system != expected:
                raise ValueError("PROFILE_SIZE_SYSTEM_MISMATCH")
        return self


class ProfileFields(StrictObject):
    height_cm: float | None = None
    weight_kg: float | None = None
    usual_sizes: UsualSizes | None = Field(default_factory=UsualSizes)

    @field_validator("height_cm", "weight_kg", mode="before")
    @classmethod
    def valid_measurement(cls, value, info):
        if value is None:
            return None
        low, high = (100, 250) if info.field_name == "height_cm" else (20, 300)
        if (isinstance(value, bool) or not isinstance(value, (int, float))
                or not math.isfinite(value) or value < low or value > high or value * 2 != int(value * 2)):
            raise ValueError("PROFILE_INVALID_MEASUREMENT")
        return value


class ProfilePatch(StrictObject):
    base_profile: ProfileFields | None = None
    default_budget_fen: int | None = Field(default=None, strict=True, ge=1, le=100_000_000)


class ExpectedAuthorizationContext(StrictObject):
    context_contract: Literal["consumer_profile_mutation_context_v1"]
    context_id: Identifier
    operation_token: str = Field(strict=True, min_length=43, max_length=43, pattern=r"^[A-Za-z0-9_-]+$")


class AuthorizationContext(ExpectedAuthorizationContext):
    issued_at: str
    expires_at: str


class ProfileMutation(StrictObject):
    profile_action_id: Identifier
    operation: Literal["save", "update", "clear"]
    expected_profile_version: int = Field(strict=True, ge=0)
    expected_authorization_context: ExpectedAuthorizationContext
    patch: ProfilePatch = Field(default_factory=ProfilePatch)
    explicit_save: bool = Field(default=False, strict=True)
    explicit_default_budget: bool = Field(default=False, strict=True)

    @model_validator(mode="after")
    def explicit_intent(self):
        patch = self.patch.model_dump(mode="json", exclude_unset=True)
        if self.operation == "clear":
            if patch:
                raise ValueError("PROFILE_CLEAR_MUST_BE_ALL")
        else:
            if not self.explicit_save:
                raise ValueError("PROFILE_EXPLICIT_SAVE_REQUIRED")
            if not patch or patch == {"base_profile": {}} or patch == {"base_profile": {"usual_sizes": {}}}:
                raise ValueError("PROFILE_PATCH_EMPTY")
            if "default_budget_fen" in patch and not self.explicit_default_budget:
                raise ValueError("PROFILE_DEFAULT_BUDGET_CONFIRMATION_REQUIRED")
        return self


class SavedProfileResponse(StrictObject):
    profile_contract: Literal["consumer_profile_v1"]
    profile_id: Identifier | None
    profile_version: int = Field(strict=True, ge=0)
    scope_kind: Literal["device", "user"]
    status: Literal["empty", "saved", "cleared", "expired"]
    base_profile: ProfileFields
    default_budget_fen: int | None = Field(strict=True, ge=1, le=100_000_000)
    updated_at: str | None
    expires_at: str | None
    storage_notice: str


class SavedProfileReadResponse(SavedProfileResponse):
    authorization_context: AuthorizationContext


class ProfileOperationResponse(StrictObject):
    profile_contract: Literal["consumer_profile_v1"]
    profile_action_id: Identifier
    operation: Literal["save", "update", "clear", "expire"]
    profile_id: Identifier
    scope_kind: Literal["device", "user"]
    version_before: int = Field(strict=True, ge=0)
    profile_version: int = Field(strict=True, ge=1)
    profile_status: Literal["saved", "cleared", "expired"]
    changed_field_names: list[str]
    status: Literal["succeeded"]
    created_at: str
