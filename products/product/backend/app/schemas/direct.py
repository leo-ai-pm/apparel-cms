"""Direct styling-to-product validation with no synthetic CMS transport fields."""
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import hashlib
import re

from app.core.errors import AppError
from app.schemas.dh import (PAYLOAD_MAX_BYTES, SUPPLEMENT_MAX_BYTES, decode_frozen_content, decode_json,
                            validate_frozen_evidence, validate_payload)
from app.schemas.privacy import assert_safe_content


_DELIVERY_FIELDS = {"transport_schema", "source_product", "target_product", "source_instance_id",
                    "target_instance_id", "authorized_scope", "handoff_id", "revision", "payload_digest",
                    "payload_base64", "source_approval_ref", "supplement"}
_BINDING_FIELDS = {"source_product", "target_product", "source_instance_id", "target_instance_id", "authorized_scope",
                   "source_approval_ref", "handoff_id", "revision", "payload_digest"}
_REQUEST_FIELDS = _BINDING_FIELDS | {"proof_schema", "verification_purpose", "nonce", "supplement_id", "supplement_digest"}
_PROOF_FIELDS = _REQUEST_FIELDS | {"metadata_digest", "approved_by", "approval_identity_kind", "approved_at",
                                    "verification_id", "verified_at", "approval_state", "operation_eligible", "data_origin"}
_HASH = re.compile(r"[0-9a-f]{64}\Z")
_NONCE = re.compile(r"(?:[0-9a-f]{2}){16,64}\Z")
_ISO = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})\Z")
_MESSAGES = {
    "DIRECT_DELIVERY_INVALID": "直接交接的字段或类型不符合契约。",
    "DIRECT_SCOPE_MISMATCH": "直接交接不属于当前授权空间。",
    "DIRECT_BINDING_MISMATCH": "直接交接的来源、目标或冻结需求绑定不一致。",
    "DIRECT_APPROVAL_TIME_INVALID": "来源批准时间不合法或晚于当前时间。",
    "DIRECT_PROOF_INVALID": "来源批准证明的字段、类型或请求格式不符合契约。",
    "DIRECT_PROOF_EXPIRED": "来源批准证明时间超出本次回查的有效窗口。",
    "APPROVAL_UNVERIFIED": "来源尚无本次操作所需的有效账户批准事实。",
    "APPROVAL_LEGACY_IDENTITY": "旧共享角色批准缺少账户归属证据，暂不能直接接收。",
    "APPROVAL_BINDING_MISMATCH": "来源批准证明与本次冻结交接或补充对象不一致。",
}


@dataclass(frozen=True)
class ValidatedDirect:
    envelope: dict
    payload_bytes: bytes
    payload: dict
    supplement_bytes: bytes | None
    supplement_id: str | None
    supplement_digest: str | None
    provenance_status: str
    warnings: list[str]


@dataclass(frozen=True)
class ValidatedSupplement:
    supplement_bytes: bytes
    supplement_id: str
    supplement_digest: str
    provenance_status: str
    warnings: list[str]
    content: dict


def _utcnow():
    return datetime.now(timezone.utc)


def _check(condition, code):
    if not condition:
        raise AppError(code, _MESSAGES[code], 403 if code == "DIRECT_SCOPE_MISMATCH" else 422)


def _shape(value, fields, code):
    _check(isinstance(value, dict) and set(value) == fields, code)


def _id(value, code):
    _check(isinstance(value, str) and 1 <= len(value) <= 128 and value == value.strip()
           and not any(ord(char) < 32 or 0xD800 <= ord(char) <= 0xDFFF for char in value), code)


def _integer(value, code):
    _check(type(value) is int and 1 <= value <= 2 ** 63 - 1, code)


def _digest(value, code):
    _check(isinstance(value, str) and _HASH.fullmatch(value) is not None, code)


def _approval_ref(value, code):
    _shape(value, {"approval_record_id"}, code)
    _id(value["approval_record_id"], code)


