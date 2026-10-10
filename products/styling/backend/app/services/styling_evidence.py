"""Frozen, account-bound source evidence. No live evidence or profile queries.

Callers own the transaction. Errors contain only fixed safe messages; neither
the original text nor the field value is interpolated into them.
"""
import hashlib
import json
import os
import re
import uuid
from datetime import datetime, timedelta, timezone

from app.models.demand import DemandHandoff
from app.models.styling_direct import StylingApprovalFact, StylingEvidenceExport


RULE_VERSION = "styling-frozen-redaction-v1"
_FIELDS = {"season", "scene", "category", "fit", "silhouette"}
_ORIGINS = {"synthetic", "runtime_demo", "mixed_demo"}
_SHA = re.compile(r"^[0-9a-f]{64}$")
_ID = re.compile(r"^[A-Za-z0-9_.:@-]{1,160}$")
_NUMBER = r"(?:\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百点]+)"
_BODY = [
    re.compile(rf"(?:身高|体重|净重|裸足身高)\s*[:：=为是]?\s*{_NUMBER}(?:\s*(?:厘米|公分|cm|米|m|公斤|千克|kg|斤))?(?:[零〇一二两三四五六七八九]+)?", re.I),
    re.compile(rf"{_NUMBER}\s*(?:厘米|公分|cm|公斤|千克|kg|斤)(?![A-Za-z])", re.I),
    re.compile(rf"{_NUMBER}\s*米(?:[零〇一二两三四五六七八九十]+|\d+)?"),
    re.compile(rf"\b\d+(?:\.\d+)?\s*m\b", re.I),
    re.compile(rf"(?:我的?|本人|平时|常|通常)?(?:上衣|下装|服装|衣服|鞋)?(?:常穿|穿|用|选|尺码是|尺码为|尺码|鞋码)\s*[:：=是为]?\s*(?:[SXLM]{{1,4}}|{_NUMBER})\s*(?:号|码|尺寸)?", re.I),
]
_UNSAFE = [
    re.compile(r"(?<![A-Za-z0-9])1[3-9]\d{9}(?![A-Za-z0-9])"),
    re.compile(r"(?<![A-Za-z0-9])(?:\d{17}[\dXx]|\d{15})(?![A-Za-z0-9])"),
    re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"),
    re.compile(r"(?:姓名|身份证|手机号|电话|地址|账号|帐号|微信|邮箱|联系方式|user_?id|account)\s*[:：=是为]\s*\S+|(?:我叫|本人姓名|我住在)\s*\S+", re.I),
    re.compile(r"(?:bearer\s+\S+|cookie\s*[:：=]|(?:api[_ -]?key|password|token|secret|session_id|owner_binding|ProfileUseSnapshot)\s*[:：=]|sk-[A-Za-z0-9]{6,})", re.I),
    re.compile(r"/(?:Users|home|private|tmp|var|etc|root|opt)/|[A-Za-z]:[\\/]", re.I),
]


class StylingEvidenceError(Exception):
    def __init__(self, status: int, code: str, message: str):
        self.status, self.code, self.message = status, code, message
        super().__init__(code)


def _fail(code="EVIDENCE_INCOMPLETE", status=422):
    messages = {
        "EVIDENCE_INCOMPLETE": "冻结出处、窗口或修订不完整，不能导出为已核验证据",
        "EVIDENCE_PRIVACY_BLOCKED": "冻结内容存在不允许传播的资料，本次导出已阻断，原件保持",
        "APPROVAL_IDENTITY_LEGACY": "历史批准缺少服务端账户绑定事实，不能自动补证",
        "APPROVAL_NOT_FOUND": "未找到该冻结批准记录",
        "APPROVAL_BINDING_CONFLICT": "冻结批准事实与原件绑定不一致",
        "EVIDENCE_EXPORT_CONFLICT": "已登记投影与冻结原件或当前规则不一致",
        "EVIDENCE_EXPORT_NOT_FOUND": "该版本尚未登记独立冻结证据投影",
        "EVIDENCE_FORBIDDEN": "当前身份无权操作该授权范围的冻结证据",
    }
    raise StylingEvidenceError(status, code, messages[code])


