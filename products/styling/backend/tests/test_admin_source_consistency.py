"""Resolved cross-group source checks use synthetic, temporary test data only."""
import json
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

import pytest

from app.api import admin
from app.core.database import SessionLocal
from app.main import app
from app.models.demand import (DemandAdminSession, DemandAudit, DemandHandoff, DemandOccurrence,
                               DemandOccurrenceRevision, DemandSendAttempt, DemandTurn)
from app.services.demand import record_turn
from fastapi.testclient import TestClient


@pytest.fixture(autouse=True)
def isolated_sources(monkeypatch):
    monkeypatch.setenv("STYLING_ADMIN_PASSWORD", "synthetic-source-review-password")
    monkeypatch.setenv("STYLING_ADMIN_SECRET", "synthetic-source-signing-secret-" * 3)
    monkeypatch.setenv("STYLING_ADMIN_COOKIE_SECURE", "0")
    monkeypatch.setenv("STYLING_DEMAND_D3_ENABLED", "0")
    monkeypatch.delenv("STYLING_DEMAND_RECEIVER_URL", raising=False)
    monkeypatch.delenv("STYLING_DEMAND_RECEIVER_KEY", raising=False)
    with SessionLocal() as db:
        for model in (DemandOccurrenceRevision, DemandSendAttempt, DemandOccurrence, DemandTurn,
                      DemandHandoff, DemandAudit, DemandAdminSession):
            db.query(model).delete()
        db.commit()
    admin._attempts.clear()


def login(client):
    response = client.post("/api/v1/admin/login", json={"password": "synthetic-source-review-password"})
    assert response.status_code == 200


def create_turn(text, *, session_id="synthetic-source-session"):
    request_id = uuid.uuid4().hex
    assert record_turn(session_id, request_id, text)
    with SessionLocal() as db:
        turn = db.query(DemandTurn).filter_by(request_id=request_id).one()
        occurrences = db.query(DemandOccurrence).filter_by(turn_id=turn.id).all()
        return turn.id, [(o.id, o.group_key) for o in occurrences]


def cross_group_pair(client):
    source_turn, source_rows = create_turn("秋天通勤想要裤子")
    target_turn, target_rows = create_turn("再宽松一点，阔腿的")
    assert len(source_rows) == len(target_rows) == 1
    source_id, source_key = source_rows[0]
    target_id, target_key = target_rows[0]
    assert source_key != target_key
    login(client)
    preview = client.get(f"/api/v1/admin/groups/{target_key}/approval-set").json()
    assert preview["active_count"] == 1
    return {"source_turn": source_turn, "source_id": source_id, "source_key": source_key,
            "target_turn": target_turn, "target_id": target_id, "target_key": target_key,
            "preview": preview}


def window(value):
    query = {"days": value["days"], "window_end": value["window_end"]}
    if value["window_start"] is not None:
        query["window_start"] = value["window_start"]
    return query


def approve(client, pair, preview=None, *, include_digest=True):
    value = preview or pair["preview"]
    body = {**window(value), "note": "人工核对合成跨轮原话和全部出处",
            "expected_occurrence_ids": value["expected_occurrence_ids"],
            "expected_revisions": value["expected_revisions"]}
    if include_digest:
        body["expected_evidence_digest"] = value["evidence_digest"]
    return client.post(f'/api/v1/admin/groups/{pair["target_key"]}/approve', json=body)


def refetch(client, pair):
    return client.get(f'/api/v1/admin/groups/{pair["target_key"]}/approval-set', params=window(pair["preview"]))


def assert_stale_source_rejected(client, pair):
    before = pair["preview"]
    response = refetch(client, pair)
    assert response.status_code == 200, response.text
    after = response.json()
    assert after["expected_occurrence_ids"] == before["expected_occurrence_ids"]
    assert after["expected_revisions"] == before["expected_revisions"]
    result = approve(client, pair)
    assert (after["evidence_digest"] != before["evidence_digest"], result.status_code) == (True, 409), {
        "digest_changed": after["evidence_digest"] != before["evidence_digest"],
        "old_A_status": result.status_code, "old_A_body": result.json()}
    assert after["evidence_digest_version"] == "resolved-sources-v1"
    assert after["source_snapshot"] != before["source_snapshot"]
    with SessionLocal() as db:
        assert db.query(DemandHandoff).count() == 0
        assert db.get(DemandOccurrence, pair["target_id"]).review_state == "pending"
        assert db.get(DemandOccurrence, pair["target_id"]).lifecycle == "active"
    return after


