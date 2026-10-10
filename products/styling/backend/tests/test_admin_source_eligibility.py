"""Confirmed source pause policy, using temporary synthetic evidence only.

These are API/transaction checks. The optional send transport is a local mock;
it does not demonstrate receipt by a real partner.
"""
import hashlib
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta

import httpx
import pytest
from fastapi.testclient import TestClient

from app.api import admin
from app.core.database import SessionLocal
from app.main import app
from app.models.demand import (
    DemandAudit, DemandHandoff, DemandOccurrence, DemandOccurrenceRevision,
    DemandSendAttempt, DemandTurn,
)
from tests.test_admin_source_consistency import (
    approve, create_turn, cross_group_pair, isolated_sources, login, refetch, window,
)


POLICY = "pause-inactive-sources-v1"
PAUSE_MESSAGE = "引用来源含已排除或无效记录，相关新审批已暂停；重新核对不会解除，请等待人工复核。"


def reject_source(client, occurrence_id):
    result = client.post(f"/api/v1/admin/occurrences/{occurrence_id}/reject", json={
        "note": "人工复核后排除合成来源", "expected_revision": 1,
    })
    assert result.status_code == 200, result.text
    return result


def state_before_attempt(target_id):
    """Include the audit/revision tables, so a rejected approval cannot write."""
    with SessionLocal() as db:
        target = db.get(DemandOccurrence, target_id)
        return {
            "target": admin._occurrence(target),
            "handoffs": [(row.id, row.payload_json, row.metadata_json, row.status)
                         for row in db.query(DemandHandoff).order_by(DemandHandoff.id)],
            "audit_ids": [row.id for row in db.query(DemandAudit).order_by(DemandAudit.id)],
            "revision_ids": [row.id for row in db.query(DemandOccurrenceRevision).order_by(DemandOccurrenceRevision.id)],
            "attempt_ids": [row.id for row in db.query(DemandSendAttempt).order_by(DemandSendAttempt.id)],
        }


def assert_allowed(value):
    eligibility = value["approval_eligibility"]
    assert eligibility["policy"] == POLICY
    assert eligibility["eligible"] is True
    assert eligibility["reason_codes"] == []
    assert eligibility["blocked_sources"] == []
    return eligibility


def assert_blocked(value, pair, *, occurrence_id=None, revision=2,
                   review_state="rejected", lifecycle="excluded"):
    eligibility = value["approval_eligibility"]
    assert eligibility == {
        "policy": POLICY, "eligible": False,
        "reason_codes": ["source_inactive"],
        "blocked_sources": [{"turn_id": pair["source_turn"],
            "occurrence_id": occurrence_id or pair["source_id"], "revision": revision,
            "review_state": review_state, "lifecycle": lifecycle}],
        "message": PAUSE_MESSAGE,
    }
    return eligibility


def assert_fresh_approval_blocked(client, pair, preview):
    before = state_before_attempt(pair["target_id"])
    result = approve(client, pair, preview)
    assert result.status_code == 409, result.text
    body = result.json()
    assert body["error"] == {"code": "SOURCE_APPROVAL_BLOCKED", "message": PAUSE_MESSAGE}
    assert body["detail"] == PAUSE_MESSAGE
    assert body["approval_eligibility"] == preview["approval_eligibility"]
    assert state_before_attempt(pair["target_id"]) == before
    return result


def test_public_reject_keeps_old_basis_conflict_and_blocks_fresh_basis(client):
    pair = cross_group_pair(client)
    assert_allowed(pair["preview"])
    reject_source(client, pair["source_id"])
    before = state_before_attempt(pair["target_id"])
    stale = approve(client, pair)
    assert stale.status_code == 409, stale.text
    assert stale.json()["error"]["code"] == "CONFLICT"
    assert "approval_eligibility" not in stale.json()
    assert state_before_attempt(pair["target_id"]) == before

    fresh_result = refetch(client, pair)
    assert fresh_result.status_code == 200, fresh_result.text
    fresh = fresh_result.json()
    assert fresh["evidence_digest"] != pair["preview"]["evidence_digest"]
    assert fresh["expected_occurrence_ids"] == pair["preview"]["expected_occurrence_ids"]
    assert fresh["expected_revisions"] == pair["preview"]["expected_revisions"]
    assert_blocked(fresh, pair)
    assert_fresh_approval_blocked(client, pair, fresh)


