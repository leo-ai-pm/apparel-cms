"""Synthetic frozen evidence tests; no original DB, network, model or Git writes."""
import copy
import hashlib
import json

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.models.chat import Base
from app.models.demand import DemandHandoff
from app.models.styling_direct import StylingApprovalFact, StylingEvidenceExport
from app.services import styling_evidence as se


ADMIN = {"subject": "synthetic-manager-a", "scope": "synthetic-scope-a",
         "source_instance_id": "synthetic-styling-a", "auth_method": "password_single_account",
         "approval_identity_kind": "account_bound"}
ATTRS = {"season": "秋", "scene": "通勤", "category": "裤子", "fit": "宽松", "silhouette": "阔腿"}


def sha(value):
    return hashlib.sha256(value.encode()).hexdigest()


def objects(*, external=False):
    payload = {"schema_version": "1.4", "handoff_id": "DH-synthetic-evidence", "revision": 1,
        "source_agent": "outfit", "target_agent": "product", "data_origin": "synthetic",
        "approved_at": "2026-10-10T00:00:01Z", "review_note": "合成人工核对，预算800元，不要紧身",
        "demand": {"group_key": "group-synthetic", "title": "秋季通勤宽松阔腿裤",
            "description": "预算800元内，SKU M1V2-P-B101，要求宽松，不要紧身",
            "attributes": dict(ATTRS), "occurrences": 1, "session_count": 1, "window_days": 7,
            "material": None, "craft": None, "knowledge_status": "pending_database"},
        "evidence": [{"occurrence_id": "o-target", "turn_id": "t-target", "session_ref": sha("synthetic-session"),
            "text": "秋天通勤想要宽松阔腿裤，不要紧身，预算800元，SKU M1V2-P-B101",
            "created_at": "2026-10-09T20:00:00Z", "extractor": "rules-v4", "data_origin": "synthetic"}]}
    metadata = {"window_start": "2026-10-03T00:00:00Z", "window_end": "2026-10-10T00:00:00Z",
        "approved_by": ADMIN["subject"], "approved_at": payload["approved_at"],
        "evidence_revisions": {"o-target": 1}, "evidence_digest": "a" * 64,
        "evidence_digest_version": "target-evidence-v1", "source_snapshot": [],
        "provenance": {"o-target": {"normalizer_version": "rules-v4", "context_turn_ids": [],
                                     "field_sources": {field: ["t-target"] for field in ATTRS}}}}
    if external:
        metadata["evidence_digest_version"] = "resolved-sources-v1"
        metadata["provenance"]["o-target"]["context_turn_ids"] = ["t-source"]
        metadata["provenance"]["o-target"]["field_sources"]["season"] = ["t-source"]
        metadata["source_snapshot"] = [{"turn": {"id": "t-source", "session_id": "synthetic-session",
            "text": "秋天通勤想要裤子，预算800元，不要紧身，SKU M1V2-P-B101",
            "created_at": "2026-10-01T10:00:00Z", "extractor": "rules-v4", "data_origin": "synthetic",
            "status": "extracted", "error_code": "", "extraction_attempts": 1,
            "negative_preferences": [{"private-value": "身高170厘米"}]},
            "occurrences": [{"id": "o-source", "turn_id": "t-source", "group_key": "group-source",
                "title": "秋季通勤宽松阔腿裤", "description": "预算800元，不要紧身，SKU M1V2-P-B101",
                "attributes": dict(ATTRS), "review_state": "pending", "reason": "", "revision": 2,
                "lifecycle": "active", "normalizer_version": "rules-v4", "context_turn_ids": [],
                "field_sources": {field: ["t-source"] for field in ATTRS}}]}]
    return payload, metadata


@pytest.fixture
def db():
    engine = create_engine("sqlite://")
    Base.metadata.create_all(engine)
    with sessionmaker(bind=engine, autoflush=False)() as value:
        yield value
    engine.dispose()


def freeze(db, payload=None, metadata=None, *, external=False, bound=True):
    base_payload, base_metadata = objects(external=external)
    payload = payload if payload is not None else base_payload
    metadata = metadata if metadata is not None else base_metadata
    raw = json.dumps(payload, ensure_ascii=False, indent=2)
    metadata = copy.deepcopy(metadata)
    metadata["payload_digest"] = sha(raw)
    row = DemandHandoff(id=payload["handoff_id"], group_key="group-synthetic", version=payload["revision"],
        fingerprint="f" * 64, payload_json=raw, metadata_json=json.dumps(metadata, ensure_ascii=False, indent=3), status="approved")
    db.add(row)
    fact = se.record_approval(db, row, ADMIN) if bound else None
    db.commit()
    return row, fact


