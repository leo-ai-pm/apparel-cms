"""Pure frozen DH 1.4 validation, extracted from the earlier product adapter.
No CMS delivery, database, identity, configuration or network code is included.
"""
import base64
import binascii
from datetime import datetime, timedelta
import hashlib
import json
import math
import re

from app.core.errors import AppError


DELIVERY_MAX_BYTES = 8 * 1024 * 1024
PAYLOAD_MAX_BYTES = 1024 * 1024
SUPPLEMENT_MAX_BYTES = 4 * 1024 * 1024
_ATTRIBUTES = {"season", "scene", "category", "fit", "silhouette"}
_ORIGINS = {"synthetic", "runtime_demo", "mixed_demo"}
_HEX = re.compile(r"[0-9a-f]{64}\Z")
_TIME = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})\Z")
_MESSAGES = {
    "JSON_INVALID": "收到的内容不是有效的严格UTF-8 JSON对象。",
    "INPUT_TOO_LARGE": "收到的内容超过接口大小限制。",
    "DH_DELIVERY_INVALID": "CMS交接信封字段或来源验证状态不符合契约。",
    "DH_SCOPE_MISMATCH": "CMS交接记录不属于当前授权空间。",
    "DH_DIGEST_MISMATCH": "冻结内容的原字节摘要不匹配。",
    "DH_RECEIPT_MISMATCH": "CMS回执与请求的冻结交接身份不匹配。",
    "DH_SCHEMA_UNSUPPORTED": "冻结交接协议版本暂不支持。",
    "DH_PAYLOAD_INVALID": "冻结需求的字段、类型或证据计数不符合契约。",
    "DH_SUPPLEMENT_INVALID": "冻结证据补充对象的字段或类型不符合契约。",
    "DH_PROVENANCE_BINDING_MISMATCH": "冻结证据补充对象与原批准需求的绑定不匹配。",
    "DH_WINDOW_INVALID": "冻结时间窗口或证据时间不符合契约。",
    "DH_SOURCE_REFERENCE_INVALID": "冻结来源的会话、时间或引用绑定不符合契约。",
}



def _fail(code):
    status = 403 if code == "DH_SCOPE_MISMATCH" else 413 if code == "INPUT_TOO_LARGE" else 422
    raise AppError(code, _MESSAGES[code], status)


def _check(condition, code):
    if not condition:
        _fail(code)


def _text(value, code, *, empty=False):
    _check(isinstance(value, str), code)
    _check(empty or bool(value.strip()), code)
    # JSON escaped lone surrogates are not valid UTF-8 text either.
    try:
        value.encode("utf-8", errors="strict")
    except UnicodeError:
        _fail(code)
    return value


def _shape(value, keys, code):
    _check(isinstance(value, dict) and set(value) == set(keys), code)
    return value


def _integer(value, code, *, minimum=1):
    # The persisted identity uses SQLite INTEGER; reject overflow before writes.
    _check(type(value) is int and minimum <= value <= 2 ** 63 - 1, code)
    return value


def _digest(value, code):
    _text(value, code)
    _check(_HEX.fullmatch(value) is not None, code)
    return value


def _time(value, code, *, utc=False):
    _text(value, code)
    _check(_TIME.fullmatch(value) is not None, code)
    try:
        stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        _fail(code)
    _check(stamp.tzinfo is not None and stamp.utcoffset() is not None, code)
    if utc:
        _check(stamp.utcoffset() == timedelta(0), code)
    return stamp


def _origin(value, code):
    _text(value, code)
    _check(value in _ORIGINS, code)


def _unique_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            _fail("JSON_INVALID")
        result[key] = value
    return result