def _time(value, code, *, utc=False):
    _check(isinstance(value, str) and _ISO.fullmatch(value) is not None, code)
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        _check(False, code)
    _check(parsed.tzinfo is not None and (not utc or parsed.utcoffset() == timedelta(0)), code)
    return parsed


def _current_approval(payload):
    approved, _ = validate_payload(payload)
    _id(payload["handoff_id"], "DIRECT_DELIVERY_INVALID")
    for evidence in payload["evidence"]:
        _id(evidence["occurrence_id"], "DIRECT_DELIVERY_INVALID")
        _id(evidence["turn_id"], "DIRECT_DELIVERY_INVALID")
    _check(approved <= _utcnow(), "DIRECT_APPROVAL_TIME_INVALID")
    return approved


def _bound_supplement_ids(content):
    """The shared legacy validator leaves original identifier lengths intact."""
    code = "DIRECT_DELIVERY_INVALID"
    _id(content["approved_by"], code)
    _id(content["source_proof"]["exported_by"], code)
    for occurrence_id in content["evidence_revisions"]:
        _id(occurrence_id, code)
    provenances = []
    for occurrence_id, value in content["provenance"].items():
        _id(occurrence_id, code)
        provenances.append(value)
    for snapshot in content["source_snapshot"]:
        _id(snapshot["turn"]["id"], code)
        for occurrence in snapshot["occurrences"]:
            _id(occurrence["id"], code)
            _id(occurrence["turn_id"], code)
            provenances.append(occurrence)
    for value in provenances:
        for ref in value["context_turn_ids"]:
            _id(ref, code)
        for refs in value["field_sources"].values():
            for ref in refs:
                _id(ref, code)


def validate_supplement(supplement: dict, *, payload: dict, payload_bytes: bytes,
                        source_principal: str) -> ValidatedSupplement:
    """Validate an independent supplement envelope against a frozen original."""
    code = "DIRECT_DELIVERY_INVALID"
    _shape(supplement, {"supplement_id", "digest", "content_base64"}, code)
    _id(supplement["supplement_id"], code)
    _digest(supplement["digest"], code)
    _check(isinstance(payload_bytes, bytes) and decode_json(payload_bytes, max_bytes=PAYLOAD_MAX_BYTES) == payload,
           "DIRECT_BINDING_MISMATCH")
    _current_approval(payload)
    content_bytes, content = decode_frozen_content(supplement["content_base64"], supplement["digest"],
                                                    max_bytes=SUPPLEMENT_MAX_BYTES, code="DH_SUPPLEMENT_INVALID")
    # Privacy rejection does not rewrite the approved bytes or their digest.
    assert_safe_content(payload)
    assert_safe_content(content)
    assert_safe_content({"supplement_id": supplement["supplement_id"]})
    provenance_status, warnings = validate_frozen_evidence(
        content, payload=payload, payload_digest=hashlib.sha256(payload_bytes).hexdigest(), source_principal=source_principal)
    _bound_supplement_ids(content)
    return ValidatedSupplement(content_bytes, supplement["supplement_id"], supplement["digest"],
                               provenance_status, warnings, content)