def test_public_cross_group_source_reject_invalidates_old_approval_basis(client):
    pair = cross_group_pair(client)
    result = client.post(f'/api/v1/admin/occurrences/{pair["source_id"]}/reject',
                        json={"note": "核对后排除合成源提炼", "expected_revision": 1})
    assert result.status_code == 200
    assert_stale_source_rejected(client, pair)


def test_maintenance_same_id_external_source_text_change_invalidates_old_approval_basis(client):
    pair = cross_group_pair(client)
    # There is no public original-text edit API. This represents maintenance
    # in the isolated synthetic test DB, not a user-facing edit feature.
    with SessionLocal() as db:
        db.get(DemandTurn, pair["source_turn"]).text = "夏天居家想要裙子（合成维护变更）"
        db.commit()
    assert_stale_source_rejected(client, pair)


@pytest.mark.parametrize("model,field,value", [
    (DemandTurn, "status", "needs_review"),
    (DemandTurn, "extractor", "synthetic-maintenance-v2"),
    (DemandTurn, "data_origin", "synthetic-maintenance-source"),
    (DemandOccurrence, "revision", 2),
    (DemandOccurrence, "lifecycle", "excluded"),
    (DemandOccurrence, "review_state", "rejected"),
    (DemandOccurrence, "title", "合成来源标题修正"),
    (DemandOccurrence, "description", "合成维护更新来源说明"),
    (DemandOccurrence, "normalizer_version", "synthetic-source-normalizer-v3"),
    (DemandOccurrence, "attributes_json", json.dumps({"season": "夏", "scene": "居家", "category": "裤子",
                                                     "fit": None, "silhouette": None}, ensure_ascii=False)),
])
def test_resolved_source_fact_or_appearance_change_invalidates_old_basis(client, model, field, value):
    pair = cross_group_pair(client)
    row_id = pair["source_turn"] if model is DemandTurn else pair["source_id"]
    with SessionLocal() as db:
        setattr(db.get(model, row_id), field, value)
        db.commit()
    assert_stale_source_rejected(client, pair)


def test_source_time_change_inside_valid_history_changes_basis(client):
    pair = cross_group_pair(client)
    with SessionLocal() as db:
        source = db.get(DemandTurn, pair["source_turn"])
        source.created_at -= timedelta(minutes=1)
        db.commit()
    assert_stale_source_rejected(client, pair)


@pytest.mark.parametrize("operation", ["add", "remove"])
def test_all_appearances_of_direct_source_turn_are_bound(client, operation):
    pair = cross_group_pair(client)
    with SessionLocal() as db:
        if operation == "remove":
            db.delete(db.get(DemandOccurrence, pair["source_id"]))
        else:
            db.add(DemandOccurrence(id="synthetic-extra-source-appearance", turn_id=pair["source_turn"],
                group_key="synthetic-unrelated-category-on-referenced-turn", title="合成第二品类",
                description="保护同一来源交流的完整出现集合，并非认定精确字段归因",
                attributes_json=json.dumps({"category": "鞋履"}, ensure_ascii=False)))
        db.commit()
    assert_stale_source_rejected(client, pair)


def test_referenced_source_provenance_content_change_is_bound(client):
    pair = cross_group_pair(client)
    with SessionLocal() as db:
        row = db.get(DemandOccurrence, pair["source_id"])
        fields = json.loads(row.field_sources_json)
        fields["season"] = [pair["source_turn"], pair["source_turn"]]
        row.field_sources_json = json.dumps(fields)
        db.commit()
    assert_stale_source_rejected(client, pair)