def _hash(value):
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _export_subject(fact):
    # An explicit registered service subject applies only to new exports. It is
    # never written into an existing export or the original handoff bytes.
    value = os.getenv("STYLING_DIRECT_EXPORT_SUBJECT", "styling-frozen-export:" + fact.source_instance_id)
    if not _ID.fullmatch(value):
        raise StylingEvidenceError(503, "EVIDENCE_EXPORT_CONFIGURATION_INVALID", "冻结导出服务主体配置不可用")
    return value


def _principal(principal):
    keys = ("subject", "scope", "source_instance_id", "auth_method", "approval_identity_kind")
    return {key: principal.get(key) if isinstance(principal, dict) else getattr(principal, key, None)
            for key in keys}


def _account(principal):
    p = _principal(principal)
    if p["approval_identity_kind"] != "account_bound" or not all(
            isinstance(p[key], str) and _ID.fullmatch(p[key])
            for key in ("subject", "scope", "source_instance_id", "auth_method")):
        _fail("EVIDENCE_FORBIDDEN", 403)
    return p


def _object(raw, max_bytes):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                _fail()
            result[key] = value
        return result
    try:
        if not isinstance(raw, str) or len(raw.encode("utf-8")) > max_bytes:
            _fail()
        value = json.loads(raw, object_pairs_hook=pairs,
                           parse_constant=lambda _: _fail())
    except (ValueError, TypeError, UnicodeError, RecursionError):
        _fail()
    if not isinstance(value, dict):
        _fail()
    return value


def _string(value, *, empty=False, identifier=False):
    if not isinstance(value, str) or len(value) > 20000 or (not empty and not value.strip()):
        _fail()
    if identifier and not _ID.fullmatch(value):
        _fail()
    return value


def _integer(value):
    if type(value) is not int or not 1 <= value <= 2**63 - 1:
        _fail()
    return value


def _sha(value):
    if not isinstance(value, str) or not _SHA.fullmatch(value):
        _fail()
    return value


def _time(value, *, utc=False):
    try:
        result = datetime.fromisoformat(_string(value).replace("Z", "+00:00"))
    except ValueError:
        _fail()
    if result.tzinfo is None or (utc and result.utcoffset() != timedelta(0)):
        _fail()
    return result.astimezone(timezone.utc)


def _keys(value, allowed):
    if not isinstance(value, dict) or set(value) != set(allowed):
        _fail()


def _text(value, *, redact=False, empty=False, session_ids=()):
    value = _string(value, empty=empty)
    if any(pattern.search(value) for pattern in _UNSAFE) or any(
            session_id and session_id in value for session_id in session_ids):
        _fail("EVIDENCE_PRIVACY_BLOCKED")
    if not redact and any(pattern.search(value) for pattern in _BODY):
        _fail("EVIDENCE_PRIVACY_BLOCKED")
    if redact:
        for pattern in _BODY:
            value = pattern.sub("[资料已移除]", value)
        # A surviving explicit body-label indicates an ambiguous expression.
        if re.search(r"身高|体重|鞋码|我的尺码|本人尺码", value):
            _fail("EVIDENCE_PRIVACY_BLOCKED")
    return value


def _attributes(value, *, redact=False, session_ids=()):
    _keys(value, _FIELDS)
    return {field: None if item is None else _text(item, redact=redact, session_ids=session_ids)
            for field, item in value.items()}