def error(code, call, status=422):
    with pytest.raises(se.StylingEvidenceError) as caught:
        call()
    assert (caught.value.status, caught.value.code) == (status, code)
    assert "synthetic-session" not in caught.value.message
    return caught.value


def test_original_bytes_and_digests_untouched_and_export_stable(db):
    row, fact = freeze(db, external=True)
    before = (row.payload_json, row.metadata_json, row.status, fact.payload_digest, fact.metadata_digest)
    result = se.export_evidence(db, row.id, ADMIN)
    db.commit()
    data = json.loads(result.content_json)
    assert result.digest == sha(result.content_json)
    assert data["source_proof"]["metadata_digest"] == sha(row.metadata_json)
    assert data["evidence_digest"] == "a" * 64
    assert data["approved_by"] == ADMIN["subject"]
    assert data["source_proof"]["exported_by"] == "styling-frozen-export:synthetic-styling-a"
    assert data["source_snapshot"][0]["turn"]["session_ref"] == json.loads(row.payload_json)["evidence"][0]["session_ref"]
    assert "session_id" not in result.content_json
    assert "synthetic-session" not in result.content_json
    assert "negative_preferences" not in result.content_json
    assert "M1V2-P-B101" in result.content_json and "不要紧身" in result.content_json and "800元" in result.content_json
    alternate = {**ADMIN, "subject": "synthetic-manager-b"}
    again = se.export_evidence(db, row.id, alternate)
    assert (again.supplement_id, again.content_json) == (result.supplement_id, result.content_json)
    assert before == (row.payload_json, row.metadata_json, row.status, fact.payload_digest, fact.metadata_digest)


def test_explicit_export_subject_preserves_original_and_registered_bytes(db, monkeypatch):
    row, fact = freeze(db)
    original = (row.payload_json, row.metadata_json, fact.subject)
    monkeypatch.setenv('STYLING_DIRECT_EXPORT_SUBJECT', 'outfit-sender-isolated')
    exported = se.export_evidence(db, row.id, ADMIN)
    db.commit()
    assert json.loads(exported.content_json)['source_proof']['exported_by'] == 'outfit-sender-isolated'
    assert (row.payload_json, row.metadata_json, fact.subject) == original
    frozen = (exported.content_json, exported.digest)
    monkeypatch.setenv('STYLING_DIRECT_EXPORT_SUBJECT', 'another-registered-subject')
    error('EVIDENCE_EXPORT_CONFLICT', lambda: se.get_registered_export(db, row.id, ADMIN), 409)
    assert (exported.content_json, exported.digest) == frozen


def test_export_subject_configuration_cannot_inject_path(db, monkeypatch):
    row, _ = freeze(db)
    monkeypatch.setenv('STYLING_DIRECT_EXPORT_SUBJECT', '/Users/private-secret')
    error('EVIDENCE_EXPORT_CONFIGURATION_INVALID', lambda: se.export_evidence(db, row.id, ADMIN), 503)
    assert db.query(StylingEvidenceExport).count() == 0


def test_export_persists_after_database_reopen(tmp_path):
    engine = create_engine(f"sqlite:///{tmp_path}/synthetic.db")
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, autoflush=False)
    with factory() as db:
        row, _ = freeze(db)
        result = se.export_evidence(db, row.id, ADMIN)
        db.commit()
        expected = (result.supplement_id, result.content_json, result.digest)
    engine.dispose()
    with factory() as db:
        result = se.get_registered_export(db, "DH-synthetic-evidence", ADMIN)
        assert (result.supplement_id, result.content_json, result.digest) == expected


@pytest.mark.parametrize("value", ["身高170厘米", "一米七", "体重六十公斤", "120斤", "我穿38码",
    "鞋码三十八", "常穿M码", "身高1.7m", "一百七十公分", "60kg"])
def test_original_payload_private_text_blocks_without_changes(db, value):
    payload, metadata = objects()
    payload["evidence"][0]["text"] += "，" + value
    row, _ = freeze(db, payload, metadata)
    before = (row.payload_json, row.metadata_json)
    error("EVIDENCE_PRIVACY_BLOCKED", lambda: se.export_evidence(db, row.id, ADMIN))
    error("EVIDENCE_PRIVACY_BLOCKED", lambda: se.load_frozen_approval(db, row.id, ADMIN))
    assert (row.payload_json, row.metadata_json) == before
    assert db.query(StylingEvidenceExport).count() == 0