def validate_direct(data: dict, *, source_instance_id: str, target_instance_id: str,
                    scope: str, source_principal: str) -> ValidatedDirect:
    code = "DIRECT_DELIVERY_INVALID"
    _shape(data, _DELIVERY_FIELDS, code)
    _check(data["transport_schema"] == "pa-direct-delivery/1", code)
    _check(data["source_product"] == "personal_styling" and data["target_product"] == "product_management", code)
    for field in ("source_instance_id", "target_instance_id", "authorized_scope", "handoff_id"):
        _id(data[field], code)
    _check(data["source_instance_id"] == source_instance_id and data["target_instance_id"] == target_instance_id,
           "DIRECT_BINDING_MISMATCH")
    _check(data["authorized_scope"] == scope, "DIRECT_SCOPE_MISMATCH")
    _integer(data["revision"], code)
    _digest(data["payload_digest"], code)
    _approval_ref(data["source_approval_ref"], code)
    payload_bytes, payload = decode_frozen_content(data["payload_base64"], data["payload_digest"],
                                                   max_bytes=PAYLOAD_MAX_BYTES)
    _current_approval(payload)
    _check(payload["handoff_id"] == data["handoff_id"] and payload["revision"] == data["revision"],
           "DIRECT_BINDING_MISMATCH")
    assert_safe_content(payload)
    assert_safe_content({key: value for key, value in data.items() if key not in {"payload_base64", "supplement"}})
    if data["supplement"] is None:
        return ValidatedDirect(deepcopy(data), payload_bytes, payload, None, None, None,
                               "incomplete", ["frozen_evidence_missing"])
    validated = validate_supplement(data["supplement"], payload=payload, payload_bytes=payload_bytes,
                                     source_principal=source_principal)
    return ValidatedDirect(deepcopy(data), payload_bytes, payload, validated.supplement_bytes, validated.supplement_id,
                           validated.supplement_digest, validated.provenance_status, validated.warnings)


def validate_proof(proof: dict, *, request: dict, delivery: ValidatedDirect, started_at: datetime) -> None:
    """Validate a fresh source response; caller owns trusted I/O and nonce use."""
    code, binding = "DIRECT_PROOF_INVALID", "APPROVAL_BINDING_MISMATCH"
    _shape(request, _REQUEST_FIELDS, code)
    _shape(proof, _PROOF_FIELDS, code)
    _check(request["proof_schema"] == "pa-direct-approval-proof/1", code)
    _check(isinstance(request["verification_purpose"], str)
           and request["verification_purpose"] in {"initial_delivery", "supplement_append"}, code)
    _check(isinstance(request["nonce"], str) and _NONCE.fullmatch(request["nonce"]) is not None, code)
    _approval_ref(request["source_approval_ref"], code)
    _integer(request["revision"], code)
    _integer(proof["revision"], code)
    for field in _BINDING_FIELDS:
        _check(request[field] == delivery.envelope[field], binding)
    _check(request["supplement_id"] == delivery.supplement_id
           and request["supplement_digest"] == delivery.supplement_digest, binding)
    _check(request["verification_purpose"] != "supplement_append" or delivery.supplement_bytes is not None, code)
    for field in _REQUEST_FIELDS:
        _check(proof[field] == request[field] and type(proof[field]) is type(request[field]), binding)
    _check(proof["approval_identity_kind"] != "legacy_shared_role", "APPROVAL_LEGACY_IDENTITY")
    _check(proof["approval_identity_kind"] == "account_bound" and proof["approval_state"] == "approved"
           and proof["operation_eligible"] is True, "APPROVAL_UNVERIFIED")
    _id(proof["approved_by"], code)
    _id(proof["verification_id"], code)
    _digest(proof["metadata_digest"], code)
    _check(proof["approved_at"] == delivery.payload["approved_at"]
           and proof["data_origin"] == delivery.payload["data_origin"], binding)
    approved = _time(proof["approved_at"], code)
    verified = _time(proof["verified_at"], code, utc=True)
    _check(isinstance(started_at, datetime) and started_at.tzinfo is not None
           and started_at.utcoffset() == timedelta(0), code)
    now = _utcnow()
    _check(approved <= now, "DIRECT_APPROVAL_TIME_INVALID")
    _check(approved <= verified, binding)
    _check(started_at - timedelta(seconds=60) <= verified <= now + timedelta(seconds=60)
           and now - verified <= timedelta(seconds=120), "DIRECT_PROOF_EXPIRED")
    if delivery.supplement_bytes is not None:
        supplement = decode_json(delivery.supplement_bytes, max_bytes=SUPPLEMENT_MAX_BYTES)
        _check(supplement["approved_by"] == proof["approved_by"]
               and supplement["approved_at"] == proof["approved_at"]
               and supplement["source_proof"]["metadata_digest"] == proof["metadata_digest"], binding)
    assert_safe_content(proof)