def _payload(raw):
    value = _object(raw, 1024 * 1024)
    _keys(value, {"schema_version", "handoff_id", "revision", "source_agent", "target_agent",
                  "data_origin", "approved_at", "review_note", "demand", "evidence"})
    if (value["schema_version"] != "1.4" or value["source_agent"] != "outfit"
            or value["target_agent"] != "product" or not isinstance(value["data_origin"], str)
            or value["data_origin"] not in _ORIGINS):
        _fail()
    if not _string(value["handoff_id"], identifier=True).startswith("DH-"):
        _fail()
    _integer(value["revision"])
    _time(value["approved_at"])
    _text(value["review_note"])
    demand = value["demand"]
    _keys(demand, {"group_key", "title", "description", "attributes", "occurrences",
                   "session_count", "window_days", "material", "craft", "knowledge_status"})
    _string(demand["group_key"], identifier=True)
    _text(demand["title"])
    _text(demand["description"])
    _attributes(demand["attributes"])
    if (type(demand["window_days"]) is not int or demand["window_days"] not in (0, 7)
            or demand["material"] is not None or demand["craft"] is not None
            or demand["knowledge_status"] != "pending_database"):
        _fail()
    rows = value["evidence"]
    if not isinstance(rows, list) or not rows or len(rows) > 10000:
        _fail()
    occurrence_ids, session_refs, origins, turns = set(), set(), set(), {}
    for row in rows:
        _keys(row, {"occurrence_id", "turn_id", "session_ref", "text", "created_at", "extractor", "data_origin"})
        oid = _string(row["occurrence_id"], identifier=True)
        tid = _string(row["turn_id"], identifier=True)
        if oid in occurrence_ids or not isinstance(row["data_origin"], str) or row["data_origin"] not in _ORIGINS:
            _fail()
        occurrence_ids.add(oid)
        session_refs.add(_sha(row["session_ref"]))
        origins.add(row["data_origin"])
        _text(row["text"])
        _string(row["extractor"], identifier=True)
        _time(row["created_at"])
        turn = {key: row[key] for key in ("session_ref", "text", "created_at", "extractor", "data_origin")}
        if tid in turns and turns[tid] != turn:
            _fail()
        turns[tid] = turn
    if (_integer(demand["occurrences"]) != len(rows)
            or _integer(demand["session_count"]) != len(session_refs)
            or value["data_origin"] != (next(iter(origins)) if len(origins) == 1 else "mixed_demo")):
        _fail()
    return value


def record_approval(db, handoff, principal):
    """Insert once inside the original NEW approval transaction. Never backfill."""
    p = _account(principal)
    if handoff not in db.new:
        _fail("APPROVAL_IDENTITY_LEGACY")
    payload = _object(handoff.payload_json, 1024 * 1024)
    metadata = _object(handoff.metadata_json, 4 * 1024 * 1024)
    _integer(payload.get("revision"))
    if (handoff.status not in (None, "approved")
            or payload.get("handoff_id") != handoff.id or payload.get("revision") != handoff.version
            or metadata.get("approved_by") != p["subject"]
            or metadata.get("approved_at") != payload.get("approved_at")
            or metadata.get("payload_digest") != _hash(handoff.payload_json)):
        _fail("APPROVAL_BINDING_CONFLICT", 409)
    _time(payload.get("approved_at"))
    if not isinstance(payload.get("data_origin"), str) or payload["data_origin"] not in _ORIGINS:
        _fail()
    fact = StylingApprovalFact(approval_record_id="STAPR-" + uuid.uuid4().hex,
        handoff_id=handoff.id, revision=handoff.version, scope=p["scope"],
        source_instance_id=p["source_instance_id"], subject=p["subject"], auth_method=p["auth_method"],
        approved_at=payload["approved_at"], payload_digest=_hash(handoff.payload_json),
        metadata_digest=_hash(handoff.metadata_json), data_origin=payload["data_origin"])
    db.add(fact)
    return fact