def test_repeated_source_read_and_new_baseline_cannot_unlock_pause(client):
    pair = cross_group_pair(client)
    reject_source(client, pair["source_id"])
    for _ in range(3):
        source = client.get(f'/api/v1/admin/turns/{pair["source_turn"]}')
        assert source.status_code == 200, source.text
        assert source.json()["text"] == "秋天通勤想要裤子"
        fresh = refetch(client, pair).json()
        assert_blocked(fresh, pair)
        assert_fresh_approval_blocked(client, pair, fresh)


@pytest.mark.parametrize("review_state,lifecycle", [
    ("pending", "excluded"), ("approved", "retracted"),
    ("pending", "replaced"), ("rejected", "active"),
])
def test_any_inactive_or_rejected_source_appearance_pauses(client, review_state, lifecycle):
    pair = cross_group_pair(client)
    # Synthetic maintenance models non-public legacy states; this is not a
    # restoration or lifecycle-edit feature exposed to administrators.
    with SessionLocal() as db:
        source = db.get(DemandOccurrence, pair["source_id"])
        source.review_state, source.lifecycle = review_state, lifecycle
        source.revision = 2
        db.commit()
    result = refetch(client, pair)
    assert result.status_code == 200, result.text
    fresh = result.json()
    assert_blocked(fresh, pair, review_state=review_state, lifecycle=lifecycle)
    assert_fresh_approval_blocked(client, pair, fresh)


def test_source_outside_fixed_window_still_blocks_target(client):
    pair = cross_group_pair(client)
    with SessionLocal() as db:
        db.get(DemandTurn, pair["source_turn"]).created_at -= timedelta(days=9)
        db.commit()
    pair["preview"] = refetch(client, pair).json()
    assert pair["preview"]["source_snapshot"][0]["turn"]["created_at"] < pair["preview"]["window_start"]
    reject_source(client, pair["source_id"])
    fresh = refetch(client, pair).json()
    assert fresh["active_count"] == 1
    assert fresh["expected_occurrence_ids"] == [pair["target_id"]]
    assert_blocked(fresh, pair)
    assert_fresh_approval_blocked(client, pair, fresh)


def test_other_appearance_of_referenced_turn_conservatively_blocks(client):
    pair = cross_group_pair(client)
    extra_id = "synthetic-excluded-second-source-appearance"
    with SessionLocal() as db:
        db.add(DemandOccurrence(id=extra_id, turn_id=pair["source_turn"],
            group_key="synthetic-other-appearance-category", title="合成第二品类",
            description="同一原话内另一出现；保守检查，不推定逐字段唯一出处",
            attributes_json=json.dumps({"category": "鞋履"}, ensure_ascii=False)))
        db.commit()
    reject_source(client, extra_id)
    fresh = refetch(client, pair).json()
    assert len(fresh["source_snapshot"][0]["occurrences"]) == 2
    with SessionLocal() as db:
        assert db.get(DemandOccurrence, pair["source_id"]).lifecycle == "active"
    assert_blocked(fresh, pair, occurrence_id=extra_id)
    assert_fresh_approval_blocked(client, pair, fresh)


def test_excluded_same_group_source_blocks_remaining_target(client):
    source_turn, source_rows = create_turn("秋天通勤想要宽松阔腿裤")
    target_turn, target_rows = create_turn("再宽松一点，阔腿的")
    source_id, key = source_rows[0]
    target_id, target_key = target_rows[0]
    assert key == target_key
    login(client)
    pair = {"source_turn": source_turn, "source_id": source_id, "source_key": key,
            "target_turn": target_turn, "target_id": target_id, "target_key": key,
            "preview": client.get(f"/api/v1/admin/groups/{key}/approval-set").json()}
    assert pair["preview"]["active_count"] == 2
    reject_source(client, source_id)
    fresh = refetch(client, pair).json()
    assert fresh["active_count"] == 1
    assert fresh["expected_occurrence_ids"] == [target_id]
    assert_blocked(fresh, pair)
    assert_fresh_approval_blocked(client, pair, fresh)