def test_unrelated_other_session_source_changes_do_not_affect_target_basis(client):
    pair = cross_group_pair(client)
    unrelated_turn, unrelated_rows = create_turn("夏天居家想要裙子", session_id="synthetic-other-session")
    with SessionLocal() as db:
        db.get(DemandTurn, unrelated_turn).text = "合成无关会话更新原话"
        db.get(DemandOccurrence, unrelated_rows[0][0]).revision += 1
        db.commit()
    after = refetch(client, pair)
    assert after.status_code == 200, after.text
    assert after.json() == pair["preview"]
    result = approve(client, pair)
    assert result.status_code == 200, result.text


def test_shared_external_source_deduplicated_and_frozen_locally(client):
    pair = cross_group_pair(client)
    _, repeated_rows = create_turn("再宽松一点，阔腿的")
    assert repeated_rows[0][1] == pair["target_key"]
    value = client.get(f'/api/v1/admin/groups/{pair["target_key"]}/approval-set').json()
    assert value["active_count"] == 2
    assert value["evidence_digest_version"] == "resolved-sources-v1"
    assert len(value["source_snapshot"]) == 1
    assert value["source_snapshot"][0]["turn"]["id"] == pair["source_turn"]
    assert [item["id"] for item in value["source_snapshot"][0]["occurrences"]] == [pair["source_id"]]
    result = approve(client, pair, value)
    assert result.status_code == 200, result.text
    detail = client.get(f'/api/v1/admin/handoffs/{result.json()["id"]}').json()
    assert detail["metadata"]["source_snapshot"] == value["source_snapshot"]
    assert detail["metadata"]["evidence_digest_version"] == value["evidence_digest_version"]
    assert detail["metadata"]["evidence_digest"] == value["evidence_digest"]
    assert detail["payload"]["schema_version"] == "1.4"
    assert "source_snapshot" not in detail["payload"]
    assert "evidence_digest_version" not in detail["payload"]
    assert len(detail["payload"]["evidence"]) == 2


def test_source_before_query_window_is_bound_without_entering_target_membership(client):
    pair = cross_group_pair(client)
    with SessionLocal() as db:
        db.get(DemandTurn, pair["source_turn"]).created_at -= timedelta(days=9)
        db.commit()
    value = client.get(f'/api/v1/admin/groups/{pair["target_key"]}/approval-set').json()
    assert value["active_count"] == 1
    assert len(value["source_snapshot"]) == 1
    assert value["source_snapshot"][0]["turn"]["created_at"] < value["window_start"]
    assert value["expected_occurrence_ids"] == [pair["target_id"]]
    result = approve(client, pair, value)
    assert result.status_code == 200, result.text
    assert result.json()["occurrences"] == 1


def test_external_source_approval_cannot_omit_reviewed_digest(client):
    pair = cross_group_pair(client)
    result = approve(client, pair, include_digest=False)
    assert result.status_code == 422, result.text
    with SessionLocal() as db:
        assert db.query(DemandHandoff).count() == 0
        assert db.get(DemandOccurrence, pair["target_id"]).review_state == "pending"


@pytest.mark.parametrize("invalid", ["missing", "future", "cross_session", "empty_text", "invalid_sources"])
def test_invalid_referenced_sources_block_preview_and_final_approval(client, invalid):
    pair = cross_group_pair(client)
    with SessionLocal() as db:
        source = db.get(DemandTurn, pair["source_turn"])
        target = db.get(DemandOccurrence, pair["target_id"])
        if invalid == "missing":
            db.delete(source)
        elif invalid == "future":
            source.created_at = db.get(DemandTurn, pair["target_turn"]).created_at + timedelta(seconds=1)
        elif invalid == "cross_session":
            source.session_id = "synthetic-other-session"
        elif invalid == "empty_text":
            source.text = ""
        else:
            target.field_sources_json = json.dumps({"season": "wrong-shape"})
        db.commit()
    response = refetch(client, pair)
    assert response.status_code == 409, response.text
    result = approve(client, pair)
    assert result.status_code == 409, result.text
    with SessionLocal() as db:
        assert db.query(DemandHandoff).count() == 0