def load_frozen_approval(db, handoff_id, principal):
    """Validate stored fact/DH without requiring or creating a supplement.

    The verifier caller supplies its trusted scope/instance, not an approver.
    Current transport state and current occurrence rows are deliberately absent.
    """
    p = _principal(principal)
    row = db.get(DemandHandoff, handoff_id)
    if row is None:
        _fail("APPROVAL_NOT_FOUND", 404)
    fact = db.query(StylingApprovalFact).filter_by(handoff_id=row.id, revision=row.version).first()
    if fact is None:
        _fail("APPROVAL_IDENTITY_LEGACY")
    if (fact.scope != p["scope"] or fact.source_instance_id != p["source_instance_id"]):
        _fail("EVIDENCE_FORBIDDEN", 403)
    if (fact.payload_digest != _hash(row.payload_json) or fact.metadata_digest != _hash(row.metadata_json)):
        _fail("APPROVAL_BINDING_CONFLICT", 409)
    payload = _payload(row.payload_json)
    metadata = _object(row.metadata_json, 4 * 1024 * 1024)
    if (payload["handoff_id"] != row.id or payload["revision"] != row.version
            or fact.approved_at != payload["approved_at"] or fact.data_origin != payload["data_origin"]
            or metadata.get("approved_at") != fact.approved_at
            or metadata.get("approved_by") != fact.subject
            or metadata.get("payload_digest") != fact.payload_digest):
        _fail("APPROVAL_BINDING_CONFLICT", 409)
    if not all(isinstance(getattr(fact, key), str) and _ID.fullmatch(getattr(fact, key))
               for key in ("subject", "auth_method")):
        _fail("APPROVAL_BINDING_CONFLICT", 409)
    sources = metadata.get("source_snapshot")
    session_ids = [source["turn"]["session_id"] for source in sources
                   if isinstance(source, dict) and isinstance(source.get("turn"), dict)
                   and isinstance(source["turn"].get("session_id"), str)] if isinstance(sources, list) else []
    for value in [payload["review_note"], payload["demand"]["title"], payload["demand"]["description"],
                  *[item["text"] for item in payload["evidence"]]]:
        _text(value, session_ids=session_ids)
    _attributes(payload["demand"]["attributes"], session_ids=session_ids)
    return fact, row, payload, metadata


def _provenance(value, *, session_ids=()):
    _keys(value, {"normalizer_version", "context_turn_ids", "field_sources"})
    result = {"normalizer_version": _string(value["normalizer_version"], identifier=True)}
    refs = value["context_turn_ids"]
    fields = value["field_sources"]
    if not isinstance(refs, list) or not isinstance(fields, dict) or not set(fields) <= _FIELDS:
        _fail()
    result["context_turn_ids"] = [_string(ref, identifier=True) for ref in refs]
    if len(set(result["context_turn_ids"])) != len(refs):
        _fail()
    result["field_sources"] = {}
    for field, values in fields.items():
        if not isinstance(values, list) or not values:
            _fail()
        result["field_sources"][field] = [_string(ref, identifier=True) for ref in values]
        if len(set(values)) != len(values):
            _fail()
    return result


