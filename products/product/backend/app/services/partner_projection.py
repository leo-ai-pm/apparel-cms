"""Freeze one signal per approved DH collection in the intake transaction."""
import base64
import hashlib
import json

from ..schemas.dh import decode_json
from ..core.errors import AppError


def encoded(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")


def signal_identity(source, scope, handoff, revision):
    return "SIG-DH-" + hashlib.sha256(encoded([source, scope, handoff, revision])).hexdigest()


def make_projection(sender, delivery, proof, receipt):
    payload = delivery.payload
    demand = payload["demand"]
    signal_id = signal_identity(sender.source_instance_id, sender.scope, payload["handoff_id"], payload["revision"])
    supplement = decode_json(delivery.supplement_bytes) if delivery.supplement_bytes is not None else None
    provenance = supplement["provenance"] if supplement else {}
    revisions = supplement["evidence_revisions"] if supplement else {}
    def evidence_id(kind, original):
        return "EVD-" + hashlib.sha256(encoded([signal_id, kind, original])).hexdigest()
    turn_to_id = {}
    for item in payload["evidence"]:
        turn_to_id.setdefault(item["turn_id"], evidence_id("target", item["occurrence_id"]))
    source_turns = {item["turn"]["id"]: item["turn"] for item in supplement["source_snapshot"]} if supplement else {}
    required_context = set()
    for item in payload["evidence"]:
        for field, refs in provenance.get(item["occurrence_id"], {}).get("field_sources", {}).items():
            if demand["attributes"].get(field) is not None:
                required_context.update(ref for ref in refs if ref not in turn_to_id and ref in source_turns)
    for ref in required_context:
        turn_to_id[ref] = evidence_id("context", ref)
    projection = []
    for item in payload["evidence"]:
        fields = provenance.get(item["occurrence_id"], {}).get("field_sources", {})
        projection.append({"evidence_id": evidence_id("target", item["occurrence_id"]),
                           "revision": revisions.get(item["occurrence_id"]), "text": item["text"],
                           "field_sources": {field: [turn_to_id[ref] for ref in refs if ref in turn_to_id]
                                             for field, refs in fields.items() if demand["attributes"].get(field) is not None},
                           "data_origin": item["data_origin"]})
    for ref in sorted(required_context):
        turn = source_turns[ref]
        fields = {field: [turn_to_id[ref]] for item in payload["evidence"]
                  for field, refs in provenance.get(item["occurrence_id"], {}).get("field_sources", {}).items()
                  if ref in refs and demand["attributes"].get(field) is not None}
        projection.append({"evidence_id": turn_to_id[ref], "revision": None, "text": turn["text"],
                           "field_sources": fields, "data_origin": turn["data_origin"]})
    projection_raw = encoded(projection)
    return {
        "schema_version": "pa-styling-signal/2", "signal_id": signal_id, "signal_revision": 1,
        "source_product": "personal_styling", "source_instance_id": sender.source_instance_id,
        "target_instance_id": sender.target_instance_id, "authorized_scope": sender.scope,
        "source_ref": {"handoff_id": payload["handoff_id"], "revision": payload["revision"],
                       "payload_digest": receipt["payload_digest"], "supplement_id": delivery.supplement_id,
                       "supplement_digest": delivery.supplement_digest, "metadata_digest": proof["metadata_digest"],
                       "direct_receive_id": receipt["direct_receive_id"],
                       "approval_record_id": receipt["source_approval_ref"]["approval_record_id"],
                       "verification_id": proof["verification_id"], "verified_at": proof["verified_at"]},
        "source_approval": {"subject": proof["approved_by"], "identity_kind": "account_bound", "approved_at": proof["approved_at"]},
        "data_origin": payload["data_origin"], "environment": "synthetic_local",
        "timestamp": proof["approved_at"], "timestamp_kind": "source_approved_at",
        "scene": demand["attributes"].get("scene"), "season": demand["attributes"].get("season"),
        "preference": demand["description"], "change_reason": None, "body_type_tag": None,
        "outfit_plan": {"items": [], "note": None}, "feedback_type": "demand_expression", "source_agent": "outfit",
        "demand": {key: demand[key] for key in ("title", "description", "attributes", "occurrences", "session_count",
                   "window_days", "material", "craft", "knowledge_status")}, "evidence_projection": projection,
        "provenance_status": "complete" if delivery.provenance_status == "available" else "incomplete",
        "mapping_version": "dh1.4-to-signal2/1",
        "projection_base64": base64.b64encode(projection_raw).decode(),
        "projection_digest": hashlib.sha256(projection_raw).hexdigest(),
    }


def save_projection(conn, sender, delivery, proof, receipt):
    signal = make_projection(sender, delivery, proof, receipt)
    raw = encoded(signal)
    if len(raw) > 16 * 1024 * 1024 - 4096:
        raise AppError("INPUT_TOO_LARGE", "冻结信号投影超过响应大小上限", 413)
    conn.execute("""INSERT INTO signals_v2(signal_id,scope,source_instance_id,target_instance_id,handoff_id,
        revision,direct_receive_id,content,digest) VALUES(?,?,?,?,?,?,?,?,?)""",
        (signal["signal_id"], sender.scope, sender.source_instance_id, sender.target_instance_id,
         delivery.payload["handoff_id"], delivery.payload["revision"], receipt["direct_receive_id"], raw,
         hashlib.sha256(raw).hexdigest()))
