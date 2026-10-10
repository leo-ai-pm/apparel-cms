"""S1 manager paging uses isolated synthetic evidence and makes no paid calls."""
import json
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import event

from app.api import admin
from app.core.database import SessionLocal, engine
from app.models.demand import (DemandAdminSession, DemandAudit, DemandHandoff, DemandOccurrence,
                               DemandOccurrenceRevision, DemandSendAttempt, DemandTurn)


NOW = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(minutes=1)


@pytest.fixture(autouse=True)
def isolated_paging(monkeypatch):
    monkeypatch.setenv("STYLING_ADMIN_PASSWORD", "synthetic-paging-password")
    monkeypatch.setenv("STYLING_ADMIN_SECRET", "synthetic-paging-signing-secret-" * 3)
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
    assert client.post("/api/v1/admin/login", json={"password": "synthetic-paging-password"}).status_code == 200


def seed(count, *, group_key="synthetic-group", prefix="synthetic", created_at=NOW,
         category="裤子", state="pending", lifecycle="active"):
    attributes = {"season": None, "scene": None, "category": category, "fit": None, "silhouette": None}
    with SessionLocal() as db:
        db.add_all([DemandTurn(id=f"{prefix}-turn-{i:05}", request_id=f"{prefix}-request-{i:05}",
            session_id=f"{prefix}-session-{i:05}", text=f"合成分页需求原话 {i}", status="extracted",
            data_origin="synthetic_demo", created_at=created_at) for i in range(count)])
        db.add_all([DemandOccurrence(id=f"{prefix}-occ-{i:05}", turn_id=f"{prefix}-turn-{i:05}",
            group_key=group_key, title="合成分页需求", description="仅验证系统查询",
            attributes_json=json.dumps(attributes, ensure_ascii=False), review_state=state,
            lifecycle=lifecycle, normalizer_version="rules-v1") for i in range(count)])
        db.commit()


def fixed_window(response, *, days=7):
    value = response.json()
    result = {"days": days, "window_end": value["window_end"]}
    if value["window_start"] is not None:
        result["window_start"] = value["window_start"]
    return result


def approval_body(value):
    result = {"note": "人工核对全部合成来源", "days": value["days"],
              "window_end": value["window_end"],
              "expected_occurrence_ids": value["expected_occurrence_ids"],
              "expected_revisions": value["expected_revisions"],
              "expected_evidence_digest": value["evidence_digest"]}
    if value["window_start"] is not None:
        result["window_start"] = value["window_start"]
    return result


def test_more_than_fifty_groups_have_complete_stable_pages(client):
    for i in range(61):
        seed(1, group_key=f"group-{i:02}", prefix=f"group-{i:02}")
    login(client)
    first = client.get("/api/v1/admin/overview?page_size=20")
    bounds = fixed_window(first)
    expected_counts = first.json()["counts"]
    keys = []
    for page in range(1, 5):
        response = client.get("/api/v1/admin/overview", params={**bounds, "page": page, "page_size": 20})
        assert response.status_code == 200, response.text
        value = response.json()
        assert value["groups_total"] == value["counts"]["groups"] == 61
        assert value["counts"] == expected_counts
        assert value["page"] == page and value["page_size"] == 20
        assert value["has_more"] == (page < 4)
        keys.extend(group["key"] for group in value["groups"])
    assert keys == [f"group-{i:02}" for i in range(61)]
    assert len(set(keys)) == 61
    empty = client.get("/api/v1/admin/overview", params={**bounds, "page": 5, "page_size": 20}).json()
    assert empty["groups"] == [] and empty["groups_total"] == 61 and not empty["has_more"]
    legacy = client.get("/api/v1/admin/overview").json()
    assert len(legacy["groups"]) == 50 and legacy["has_more"] and legacy["page"] == 1


def test_rank_order_count_then_latest_then_group_key(client):
    seed(2, group_key="a-count", prefix="count", created_at=NOW-timedelta(days=1))
    seed(1, group_key="z-recent", prefix="recent", created_at=NOW)
    seed(1, group_key="a-old", prefix="old", created_at=NOW-timedelta(hours=1))
    login(client)
    assert [g["key"] for g in client.get("/api/v1/admin/overview?page_size=1&page=1").json()["groups"]] == ["a-count"]
    assert [g["key"] for g in client.get("/api/v1/admin/overview?page_size=1&page=2").json()["groups"]] == ["z-recent"]
    assert [g["key"] for g in client.get("/api/v1/admin/overview?page_size=1&page=3").json()["groups"]] == ["a-old"]