def _projection(fact, payload, metadata):
    required = {"window_start", "window_end", "evidence_revisions", "evidence_digest",
                "evidence_digest_version", "source_snapshot", "provenance"}
    if not required <= set(metadata):
        _fail()
    end = _time(metadata["window_end"], utc=True)
    start = None if metadata["window_start"] is None else _time(metadata["window_start"], utc=True)
    if (start is not None and start >= end) or (start is None and payload["demand"]["window_days"] != 0):
        _fail()
    if end > _time(fact.approved_at):
        _fail()
    evidence = {item["occurrence_id"]: item for item in payload["evidence"]}
    revisions = metadata["evidence_revisions"]
    if not isinstance(revisions, dict) or set(revisions) != set(evidence):
        _fail()
    revisions = {key: _integer(value) for key, value in revisions.items()}
    _sha(metadata["evidence_digest"])
    if (not isinstance(metadata["evidence_digest_version"], str)
            or metadata["evidence_digest_version"] not in {"target-evidence-v1", "resolved-sources-v1"}):
        _fail()
    turns = {}
    for item in evidence.values():
        created = _time(item["created_at"])
        if created >= end or (start is not None and created < start):
            _fail()
        turns[item["turn_id"]] = {"id": item["turn_id"], **{key: item[key] for key in
            ("session_ref", "text", "created_at", "extractor", "data_origin")}}
    sources = metadata["source_snapshot"]
    if not isinstance(sources, list):
        _fail()
    session_ids = []
    for source in sources:
        if not isinstance(source, dict) or set(source) != {"turn", "occurrences"}:
            _fail()
        turn = source["turn"]
        if not isinstance(turn, dict) or "session_id" not in turn:
            _fail()
        session_ids.append(_string(turn["session_id"]))
    # Original DH is immutable: raw identities cannot be removed from it.
    for item in payload["evidence"]:
        _text(item["text"], session_ids=session_ids)
    _text(payload["review_note"], session_ids=session_ids)
    for field in ("title", "description"):
        _text(payload["demand"][field], session_ids=session_ids)
    _attributes(payload["demand"]["attributes"], session_ids=session_ids)
    projected, source_ids, occurrence_ids = [], set(), set()
    for source in sources:
        turn = source["turn"]
        required_turn = {"id", "session_id", "text", "created_at", "extractor", "data_origin"}
        allowed_turn = required_turn | {"status", "error_code", "extraction_attempts", "negative_preferences"}
        if not required_turn <= set(turn) or not set(turn) <= allowed_turn:
            _fail()
        tid = _string(turn["id"], identifier=True)
        if tid in source_ids or not isinstance(turn["data_origin"], str) or turn["data_origin"] not in _ORIGINS:
            _fail()
        source_ids.add(tid)
        clean_turn = {"id": tid, "session_ref": _hash(turn["session_id"]),
            "text": _text(turn["text"], redact=True, session_ids=session_ids),
            "created_at": turn["created_at"], "extractor": _string(turn["extractor"], identifier=True),
            "data_origin": turn["data_origin"]}
        _time(clean_turn["created_at"])
        if tid in turns and turns[tid] != clean_turn:
            _fail()
        turns[tid] = clean_turn
        appearances = source["occurrences"]
        if not isinstance(appearances, list) or not appearances:
            _fail()
        clean_occurrences = []
        for item in appearances:
            allowed = {"id", "turn_id", "group_key", "title", "description", "attributes", "review_state",
                       "reason", "revision", "lifecycle", "normalizer_version", "context_turn_ids", "field_sources"}
            _keys(item, allowed)
            oid = _string(item["id"], identifier=True)
            if oid in occurrence_ids or item["turn_id"] != tid:
                _fail()
            occurrence_ids.add(oid)
            if (item["lifecycle"] != "active" or not isinstance(item["review_state"], str)
                    or item["review_state"] not in {"pending", "approved"}):
                _fail()
            clean = {"id": oid, "turn_id": tid, "group_key": _string(item["group_key"], identifier=True),
                "title": _text(item["title"], redact=True, session_ids=session_ids),
                "description": _text(item["description"], redact=True, session_ids=session_ids),
                "attributes": _attributes(item["attributes"], redact=True, session_ids=session_ids),
                "review_state": item["review_state"], "reason": _text(item["reason"], redact=True, empty=True, session_ids=session_ids),
                "revision": _integer(item["revision"]), "lifecycle": item["lifecycle"],
                **_provenance({key: item[key] for key in ("normalizer_version", "context_turn_ids", "field_sources")})}
            if oid in evidence and (evidence[oid]["turn_id"] != tid or revisions[oid] != clean["revision"]):
                _fail()
            clean_occurrences.append(clean)
        projected.append({"turn": clean_turn, "occurrences": clean_occurrences})
    prov = metadata["provenance"]
    if not isinstance(prov, dict) or set(prov) != set(evidence):
        _fail()
    provenance = {oid: _provenance(value) for oid, value in prov.items()}

    def check_refs(value, target, attrs=None):
        refs = set(value["context_turn_ids"])
        for field_refs in value["field_sources"].values():
            refs.update(field_refs)
        if attrs is not None and any(item is not None and field not in value["field_sources"]
                                     for field, item in attrs.items()):
            _fail()
        for ref in refs:
            source_turn = turns.get(ref)
            if (source_turn is None or source_turn["session_ref"] != target["session_ref"]
                    or _time(source_turn["created_at"]) > _time(target["created_at"])
                    or (ref != target["id"] and ref not in source_ids)):
                _fail()
    for oid, value in provenance.items():
        check_refs(value, turns[evidence[oid]["turn_id"]], payload["demand"]["attributes"])
    for source in projected:
        for item in source["occurrences"]:
            check_refs(item, source["turn"], item["attributes"])
    if source_ids and metadata["evidence_digest_version"] != "resolved-sources-v1":
        _fail()
    result = {"supplement_schema": "pa-frozen-evidence/1", "handoff_id": fact.handoff_id,
        "revision": fact.revision, "payload_digest": fact.payload_digest,
        "approved_at": fact.approved_at, "approved_by": fact.subject,
        "window_start": metadata["window_start"], "window_end": metadata["window_end"],
        "evidence_revisions": revisions, "evidence_digest": metadata["evidence_digest"],
        "evidence_digest_version": metadata["evidence_digest_version"],
        "source_snapshot": projected, "provenance": provenance,
        "source_proof": {"kind": "approved_metadata_projection", "metadata_digest": fact.metadata_digest,
                         "exported_by": _export_subject(fact)}}
    def check_output(value):
        if isinstance(value, str):
            if any(session_id and session_id in value for session_id in session_ids):
                _fail("EVIDENCE_PRIVACY_BLOCKED")
        elif isinstance(value, dict):
            for key, child in value.items():
                check_output(key)
                check_output(child)
        elif isinstance(value, list):
            for child in value:
                check_output(child)
    check_output(result)
    return result