@pytest.mark.parametrize("reference", ["context_only", "field_only"])
def test_either_provenance_reference_kind_is_enough_to_pause(client, reference):
    pair = cross_group_pair(client)
    with SessionLocal() as db:
        target = db.get(DemandOccurrence, pair["target_id"])
        if reference == "field_only":
            target.context_turn_ids_json = "[]"
        else:
            target.field_sources_json = json.dumps({field: [pair["target_turn"]]
                for field in json.loads(target.field_sources_json)})
        db.commit()
    reject_source(client, pair["source_id"])
    fresh = refetch(client, pair).json()
    assert_blocked(fresh, pair)
    assert_fresh_approval_blocked(client, pair, fresh)


@pytest.mark.parametrize("same_session", [True, False])
def test_unreferenced_rejected_source_does_not_pause_target(client, same_session):
    pair = cross_group_pair(client)
    _, rows = create_turn("夏天居家想要裙子", session_id=(
        "synthetic-source-session" if same_session else "synthetic-other-session"))
    reject_source(client, rows[0][0])
    fresh = refetch(client, pair).json()
    assert fresh == pair["preview"]
    assert_allowed(fresh)
    approved = approve(client, pair, fresh)
    assert approved.status_code == 200, approved.text


@pytest.mark.parametrize("approve_source_first", [False, True])
def test_active_source_normal_progress_and_approval_idempotence_remain(client, approve_source_first):
    pair = cross_group_pair(client)
    if approve_source_first:
        source_value = client.get(f'/api/v1/admin/groups/{pair["source_key"]}/approval-set').json()
        source_pair = {"target_key": pair["source_key"], "preview": source_value}
        source_result = approve(client, source_pair)
        assert source_result.status_code == 200, source_result.text
    fresh = refetch(client, pair).json()
    assert_allowed(fresh)
    assert fresh["evidence_digest"] == pair["preview"]["evidence_digest"]
    first = approve(client, pair, fresh)
    assert first.status_code == 200, first.text
    before = state_before_attempt(pair["target_id"])
    again = approve(client, pair, fresh)
    assert again.status_code == 200, again.text
    assert again.json()["id"] == first.json()["id"]
    assert state_before_attempt(pair["target_id"]) == before


def test_no_external_sources_retains_legacy_complete_set_approval(client):
    _, rows = create_turn("秋天通勤想要宽松阔腿裤")
    occurrence_id, key = rows[0]
    login(client)
    value = client.get(f"/api/v1/admin/groups/{key}/approval-set").json()
    assert value["source_snapshot"] == []
    assert_allowed(value)
    result = client.post(f"/api/v1/admin/groups/{key}/approve", json={
        **window(value), "note": "旧客户端无外部出处的完整核对",
        "expected_occurrence_ids": [occurrence_id], "expected_revisions": {occurrence_id: 1},
    })
    assert result.status_code == 200, result.text


@pytest.mark.parametrize("forged", [
    {"approval_eligibility": {"policy": POLICY, "eligible": True, "blocked_sources": []}},
    {"source_snapshot": [], "source_eligible": True, "override_source_pause": True},
])
def test_client_supplied_source_eligibility_cannot_override_database(client, forged):
    pair = cross_group_pair(client)
    reject_source(client, pair["source_id"])
    fresh = refetch(client, pair).json()
    before = state_before_attempt(pair["target_id"])
    result = client.post(f'/api/v1/admin/groups/{pair["target_key"]}/approve', json={
        **window(fresh), "note": "合成客户端伪造资格仍不得放行",
        "expected_occurrence_ids": fresh["expected_occurrence_ids"],
        "expected_revisions": fresh["expected_revisions"],
        "expected_evidence_digest": fresh["evidence_digest"], **forged,
    })
    assert result.status_code == 409, result.text
    assert result.json()["error"]["code"] == "SOURCE_APPROVAL_BLOCKED"
    assert result.json()["approval_eligibility"] == fresh["approval_eligibility"]
    assert state_before_attempt(pair["target_id"]) == before