@pytest.mark.parametrize("path", ["overview", "groups/synthetic-group"])
@pytest.mark.parametrize("query", ["page=0", "page=-1", "page_size=0", "page_size=101"])
def test_invalid_page_queries_are_rejected(client, path, query):
    login(client)
    assert client.get(f"/api/v1/admin/{path}?{query}").status_code == 422


def test_group_evidence_sql_pages_and_legacy_compatibility(client):
    seed(160)
    login(client)
    statements = []
    def capture(connection, cursor, statement, parameters, context, executemany):
        if "FROM demand_occurrences JOIN demand_turns" in statement and not statement.startswith("SELECT count"):
            statements.append((statement, parameters))
    event.listen(engine, "before_cursor_execute", capture)
    try:
        first = client.get("/api/v1/admin/groups/synthetic-group?page=1&page_size=20")
    finally:
        event.remove(engine, "before_cursor_execute", capture)
    assert first.status_code == 200, first.text
    assert any("LIMIT ? OFFSET ?" in sql and parameters[-2:] == (20, 0) for sql, parameters in statements)
    bounds = fixed_window(first)
    ids = []
    for page in range(1, 9):
        value = client.get("/api/v1/admin/groups/synthetic-group", params={**bounds, "page": page, "page_size": 20}).json()
        assert value["total"] == 160 and value["pagination_mode"] == "paged"
        assert value["page"] == page and value["has_more"] == (page < 8)
        assert len(value["evidence"]) == 20
        ids.extend(row["id"] for row in value["evidence"])
    assert len(set(ids)) == 160
    legacy = client.get("/api/v1/admin/groups/synthetic-group", params=bounds).json()
    assert legacy["pagination_mode"] == "legacy_full" and len(legacy["evidence"]) == legacy["total"] == 160
    assert legacy["page_size"] == 160 and not legacy["has_more"]
    page_only = client.get("/api/v1/admin/groups/synthetic-group", params={**bounds, "page": 4}).json()
    assert page_only["page_size"] == 50 and len(page_only["evidence"]) == 10
    size_only = client.get("/api/v1/admin/groups/synthetic-group", params={**bounds, "page_size": 30}).json()
    assert size_only["page"] == 1 and len(size_only["evidence"]) == 30


def test_filtered_pages_do_not_limit_complete_approval_set(client):
    seed(3, prefix="pending")
    seed(2, prefix="approved", state="approved")
    seed(1, prefix="excluded", state="rejected", lifecycle="excluded")
    login(client)
    page = client.get("/api/v1/admin/groups/synthetic-group?status=pending&page_size=2")
    bounds = fixed_window(page)
    assert page.json()["total"] == 3 and len(page.json()["evidence"]) == 2
    complete = client.get("/api/v1/admin/groups/synthetic-group/approval-set", params={**bounds, "status": "pending"})
    assert complete.status_code == 200, complete.text
    value = complete.json()
    assert value["active_count"] == len(value["expected_occurrence_ids"]) == len(value["expected_revisions"]) == 5
    assert len(value["evidence_digest"]) == 64
    body = approval_body(value)
    body["expected_occurrence_ids"] = [row["id"] for row in page.json()["evidence"]]
    body["expected_revisions"] = {row["id"]: row["revision"] for row in page.json()["evidence"]}
    assert client.post("/api/v1/admin/groups/synthetic-group/approve", json=body).status_code == 409
    response = client.post("/api/v1/admin/groups/synthetic-group/approve", json=approval_body(value))
    assert response.status_code == 200, response.text
    assert response.json()["occurrences"] == 5
    assert response.json()["metadata"]["evidence_digest"] == value["evidence_digest"]
    # Approval changes review_state without changing content digest or membership.
    after = client.get("/api/v1/admin/groups/synthetic-group/approval-set", params=bounds).json()
    assert after["evidence_digest"] == value["evidence_digest"]


def test_same_id_same_revision_content_change_conflicts_with_reviewed_digest(client):
    seed(2)
    login(client)
    value = client.get("/api/v1/admin/groups/synthetic-group/approval-set").json()
    with SessionLocal() as db:
        db.get(DemandTurn, "synthetic-turn-00000").text = "原ID原修订但原话内容已改变"
        db.commit()
    response = client.post("/api/v1/admin/groups/synthetic-group/approve", json=approval_body(value))
    assert response.status_code == 409 and "内容" in response.json()["detail"]
    with SessionLocal() as db:
        assert db.query(DemandHandoff).count() == 0