@pytest.mark.parametrize("field", ["title", "description", "review_note", "attributes"])
def test_original_payload_all_free_text_leaves_block(db, field):
    payload, metadata = objects()
    if field == "review_note":
        payload[field] += "，体重60kg"
    elif field == "attributes":
        payload["demand"][field]["fit"] = "宽松，身高170厘米"
    else:
        payload["demand"][field] += "，体重60kg"
    row, _ = freeze(db, payload, metadata)
    error("EVIDENCE_PRIVACY_BLOCKED", lambda: se.export_evidence(db, row.id, ADMIN))


@pytest.mark.parametrize("value", ["身高一百七十厘米，体重六十公斤", "一米七，120斤", "我穿38码，常穿M码"])
def test_external_projection_removes_body_values_only(db, value):
    payload, metadata = objects(external=True)
    source = metadata["source_snapshot"][0]
    source["turn"]["text"] += "，" + value
    for field in ("title", "description", "reason"):
        source["occurrences"][0][field] += value
    source["occurrences"][0]["attributes"]["fit"] += "，" + value
    row, _ = freeze(db, payload, metadata)
    original = row.metadata_json
    result = se.export_evidence(db, row.id, ADMIN)
    assert value not in result.content_json
    assert "[资料已移除]" in result.content_json
    assert "不要紧身" in result.content_json and "M1V2-P-B101" in result.content_json
    assert row.metadata_json == original


@pytest.mark.parametrize("value", ["电话：13800138000", "邮箱：somebody@example.test", "我叫张三",
    "Cookie: fake-cookie", "Bearer synthetic-secret", "api_key=synthetic-secret", "/Users/test/private.db", "C:\\private\\db"])
def test_identity_auth_path_in_allowed_projection_text_is_blocked(db, value):
    payload, metadata = objects(external=True)
    metadata["source_snapshot"][0]["occurrences"][0]["reason"] = value
    row, _ = freeze(db, payload, metadata)
    caught = error("EVIDENCE_PRIVACY_BLOCKED", lambda: se.export_evidence(db, row.id, ADMIN))
    assert value not in caught.message


def test_legacy_record_cannot_be_backfilled(db):
    row, _ = freeze(db, bound=False)
    error("APPROVAL_IDENTITY_LEGACY", lambda: se.record_approval(db, row, ADMIN))
    error("APPROVAL_IDENTITY_LEGACY", lambda: se.export_evidence(db, row.id, ADMIN))
    assert db.query(StylingApprovalFact).count() == 0
    assert row.status == "approved"


@pytest.mark.parametrize("change", ["scope", "source_instance_id"])
def test_other_scope_or_instance_cannot_read(db, change):
    row, _ = freeze(db)
    error("EVIDENCE_FORBIDDEN", lambda: se.export_evidence(db, row.id, {**ADMIN, change: "other"}), 403)


def test_consumer_and_legacy_principals_cannot_export(db):
    row, _ = freeze(db)
    error("EVIDENCE_FORBIDDEN", lambda: se.export_evidence(db, row.id, {**ADMIN, "approval_identity_kind": "legacy_shared_role"}), 403)
    error("EVIDENCE_FORBIDDEN", lambda: se.export_evidence(db, row.id, {"scope": ADMIN["scope"]}), 403)


@pytest.mark.parametrize("change", ["payload", "metadata", "approved_by", "approved_at"])
def test_frozen_fact_detects_tampering(db, change):
    row, fact = freeze(db)
    if change == "payload":
        row.payload_json += " "
    elif change == "metadata":
        row.metadata_json += " "
    elif change == "approved_by":
        fact.subject = "forged-manager"
    else:
        fact.approved_at = "2026-10-11T00:00:01Z"
    db.commit()
    error("APPROVAL_BINDING_CONFLICT", lambda: se.export_evidence(db, row.id, ADMIN), 409)


@pytest.mark.parametrize("status", ["approved", "sending", "received", "failed"])
def test_transport_state_does_not_erase_frozen_approval(db, status):
    row, _ = freeze(db)
    row.status = status
    db.commit()
    assert se.export_evidence(db, row.id, ADMIN).handoff_id == row.id