def test_old_client_cannot_omit_digest_to_escape_source_pause(client):
    pair = cross_group_pair(client)
    reject_source(client, pair["source_id"])
    fresh = refetch(client, pair).json()
    before = state_before_attempt(pair["target_id"])
    result = approve(client, pair, fresh, include_digest=False)
    assert result.status_code == 422, result.text
    assert result.json()["error"]["code"] == "INVALID_REQUEST"
    assert state_before_attempt(pair["target_id"]) == before


def test_source_commits_first_then_fresh_concurrent_approval_still_paused(client):
    pair = cross_group_pair(client)
    committed = threading.Event()
    with TestClient(app) as rejecting_client:
        login(rejecting_client)

        def reject_first():
            result = reject_source(rejecting_client, pair["source_id"])
            committed.set()
            return result

        def read_and_approve_after_commit():
            assert committed.wait(3), "synthetic exclusion did not commit"
            fresh = refetch(client, pair).json()
            assert_blocked(fresh, pair)
            return assert_fresh_approval_blocked(client, pair, fresh)

        with ThreadPoolExecutor(max_workers=2) as pool:
            excluded = pool.submit(reject_first)
            approved = pool.submit(read_and_approve_after_commit)
            assert excluded.result(timeout=6).status_code == 200
            assert approved.result(timeout=6).json()["error"]["code"] == "SOURCE_APPROVAL_BLOCKED"


def test_existing_frozen_package_and_send_eligibility_do_not_gain_d3_propagation(client, monkeypatch):
    pair = cross_group_pair(client)
    approved = approve(client, pair)
    assert approved.status_code == 200, approved.text
    handoff_id = approved.json()["id"]
    before = state_before_attempt(pair["target_id"])
    frozen_payload, frozen_metadata = before["handoffs"][0][1:3]
    reject_source(client, pair["source_id"])

    fresh = refetch(client, pair).json()
    assert_blocked(fresh, pair)
    assert_fresh_approval_blocked(client, pair, fresh)
    detail = client.get(f"/api/v1/admin/handoffs/{handoff_id}").json()
    assert detail["status"] == "approved"
    assert detail["send_eligible"] is True and detail["needs_review"] is False
    assert detail["metadata"]["source_snapshot"] == pair["preview"]["source_snapshot"]
    assert detail["metadata"] == json.loads(frozen_metadata)
    assert state_before_attempt(pair["target_id"])["target"] == before["target"]
    monkeypatch.setenv("STYLING_DEMAND_RECEIVER_URL", "http://127.0.0.1:9/synthetic-receive")
    monkeypatch.setenv("STYLING_DEMAND_RECEIVER_KEY", "synthetic-test-transport-key")
    monkeypatch.setenv("STYLING_DEMAND_RECEIVER_RECEIPT_CAPABILITIES", "revision,payload_digest")
    captured = []

    def receive(request):
        raw = request.read()
        captured.append(raw)
        payload = json.loads(raw)
        return httpx.Response(200, json={"handoff_id": payload["handoff_id"],
            "revision": payload["revision"], "status": "received",
            "payload_digest": hashlib.sha256(raw).hexdigest()})

    # Only the transport is mocked; real httpx constructs the raw body. No
    # listener, network request, paid model call or real partner is involved.
    with httpx.Client(transport=httpx.MockTransport(receive)) as transport:
        monkeypatch.setattr(admin.httpx, "post", transport.post)
        sent = client.post(f"/api/v1/admin/handoffs/{handoff_id}/send")
    assert sent.status_code == 200, sent.text
    assert sent.json()["status"] == "received"
    assert captured == [frozen_payload.encode("utf-8")]
    with SessionLocal() as db:
        handoff = db.get(DemandHandoff, handoff_id)
        assert (handoff.payload_json, handoff.metadata_json) == (frozen_payload, frozen_metadata)
        assert db.query(DemandHandoff).count() == 1
        assert db.query(DemandAudit).filter_by(action="approve").count() == 1
        assert db.get(DemandOccurrence, pair["target_id"]).review_state == "approved"
        assert db.get(DemandOccurrence, pair["target_id"]).lifecycle == "active"