def _registered(db, fact, content):
    old = next((value for value in db.new if isinstance(value, StylingEvidenceExport)
                and value.handoff_id == fact.handoff_id and value.revision == fact.revision
                and value.rule_version == RULE_VERSION), None)
    if old is None:
        old = db.query(StylingEvidenceExport).filter_by(handoff_id=fact.handoff_id,
                revision=fact.revision, rule_version=RULE_VERSION).first()
    if old is not None and (old.content_json != content or old.digest != _hash(content)
            or old.approval_record_id != fact.approval_record_id or old.payload_digest != fact.payload_digest
            or old.metadata_digest != fact.metadata_digest or old.scope != fact.scope
            or old.source_instance_id != fact.source_instance_id
            or old.exported_by != _export_subject(fact)):
        _fail("EVIDENCE_EXPORT_CONFLICT", 409)
    return old


def export_evidence(db, handoff_id, principal):
    """Return/create immutable projection; caller commits. No refresh timestamps."""
    _account(principal)
    fact, _, payload, metadata = load_frozen_approval(db, handoff_id, principal)
    projection = _projection(fact, payload, metadata)
    content = json.dumps(projection, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    old = _registered(db, fact, content)
    if old is not None:
        return old
    result = StylingEvidenceExport(supplement_id="STSUP-" + uuid.uuid4().hex,
        handoff_id=fact.handoff_id, revision=fact.revision, approval_record_id=fact.approval_record_id,
        scope=fact.scope, source_instance_id=fact.source_instance_id,
        exported_by=projection["source_proof"]["exported_by"], payload_digest=fact.payload_digest,
        metadata_digest=fact.metadata_digest, content_json=content, digest=_hash(content), rule_version=RULE_VERSION)
    db.add(result)
    return result


def get_registered_export(db, handoff_id, principal):
    """Read only an existing exact projection; suitable for service verification."""
    fact, _, payload, metadata = load_frozen_approval(db, handoff_id, principal)
    projection = _projection(fact, payload, metadata)
    content = json.dumps(projection, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    result = _registered(db, fact, content)
    if result is None:
        _fail("EVIDENCE_EXPORT_NOT_FOUND", 404)
    return result
