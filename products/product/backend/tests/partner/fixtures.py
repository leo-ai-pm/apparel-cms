"""Synthetic frozen DH fixtures; never actual styling or business approval evidence."""
import base64
import hashlib
import json


def raw_json(value, *, indent=None):
    return json.dumps(value, ensure_ascii=False, indent=indent, allow_nan=False).encode("utf-8")


def sha256(value):
    return hashlib.sha256(value).hexdigest()


def make_payload(number=1):
    return {
        "schema_version": "1.4",
        "handoff_id": f"DH-synthetic-{number}",
        "revision": 1,
        "source_agent": "outfit",
        "target_agent": "product",
        "data_origin": "synthetic",
        "approved_at": "2026-10-01T10:00:00+00:00",
        "review_note": "仅用于隔离协议测试的合成批准说明",
        "demand": {
            "group_key": "synthetic-autumn-commute-top",
            "title": "合成秋季通勤上衣需求",
            "description": "合成输入：秋季通勤宽松上衣，非真实市场需求。",
            "attributes": {"season": "秋", "scene": "通勤", "category": "上衣", "fit": "宽松", "silhouette": None},
            "occurrences": 1,
            "session_count": 1,
            "window_days": 7,
            "material": None,
            "craft": None,
            "knowledge_status": "pending_database",
        },
        "evidence": [{
            "occurrence_id": f"occ-synthetic-{number}",
            "turn_id": f"turn-synthetic-{number}",
            "session_ref": sha256(f"synthetic-session-{number}".encode()),
            "text": "合成输入：想要秋季通勤的宽松上衣。",
            "created_at": "2026-09-30T08:00:00+00:00",
            "extractor": "synthetic-test",
            "data_origin": "synthetic",
        }],
    }


def make_supplement(payload, payload_bytes=None):
    payload_bytes = payload_bytes if payload_bytes is not None else raw_json(payload)
    evidence = payload["evidence"][0]
    turn_id = evidence["turn_id"]
    field_sources = {key: [turn_id] for key, value in payload["demand"]["attributes"].items() if value is not None}
    provenance = {"normalizer_version": "synthetic-v1", "context_turn_ids": [], "field_sources": field_sources}
    return {
        "supplement_schema": "pa-frozen-evidence/1",
        "handoff_id": payload["handoff_id"],
        "revision": payload["revision"],
        "payload_digest": sha256(payload_bytes),
        "approved_at": payload["approved_at"],
        "approved_by": "synthetic-manager",
        "window_start": "2026-09-24T10:00:00+00:00",
        "window_end": "2026-10-01T10:00:00+00:00",
        "evidence_revisions": {evidence["occurrence_id"]: 1},
        "evidence_digest": sha256(b"synthetic-frozen-metadata-evidence-not-market-fact"),
        "evidence_digest_version": "resolved-sources-v1",
        "source_snapshot": [{
            "turn": {"id": turn_id, **{key: evidence[key] for key in ("session_ref", "text", "created_at", "extractor", "data_origin")}},
            "occurrences": [{
                "id": evidence["occurrence_id"], "turn_id": turn_id,
                **{key: payload["demand"][key] for key in ("group_key", "title", "description", "attributes")},
                "review_state": "approved", "reason": "合成测试证据",
                "revision": 1, "lifecycle": "active", **provenance,
            }],
        }],
        "provenance": {evidence["occurrence_id"]: provenance},
        "source_proof": {
            "kind": "approved_metadata_projection",
            "metadata_digest": sha256(b"synthetic-original-metadata-bytes"),
            "exported_by": "synthetic-outfit",
        },
    }