def test_no_external_source_retains_legacy_request_compatibility(client):
    _, target_rows = create_turn("秋天通勤想要宽松阔腿裤")
    login(client)
    target_id, key = target_rows[0]
    value = client.get(f"/api/v1/admin/groups/{key}/approval-set").json()
    result = client.post(f"/api/v1/admin/groups/{key}/approve", json={
        **window(value), "note": "无外部出处的旧客户端完整集合兼容",
        "expected_occurrence_ids": [target_id], "expected_revisions": {target_id: 1}})
    assert result.status_code == 200, result.text


def test_source_normal_approval_does_not_invalidate_target_fact_basis(client):
    pair = cross_group_pair(client)
    source_value = client.get(f'/api/v1/admin/groups/{pair["source_key"]}/approval-set').json()
    result = client.post(f'/api/v1/admin/groups/{pair["source_key"]}/approve', json={
        **window(source_value), "note": "只改变合成源审核进度",
        "expected_occurrence_ids": source_value["expected_occurrence_ids"],
        "expected_revisions": source_value["expected_revisions"],
        "expected_evidence_digest": source_value["evidence_digest"]})
    assert result.status_code == 200, result.text
    after = refetch(client, pair)
    assert after.status_code == 200, after.text
    assert after.json()["evidence_digest"] == pair["preview"]["evidence_digest"]
    result = approve(client, pair)
    assert result.status_code == 200, result.text
    repeat = approve(client, pair)
    assert repeat.status_code == 200 and repeat.json()["id"] == result.json()["id"]


def test_same_group_source_normal_approval_and_repeat_are_idempotent(client):
    source_turn, source_rows = create_turn("秋天通勤想要宽松阔腿裤")
    _, target_rows = create_turn("再宽松一点，阔腿的")
    assert source_rows[0][1] == target_rows[0][1]
    login(client)
    key = target_rows[0][1]
    value = client.get(f"/api/v1/admin/groups/{key}/approval-set").json()
    assert value["active_count"] == 2
    pair = {"target_key": key, "preview": value}
    first = approve(client, pair)
    assert first.status_code == 200, first.text
    after = client.get(f"/api/v1/admin/groups/{key}/approval-set", params=window(value)).json()
    assert after["evidence_digest"] == value["evidence_digest"]
    second = approve(client, pair)
    assert second.status_code == 200 and second.json()["id"] == first.json()["id"]
    with SessionLocal() as db:
        assert db.query(DemandHandoff).count() == 1


def test_two_requests_source_commit_first_then_old_approval_conflicts(client):
    pair = cross_group_pair(client)
    with TestClient(app) as reject_client:
        login(reject_client)
        committed = threading.Event()
        def reject_source():
            result = reject_client.post(f'/api/v1/admin/occurrences/{pair["source_id"]}/reject',
                json={"note": "有序合成并发源先提交", "expected_revision": 1})
            committed.set()
            return result
        def approve_after_commit():
            assert committed.wait(3), "synthetic source request did not finish"
            return approve(client, pair)
        with ThreadPoolExecutor(max_workers=2) as pool:
            rejected = pool.submit(reject_source)
            approved = pool.submit(approve_after_commit)
            assert rejected.result(timeout=6).status_code == 200
            assert approved.result(timeout=6).status_code == 409
    with SessionLocal() as db:
        assert db.query(DemandHandoff).count() == 0
        assert db.get(DemandOccurrence, pair["target_id"]).review_state == "pending"


