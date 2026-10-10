"""Strict styling_admin_context_v1 request, identity and metadata objects."""
import os
import re
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

ACTION_CONTRACT = "styling_admin_action_v1"
CONTEXT_CONTRACT = "styling_admin_context_v1"
_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z")
_ID = r"^[A-Za-z0-9_.:-]{1,160}$"
_SUBJECT = r"^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}$"
_UTC = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z\Z")


def _valid_utc(value):
    if not isinstance(value, str) or not _UTC.fullmatch(value):
        return False
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
        return True
    except ValueError:
        return False


def enabled():
    return os.getenv("STYLING_ADMIN_CONTEXT_ENABLED", "0").strip().lower() in {"1", "true", "enabled"}


class StrictObject(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class ExpectedAdminContext(StrictObject):
    context_contract: Literal["styling_admin_context_v1"]
    context_id: str = Field(min_length=43, max_length=43, pattern=r"^[A-Za-z0-9_-]+$")


class AuthorizationContext(ExpectedAdminContext):
    expires_at: str


class AdminActionFields(StrictObject):
    # Optional solely for the explicitly disabled old-mode compatibility branch.
    admin_action_contract: Literal["styling_admin_action_v1"] | None = None
    # Legacy IDs are accepted only for read-only ownership detection; a new
    # unmatched action is still required to be a canonical UUID in begin_action.
    request_id: str | None = Field(default=None, pattern=_ID)
    expected_admin_context: ExpectedAdminContext | None = None

    @model_validator(mode="after")
    def action_shape(self):
        if enabled():
            if self.expected_admin_context is None:
                raise ValueError("ADMIN_CONTEXT_REQUIRED")
            if self.admin_action_contract != ACTION_CONTRACT or not isinstance(self.request_id, str):
                raise ValueError("ADMIN_ACTION_INVALID")
        return self


class EmptyAdminAction(AdminActionFields):
    pass


class AdminIdentity(StrictObject):
    identity_contract: Literal["styling_admin_identity_v1"]
    subject: str = Field(pattern=_SUBJECT)
    role: Literal["styling-manager"]
    audience: Literal["personal_styling"]
    scope: str = Field(pattern=_SUBJECT)
    source_instance_id: str = Field(pattern=_SUBJECT)
    auth_method: Literal["password_single_account", "demo_server"]
    approval_identity_kind: Literal["account_bound"]
    expires_at: str
    authorization_context: AuthorizationContext

    @model_validator(mode="after")
    def matching_expiry(self):
        if self.expires_at != self.authorization_context.expires_at or not _valid_utc(self.expires_at):
            raise ValueError("invalid session expiry")
        return self


class OperationResultRef(StrictObject):
    kind: Literal["handoff", "frozen_evidence", "direct_delivery", "demand_occurrence", "demand_turn"]
    id: str = Field(pattern=_ID)
    revision: int | None = Field(ge=1)


class AdminOperationMetadata(StrictObject):
    operation_contract: Literal["styling_admin_action_v1"]
    request_id: str = Field(pattern=_ID)
    actor_subject: str = Field(pattern=_SUBJECT)
    operation_kind: Literal["approve", "reject", "retry", "evidence_export", "direct_send", "direct_reconcile", "direct_supplement", "logout"]
    context_binding: Literal["bound", "legacy_unbound"]
    operation_context_ref: str | None = Field(pattern=r"^[0-9a-f]{64}$")
    body_digest: str | None = Field(pattern=r"^[0-9a-f]{64}$")
    state: Literal["pending", "completed", "failed", "unconfirmed"]
    outcome: Literal["created", "reused_frozen", "received", "unconfirmed", "queued", "completed", "failed"] | None
    accepted_at: str | None
    completed_at: str | None
    result_ref: OperationResultRef | None

    @field_validator("accepted_at", "completed_at")
    @classmethod
    def utc_time(cls, value):
        if value is not None and not _valid_utc(value):
            raise ValueError("invalid UTC timestamp")
        return value

    @model_validator(mode="after")
    def state_semantics(self):
        if self.context_binding == "bound":
            if not self.operation_context_ref or not self.body_digest or self.accepted_at is None:
                raise ValueError("missing bound action facts")
            if self.state in {"completed", "failed"} and self.completed_at is None:
                raise ValueError("missing action finish time")
        elif self.operation_context_ref is not None or self.body_digest is not None:
            raise ValueError("legacy action must not invent binding")
        if self.state == "pending" and (self.outcome is not None or self.completed_at is not None):
            raise ValueError("pending finish facts forbidden")
        if self.state == "failed" and self.outcome != "failed":
            raise ValueError("failed outcome required")
        if self.state == "unconfirmed" and self.outcome != "unconfirmed":
            raise ValueError("unconfirmed outcome required")
        if self.state == "completed" and self.outcome not in {"created", "reused_frozen", "received", "queued", "completed"}:
            raise ValueError("completed outcome required")
        if self.operation_kind == "logout" and self.result_ref is not None:
            raise ValueError("logout cannot reveal session reference")
        return self