def decode_json(raw: bytes, *, max_bytes: int = DELIVERY_MAX_BYTES) -> dict:
    """Decode one bounded JSON object, rejecting ambiguous keys and constants."""
    _check(isinstance(raw, bytes), "JSON_INVALID")
    _check(len(raw) <= max_bytes, "INPUT_TOO_LARGE")
    try:
        data = json.loads(raw.decode("utf-8", errors="strict"), object_pairs_hook=_unique_pairs,
                          parse_constant=lambda _: _fail("JSON_INVALID"))
    except (UnicodeError, ValueError, RecursionError):
        _fail("JSON_INVALID")
    _check(isinstance(data, dict), "JSON_INVALID")
    # Check every decoded string, including escaped object keys, without recursion.
    remaining = [data]
    while remaining:
        value = remaining.pop()
        if isinstance(value, str):
            _text(value, "JSON_INVALID", empty=True)
        elif isinstance(value, dict):
            remaining.extend(value.keys())
            remaining.extend(value.values())
        elif isinstance(value, list):
            remaining.extend(value)
        elif isinstance(value, float):
            _check(math.isfinite(value), "JSON_INVALID")
    return data


def _decode_content(encoded, expected_digest, limit, code):
    _text(encoded, code)
    _digest(expected_digest, code)
    _check(len(encoded) <= 4 * ((limit + 2) // 3), "INPUT_TOO_LARGE")
    try:
        content = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        _fail(code)
    _check(len(content) <= limit, "INPUT_TOO_LARGE")
    _check(base64.b64encode(content).decode("ascii") == encoded, code)
    _check(hashlib.sha256(content).hexdigest() == expected_digest, "DH_DIGEST_MISMATCH")
    return content, decode_json(content, max_bytes=limit)


def _attributes(value, code):
    _check(isinstance(value, dict) and set(value).issubset(_ATTRIBUTES), code)
    for item in value.values():
        if item is not None:
            _text(item, code, empty=True)
    return value


def _turn(value, *, evidence=False, approved_at):
    code = "DH_PAYLOAD_INVALID" if evidence else "DH_SUPPLEMENT_INVALID"
    keys = {"turn_id", "occurrence_id"} if evidence else {"id"}
    _shape(value, keys | {"session_ref", "text", "created_at", "extractor", "data_origin"}, code)
    for field in keys | {"text", "extractor"}:
        _text(value[field], code)
    _digest(value["session_ref"], code)
    _origin(value["data_origin"], code)
    stamp = _time(value["created_at"], code)
    _check(stamp <= approved_at, "DH_WINDOW_INVALID")
    return stamp


def _validate_payload(payload):
    code = "DH_PAYLOAD_INVALID"
    _shape(payload, {"schema_version", "handoff_id", "revision", "source_agent", "target_agent",
                     "data_origin", "approved_at", "review_note", "demand", "evidence"}, code)
    _check(payload["schema_version"] == "1.4", "DH_SCHEMA_UNSUPPORTED")
    _check(payload["source_agent"] == "outfit" and payload["target_agent"] == "product", code)
    _text(payload["handoff_id"], code)
    _check(payload["handoff_id"].startswith("DH-") and len(payload["handoff_id"]) > 3, code)
    _integer(payload["revision"], code)
    _text(payload["review_note"], code)
    _origin(payload["data_origin"], code)
    approved = _time(payload["approved_at"], code)
    demand = _shape(payload["demand"], {"group_key", "title", "description", "attributes", "occurrences",
                                       "session_count", "window_days", "material", "craft", "knowledge_status"}, code)
    for key in ("group_key", "title", "description"):
        _text(demand[key], code)
    _attributes(demand["attributes"], code)
    _integer(demand["occurrences"], code)
    _integer(demand["session_count"], code)
    _check(type(demand["window_days"]) is int and demand["window_days"] in (0, 7), code)
    _check(demand["material"] is None and demand["craft"] is None
           and demand["knowledge_status"] == "pending_database", code)
    evidence = payload["evidence"]
    _check(isinstance(evidence, list) and len(evidence) == demand["occurrences"], code)
    seen, sessions, origins, turns = set(), set(), set(), {}
    for item in evidence:
        _turn(item, evidence=True, approved_at=approved)
        _check(item["occurrence_id"] not in seen, code)
        seen.add(item["occurrence_id"])
        sessions.add(item["session_ref"])
        origins.add(item["data_origin"])
        projected = {"id": item["turn_id"], **{key: item[key] for key in
                     ("session_ref", "text", "created_at", "extractor", "data_origin")}}
        _check(item["turn_id"] not in turns or turns[item["turn_id"]] == projected, code)
        turns[item["turn_id"]] = projected
    _check(len(sessions) == demand["session_count"], code)
    expected_origin = next(iter(origins)) if len(origins) == 1 else "mixed_demo"
    _check(payload["data_origin"] == expected_origin, code)
    return approved, turns


def _refs(value, code):
    _check(isinstance(value, list), code)
    for ref in value:
        _text(ref, code)
    _check(len(value) == len(set(value)), code)
    return set(value)


def _provenance(value):
    code = "DH_SUPPLEMENT_INVALID"
    _shape(value, {"normalizer_version", "context_turn_ids", "field_sources"}, code)
    _text(value["normalizer_version"], code)
    refs = _refs(value["context_turn_ids"], code)
    fields = value["field_sources"]
    _check(isinstance(fields, dict) and set(fields).issubset(_ATTRIBUTES), code)
    for field_refs in fields.values():
        refs |= _refs(field_refs, code)
    return refs


def _occurrence(value, turn_id):
    code = "DH_SUPPLEMENT_INVALID"
    _shape(value, {"id", "turn_id", "group_key", "title", "description", "attributes", "review_state",
                   "reason", "revision", "lifecycle", "normalizer_version", "context_turn_ids", "field_sources"}, code)
    for key in ("id", "turn_id", "group_key", "title", "description", "review_state", "lifecycle"):
        _text(value[key], code)
    _text(value["reason"], code, empty=True)
    _integer(value["revision"], code)
    _attributes(value["attributes"], code)
    _check(value["turn_id"] == turn_id, "DH_SOURCE_REFERENCE_INVALID")
    _check(value["review_state"] in {"pending", "approved", "rejected"}, code)
    _check(value["lifecycle"] in {"active", "excluded", "retracted"}, code)
    _provenance({key: value[key] for key in ("normalizer_version", "context_turn_ids", "field_sources")})


def _validate_supplement(supplement, payload, payload_digest, principal, approved, evidence_turns):
    code = "DH_SUPPLEMENT_INVALID"
    binding = "DH_PROVENANCE_BINDING_MISMATCH"
    _shape(supplement, {"supplement_schema", "handoff_id", "revision", "payload_digest", "approved_at",
                        "approved_by", "window_start", "window_end", "evidence_revisions", "evidence_digest",
                        "evidence_digest_version", "source_snapshot", "provenance", "source_proof"}, code)
    _check(supplement["supplement_schema"] == "pa-frozen-evidence/1", "DH_SCHEMA_UNSUPPORTED")
    _integer(supplement["revision"], code)
    _check(supplement["handoff_id"] == payload["handoff_id"] and supplement["revision"] == payload["revision"]
           and supplement["payload_digest"] == payload_digest
           and supplement["approved_at"] == payload["approved_at"], binding)
    _text(supplement["approved_by"], code)
    _digest(supplement["evidence_digest"], code)
    _text(supplement["evidence_digest_version"], code)
    _check(supplement["evidence_digest_version"] in {"target-evidence-v1", "resolved-sources-v1"}, code)
    proof = _shape(supplement["source_proof"], {"kind", "metadata_digest", "exported_by"}, code)
    _digest(proof["metadata_digest"], code)
    _check(proof["kind"] == "approved_metadata_projection" and proof["exported_by"] == principal, binding)
    revisions = supplement["evidence_revisions"]
    targets = {item["occurrence_id"]: item for item in payload["evidence"]}
    _check(isinstance(revisions, dict) and set(revisions) == set(targets), binding)
    for revision in revisions.values():
        _integer(revision, code)
    start = None if supplement["window_start"] is None else _time(supplement["window_start"], "DH_WINDOW_INVALID", utc=True)
    end = _time(supplement["window_end"], "DH_WINDOW_INVALID", utc=True)
    _check(end <= approved and (start is None or start < end), "DH_WINDOW_INVALID")
    _check(payload["demand"]["window_days"] == 0 or start is not None, "DH_WINDOW_INVALID")
    for item in payload["evidence"]:
        stamp = _time(item["created_at"], "DH_WINDOW_INVALID")
        _check((start is None or stamp >= start) and stamp < end, "DH_WINDOW_INVALID")
    warnings = set()
    if (payload["demand"]["window_days"] == 7 and end - start != timedelta(days=7)) or (
            payload["demand"]["window_days"] == 0 and start is not None):
        warnings.add("custom_frozen_window")
    provenance = supplement["provenance"]
    _check(isinstance(provenance, dict) and set(provenance).issubset(targets), binding)
    for value in provenance.values():
        _provenance(value)
    snapshots = supplement["source_snapshot"]
    _check(isinstance(snapshots, list), code)
    _check(not snapshots or supplement["evidence_digest_version"] == "resolved-sources-v1", binding)
    turns, source_occurrences, seen_turns, seen_occurrences = dict(evidence_turns), {}, set(), set()
    for snapshot in snapshots:
        _shape(snapshot, {"turn", "occurrences"}, code)
        turn = snapshot["turn"]
        _turn(turn, approved_at=approved)
        turn_id = turn["id"]
        _check(turn_id not in seen_turns, code)
        seen_turns.add(turn_id)
        _check(turn_id not in turns or turns[turn_id] == turn, binding)
        turns[turn_id] = turn
        items = snapshot["occurrences"]
        _check(isinstance(items, list), code)
        source_occurrences[turn_id] = items
        for occurrence in items:
            _occurrence(occurrence, turn_id)
            _check(occurrence["id"] not in seen_occurrences, code)
            seen_occurrences.add(occurrence["id"])
            if occurrence["id"] in targets:
                original = targets[occurrence["id"]]
                _check(original["turn_id"] == turn_id and revisions[occurrence["id"]] == occurrence["revision"], binding)

    def inspect_refs(value, target_turn, attributes):
        refs = _provenance({key: value[key] for key in ("normalizer_version", "context_turn_ids", "field_sources")})
        fields = value["field_sources"]
        if any(item is not None and not fields.get(key) for key, item in attributes.items()):
            warnings.add("field_provenance_missing")
        external_fields = {ref for field_refs in fields.values() for ref in field_refs if ref != target_turn["id"]}
        if external_fields != set(value["context_turn_ids"]):
            warnings.add("source_context_incomplete")
        for ref in refs:
            # A target evidence turn can also be a cross-turn source. Its
            # evidence text does not replace the frozen source appearances.
            if ref != target_turn["id"] and ref not in source_occurrences:
                warnings.add("source_snapshot_missing")
            source_turn = turns.get(ref)
            if source_turn is None:
                warnings.add("source_reference_missing")
                continue
            _check(source_turn["session_ref"] == target_turn["session_ref"]
                   and _time(source_turn["created_at"], code) <= _time(target_turn["created_at"], code),
                   "DH_SOURCE_REFERENCE_INVALID")
            if ref in source_occurrences:
                occurrences = source_occurrences[ref]
                if not occurrences:
                    warnings.add("source_occurrences_missing")
                if any(item["lifecycle"] != "active" or item["review_state"] == "rejected" for item in occurrences):
                    warnings.add("source_inactive")

    for occurrence_id, item in targets.items():
        if occurrence_id not in provenance:
            warnings.add("provenance_missing")
        else:
            inspect_refs(provenance[occurrence_id], turns[item["turn_id"]], payload["demand"]["attributes"])
    for turn_id, occurrences in source_occurrences.items():
        for occurrence in occurrences:
            inspect_refs(occurrence, turns[turn_id], occurrence["attributes"])
    incomplete = bool(warnings - {"custom_frozen_window"})
    return "incomplete" if incomplete else "available", sorted(warnings)


def validate_payload(payload: dict):
    """Transport-independent DH validation; returns approval time and turn map."""
    return _validate_payload(payload)


def decode_frozen_content(encoded: str, expected_digest: str, *, max_bytes: int, code="DH_PAYLOAD_INVALID"):
    """Validate base64/hash and return the original bytes plus strict JSON."""
    return _decode_content(encoded, expected_digest, max_bytes, code)


def validate_frozen_evidence(content: dict, *, payload: dict, payload_digest: str, source_principal: str):
    """Transport-independent frozen projection checks; never prove approval."""
    approved, evidence_turns = _validate_payload(payload)
    return _validate_supplement(content, payload, payload_digest, source_principal, approved, evidence_turns)