def test_revision_or_exclusion_conflicts_with_complete_membership(client):
    seed(2)
    login(client)
    value = client.get("/api/v1/admin/groups/synthetic-group/approval-set").json()
    response = client.post("/api/v1/admin/occurrences/synthetic-occ-00000/reject",
                           json={"note": "合成证据核对排除", "expected_revision": 1})
    assert response.status_code == 200
    assert client.post("/api/v1/admin/groups/synthetic-group/approve", json=approval_body(value)).status_code == 409
    after = client.get("/api/v1/admin/groups/synthetic-group/approval-set", params=fixed_window_value(value)).json()
    assert after["active_count"] == 1 and after["evidence_digest"] != value["evidence_digest"]


def fixed_window_value(value):
    params = {"days": value["days"], "window_end": value["window_end"]}
    if value["window_start"] is not None:
        params["window_start"] = value["window_start"]
    return params


@pytest.mark.parametrize("days", [0, 7])
def test_fixed_window_excludes_later_arrivals_and_preserves_cumulative_start(client, days):
    seed(2)
    seed(1, prefix="old", created_at=NOW-timedelta(days=9))
    login(client)
    value = client.get("/api/v1/admin/groups/synthetic-group/approval-set", params={"days": days}).json()
    assert value["active_count"] == (3 if days == 0 else 2)
    assert (value["window_start"] is None) == (days == 0)
    end = datetime.fromisoformat(value["window_end"].replace("Z", "+00:00")).replace(tzinfo=None)
    seed(1, prefix="future", created_at=end+timedelta(seconds=1))
    response = client.get("/api/v1/admin/groups/synthetic-group/approval-set", params=fixed_window_value(value))
    assert response.status_code == 200, response.text
    assert response.json() == value
    result = client.post("/api/v1/admin/groups/synthetic-group/approve", json=approval_body(value))
    assert result.status_code == 200, result.text
    assert result.json()["metadata"]["window_end"] == value["window_end"]


def test_new_evidence_inside_frozen_window_requires_new_review(client):
    seed(2)
    login(client)
    value = client.get("/api/v1/admin/groups/synthetic-group/approval-set").json()
    seed(1, prefix="late-import", created_at=NOW-timedelta(seconds=1))
    assert client.post("/api/v1/admin/groups/synthetic-group/approve", json=approval_body(value)).status_code == 409


def test_approval_set_never_silently_truncates_oversized_group(client):
    seed(10001)
    login(client)
    response = client.get("/api/v1/admin/groups/synthetic-group/approval-set?days=0")
    assert response.status_code == 409 and "10000" in response.json()["detail"]
    assert "不会截断" in response.json()["detail"]


def test_category_filter_is_sql_bounded_and_handles_damaged_legacy_json(client):
    seed(3, prefix="pants")
    seed(2, prefix="shoes", category="鞋履")
    with SessionLocal() as db:
        db.get(DemandOccurrence, "pants-occ-00000").attributes_json = "damaged synthetic JSON"
        db.commit()
    login(client)
    value = client.get("/api/v1/admin/groups/synthetic-group?category=裤子&page_size=1").json()
    assert value["total"] == 2 and len(value["evidence"]) == 1 and value["has_more"]
    overview = client.get("/api/v1/admin/overview?category=鞋履").json()
    assert overview["counts"]["occurrences"] == 2


def test_new_queries_keep_auth_scope_and_empty_window_semantics(client):
    seed(1)
    for path in ("overview?page=2", "groups/synthetic-group?page_size=1", "groups/synthetic-group/approval-set"):
        assert client.get(f"/api/v1/admin/{path}").status_code == 401
    login(client)
    for path in ("overview", "groups/synthetic-group", "groups/synthetic-group/approval-set"):
        assert client.get(f"/api/v1/admin/{path}?workspace_id=elsewhere").status_code == 403
    assert client.get("/api/v1/admin/groups/unknown/approval-set").status_code == 404
    bounds = {"window_start": "2020-01-01T00:00:00Z", "window_end": "2020-01-02T00:00:00Z"}
    page = client.get("/api/v1/admin/groups/synthetic-group", params={**bounds, "page_size": 1}).json()
    assert page["evidence"] == [] and page["total"] == 0
    complete = client.get("/api/v1/admin/groups/synthetic-group/approval-set", params=bounds).json()
    assert complete["active_count"] == 0 and complete["expected_occurrence_ids"] == []