@pytest.mark.parametrize("change", ["revision", "missing_provenance", "missing_field", "missing_source", "other_session", "source_after_target", "target_at_end", "inactive", "unknown_nested", "source_turn_missing", "non_utc_window"])
def test_frozen_reference_window_revision_and_structure_gates(db, change):
    payload, metadata = objects(external=True)
    source = metadata["source_snapshot"][0]
    if change == "revision":
        metadata["evidence_revisions"] = {}
    elif change == "missing_provenance":
        metadata["provenance"] = {}
    elif change == "missing_field":
        del metadata["provenance"]["o-target"]["field_sources"]["fit"]
    elif change == "missing_source":
        metadata["source_snapshot"] = []
    elif change == "other_session":
        source["turn"]["session_id"] = "other-session"
    elif change == "source_after_target":
        source["turn"]["created_at"] = "2026-10-09T22:00:00Z"
    elif change == "target_at_end":
        payload["evidence"][0]["created_at"] = metadata["window_end"]
    elif change == "inactive":
        source["occurrences"][0]["lifecycle"] = "excluded"
    elif change == "unknown_nested":
        source["occurrences"][0]["attributes"]["body"] = {"weight": 60}
    elif change == "source_turn_missing":
        del source["turn"]["created_at"]
    elif change == "non_utc_window":
        metadata["window_start"] = "2026-10-03T08:00:00+08:00"
    row, _ = freeze(db, payload, metadata)
    error("EVIDENCE_INCOMPLETE", lambda: se.export_evidence(db, row.id, ADMIN))
    assert db.query(StylingEvidenceExport).count() == 0


@pytest.mark.parametrize("days,start", [(7, "2026-10-03T00:00:00Z"), (0, None), (7, "2026-10-09T00:00:00Z")])
def test_default_accumulated_and_custom_frozen_windows_are_preserved(db, days, start):
    payload, metadata = objects()
    payload["demand"]["window_days"] = days
    metadata["window_start"] = start
    row, _ = freeze(db, payload, metadata)
    data = json.loads(se.export_evidence(db, row.id, ADMIN).content_json)
    assert data["window_start"] == start and data["window_end"] == metadata["window_end"]
    assert "custom_frozen_window" not in data  # receiver derives the warning; no invented protocol key


def test_existing_export_tamper_cannot_be_overwritten(db):
    row, _ = freeze(db)
    result = se.export_evidence(db, row.id, ADMIN)
    db.commit()
    result.content_json += " "
    db.commit()
    before = result.content_json
    error("EVIDENCE_EXPORT_CONFLICT", lambda: se.export_evidence(db, row.id, ADMIN), 409)
    assert result.content_json == before


def test_rule_upgrade_adds_independent_record_without_overwrite(db, monkeypatch):
    row, _ = freeze(db)
    old = se.export_evidence(db, row.id, ADMIN)
    db.commit()
    preserved = (old.supplement_id, old.content_json, old.rule_version)
    monkeypatch.setattr(se, "RULE_VERSION", "synthetic-future-v2")
    new = se.export_evidence(db, row.id, ADMIN)
    db.commit()
    assert old.supplement_id != new.supplement_id
    assert (old.supplement_id, old.content_json, old.rule_version) == preserved
    assert db.query(StylingEvidenceExport).count() == 2


def test_verifier_read_uses_original_approved_subject_without_new_projection(db):
    row, fact = freeze(db)
    verifier = {"scope": ADMIN["scope"], "source_instance_id": ADMIN["source_instance_id"], "subject": "product-verifier"}
    assert se.load_frozen_approval(db, row.id, verifier)[0].subject == fact.subject
    error("EVIDENCE_EXPORT_NOT_FOUND", lambda: se.get_registered_export(db, row.id, verifier), 404)
    assert db.query(StylingEvidenceExport).count() == 0


def test_raw_session_id_in_original_dh_blocks_even_without_supplement(db):
    payload, metadata = objects(external=True)
    payload["evidence"][0]["text"] += " synthetic-session"
    row, _ = freeze(db, payload, metadata)
    error("EVIDENCE_PRIVACY_BLOCKED", lambda: se.load_frozen_approval(db, row.id, ADMIN))


def test_live_rows_never_used_and_frozen_exclusion_is_not_replaced(db):
    row, _ = freeze(db, external=True)
    # No DemandTurn/Occurrence exists at all; frozen sources remain sufficient.
    result = json.loads(se.export_evidence(db, row.id, ADMIN).content_json)
    assert result["source_snapshot"][0]["occurrences"][0]["review_state"] == "pending"
    assert result["source_snapshot"][0]["occurrences"][0]["revision"] == 2


@pytest.mark.parametrize("bad", ["duplicate", "nan"])
def test_ambiguous_json_is_rejected_before_approval_fact(db, bad):
    payload, metadata = objects()
    row = DemandHandoff(id=payload["handoff_id"], group_key="group-synthetic", version=1, fingerprint="f" * 64,
        payload_json='{"handoff_id":"DH-x","handoff_id":"DH-y"}' if bad == "duplicate" else '{"value":NaN}',
        metadata_json=json.dumps(metadata), status="approved")
    db.add(row)
    error("EVIDENCE_INCOMPLETE", lambda: se.record_approval(db, row, ADMIN))
    assert not any(isinstance(value, StylingApprovalFact) for value in db.new)