def test_sqlite_approval_write_lock_first_freezes_source_before_concurrent_reject(client, monkeypatch):
    pair = cross_group_pair(client)
    approval_locked = threading.Event()
    source_waiting = threading.Event()
    order_lock = threading.Lock()
    write_order = []
    real_begin = admin._begin_write
    def ordered_begin(db):
        # The source request below is dispatched only after the first approval
        # write reservation. HTTP endpoints run in AnyIO worker threads, so
        # order the actual server writes rather than caller thread identities.
        with order_lock:
            write_index = len(write_order)
            write_order.append(write_index)
        if write_index == 1:
            source_waiting.set()
        real_begin(db)
        if write_index == 0:
            approval_locked.set()
            assert source_waiting.wait(3), "synthetic source did not attempt its competing write"
    monkeypatch.setattr(admin, "_begin_write", ordered_begin)
    with TestClient(app) as reject_client:
        login(reject_client)
        def approve_first():
            return approve(client, pair)
        def reject_second():
            assert approval_locked.wait(3), "synthetic approval did not reserve the SQLite write"
            return reject_client.post(f'/api/v1/admin/occurrences/{pair["source_id"]}/reject',
                json={"note": "有序合成并发源后排除", "expected_revision": 1})
        with ThreadPoolExecutor(max_workers=2) as pool:
            approved_future = pool.submit(approve_first)
            rejected_future = pool.submit(reject_second)
            approved = approved_future.result(timeout=6)
            rejected = rejected_future.result(timeout=6)
        assert approved.status_code == 200, approved.text
        assert rejected.status_code == 200, rejected.text
    with SessionLocal() as db:
        handoff = db.get(DemandHandoff, approved.json()["id"])
        frozen = json.loads(handoff.metadata_json)
        assert frozen["evidence_digest"] == pair["preview"]["evidence_digest"]
        assert frozen["source_snapshot"] == pair["preview"]["source_snapshot"]
        source = db.get(DemandOccurrence, pair["source_id"])
        target = db.get(DemandOccurrence, pair["target_id"])
        assert source.revision == 2 and source.lifecycle == "excluded"
        assert target.review_state == "approved" and target.lifecycle == "active"
        # This is ordering plus an immutable snapshot, not D3 propagation.
        assert db.query(DemandHandoff).count() == 1


def legacy_external_source_pair(client):
    pair = cross_group_pair(client)
    with SessionLocal() as db:
        source = db.get(DemandOccurrence, pair["source_id"])
        source.normalizer_version = "rules-v1"
        source.field_sources_json = "{}"
        source.context_turn_ids_json = "[]"
        db.commit()
    response = client.get(f'/api/v1/admin/groups/{pair["target_key"]}/approval-set')
    assert response.status_code == 200, response.text
    pair["preview"] = response.json()
    return pair


def test_valid_legacy_external_source_empty_provenance_stays_compatible(client):
    pair = legacy_external_source_pair(client)
    snapshot = pair["preview"]["source_snapshot"]
    assert snapshot[0]["occurrences"][0]["normalizer_version"] == "rules-v1"
    assert snapshot[0]["occurrences"][0]["field_sources"] == {}
    assert snapshot[0]["occurrences"][0]["context_turn_ids"] == []
    result = approve(client, pair)
    assert result.status_code == 200, result.text


@pytest.mark.parametrize("field,invalid", [
    ("attributes_json", "{"),
    ("attributes_json", "[]"),
    ("attributes_json", "null"),
    ("field_sources_json", "{"),
    ("field_sources_json", "[]"),
    ("field_sources_json", json.dumps({"season": "not-a-list"})),
    ("field_sources_json", json.dumps({"unknown-field": ["synthetic-source-ref"]})),
    ("context_turn_ids_json", "{"),
    ("context_turn_ids_json", "{}"),
    ("context_turn_ids_json", "[12]"),
])
def test_external_legacy_source_corrupt_json_cannot_be_coerced_to_empty_provenance(client, field, invalid):
    pair = legacy_external_source_pair(client)
    with SessionLocal() as db:
        setattr(db.get(DemandOccurrence, pair["source_id"]), field, invalid)
        db.commit()
    preview_result = refetch(client, pair)
    approved = approve(client, pair)
    assert (preview_result.status_code, approved.status_code) == (409, 409), {
        "field": field, "invalid": invalid, "preview": preview_result.json(),
        "old_A_approval_status": approved.status_code, "old_A_approval": approved.json()}
    with SessionLocal() as db:
        assert db.query(DemandHandoff).count() == 0
        assert db.get(DemandOccurrence, pair["target_id"]).review_state == "pending"