@pytest.mark.parametrize("field", ["payload_origin", "source_origin", "source_review", "digest_version", "empty_sources"])
def test_malformed_json_types_or_empty_source_status_are_safe_errors(db, field):
    payload, metadata = objects(external=True)
    if field == "payload_origin":
        payload["evidence"][0]["data_origin"] = []
    elif field == "source_origin":
        metadata["source_snapshot"][0]["turn"]["data_origin"] = {}
    elif field == "source_review":
        metadata["source_snapshot"][0]["occurrences"][0]["review_state"] = []
    elif field == "digest_version":
        metadata["evidence_digest_version"] = []
    else:
        metadata["source_snapshot"][0]["occurrences"] = []
    row, _ = freeze(db, payload, metadata)
    error("EVIDENCE_INCOMPLETE", lambda: se.export_evidence(db, row.id, ADMIN))


def test_actual_producer_approval_and_export_use_matching_shape(client, monkeypatch):
    from app.core.database import SessionLocal
    from app.services.demand import record_turn
    import uuid
    monkeypatch.setenv("STYLING_ADMIN_ENABLED", "1")
    monkeypatch.setenv("STYLING_ADMIN_PASSWORD", "synthetic-producer-password")
    monkeypatch.setenv("STYLING_ADMIN_SECRET", "synthetic-producer-signing-secret" * 2)
    monkeypatch.setenv("STYLING_ADMIN_SUBJECT", ADMIN["subject"])
    monkeypatch.setenv("STYLING_ADMIN_SCOPE", ADMIN["scope"])
    monkeypatch.setenv("STYLING_DIRECT_INSTANCE_ID", ADMIN["source_instance_id"])
    monkeypatch.setenv("STYLING_ADMIN_COOKIE_SECURE", "0")
    session_id = "synthetic-producer-" + uuid.uuid4().hex
    assert record_turn(session_id, uuid.uuid4().hex, "秋天通勤想要裤子")
    assert record_turn(session_id, uuid.uuid4().hex, "再宽松一点，阔腿的")
    assert client.post("/api/v1/admin/login", json={"password": "synthetic-producer-password"}).status_code == 200
    from app.models.demand import DemandOccurrence, DemandTurn
    with SessionLocal() as production_db:
        row = production_db.query(DemandOccurrence).join(DemandTurn, DemandOccurrence.turn_id == DemandTurn.id).filter(
            DemandTurn.session_id == session_id, DemandOccurrence.title.like("%阔腿%")).one()
        key = row.group_key
    preview_response = client.get(f"/api/v1/admin/groups/{key}/approval-set")
    assert preview_response.status_code == 200
    preview = preview_response.json()
    approved = client.post(f"/api/v1/admin/groups/{key}/approve", json={
        "note": "合成批准真实生产者冻结形状核对", "days": preview["days"],
        "window_start": preview["window_start"], "window_end": preview["window_end"],
        "expected_occurrence_ids": preview["expected_occurrence_ids"], "expected_revisions": preview["expected_revisions"],
        "expected_evidence_digest": preview["evidence_digest"]})
    assert approved.status_code == 200, approved.text
    with SessionLocal() as production_db:
        exported = se.export_evidence(production_db, approved.json()["id"], ADMIN)
        production_db.commit()
        value = json.loads(exported.content_json)
        assert value["approved_by"] == ADMIN["subject"]
        assert value["source_snapshot"]
        assert value["evidence_digest"] == preview["evidence_digest"]
        assert "session_id" not in exported.content_json and session_id not in exported.content_json


def test_new_unapproved_object_cannot_create_approval_fact(db):
    payload, metadata = objects()
    raw = json.dumps(payload)
    metadata["payload_digest"] = sha(raw)
    row = DemandHandoff(id=payload["handoff_id"], group_key="group-synthetic", version=1, fingerprint="f" * 64,
        payload_json=raw, metadata_json=json.dumps(metadata), status="draft")
    db.add(row)
    error("APPROVAL_BINDING_CONFLICT", lambda: se.record_approval(db, row, ADMIN), 409)
    assert not any(isinstance(value, StylingApprovalFact) for value in db.new)


def test_same_transaction_export_does_not_duplicate_pending_record(db):
    row, _ = freeze(db)
    first = se.export_evidence(db, row.id, ADMIN)
    assert se.export_evidence(db, row.id, ADMIN) is first
    db.commit()
    assert db.query(StylingEvidenceExport).count() == 1
